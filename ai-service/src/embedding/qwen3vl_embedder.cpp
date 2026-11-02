#include "embedding/qwen3vl_embedder.hpp"
#include "platform/bpu.hpp"
#include "platform/bpu_pack.hpp"
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <map>
#include <regex>
#include <stdexcept>
#include <thread>

namespace ainvr::embedding {
namespace {
using Clock = std::chrono::steady_clock;
double Ms(Clock::time_point a, Clock::time_point b) { return std::chrono::duration<double, std::milli>(b - a).count(); }

class Mapped {
 public:
  Mapped() = default;
  Mapped(const std::string& path, size_t expected) {
    const int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC);
    if (fd < 0) throw std::runtime_error("embedding_file_open");
    struct stat st{};
    if (fstat(fd, &st) || size_t(st.st_size) != expected) { close(fd); throw std::runtime_error("embedding_file_size"); }
    void* p = mmap(nullptr, expected, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);
    if (p == MAP_FAILED) throw std::runtime_error("embedding_file_map");
    data_ = p; size_ = expected;
  }
  Mapped(Mapped&& o) noexcept : data_(o.data_), size_(o.size_) { o.data_ = nullptr; }
  Mapped& operator=(Mapped&& o) noexcept { std::swap(data_, o.data_); std::swap(size_, o.size_); return *this; }
  ~Mapped() { if (data_) munmap(data_, size_); }
  const void* data() const { return data_; }
 private:
  void* data_ = nullptr; size_t size_ = 0;
};

std::vector<float> ReadFloats(const std::string& path, size_t count) {
  Mapped m(path, count * sizeof(float));
  std::vector<float> v(count);
  std::memcpy(v.data(), m.data(), count * sizeof(float));
  return v;
}

constexpr size_t kLayerKv = size_t(kKvHeads) * kCap * kHeadDim;   // floats per cache tensor

struct Slot {
  std::unique_ptr<BpuProgram> prog;
  int filled = 0;   // rows of the KV tail currently non-zero in this program's input buffers
};
struct Group {
  std::shared_ptr<BpuPack> pack;
  std::map<int, Slot> progs;   // profile rows -> program. v2 packages: {1, 256}; v3 packages: single-call profiles (e.g. {64, 416})
};

}  // namespace

struct Qwen3VlEmbedder::Impl {
  std::shared_ptr<BpuPack> vis_pack[4], head_pack;
  std::unique_ptr<BpuProgram> vis[4], head;
  Group txt[kGroups];
  Mapped embed_map;
  std::vector<float> rope_cos, rope_sin, prefix;
  std::mutex call_mutex;
  std::atomic<int> priority_waiting{0};
  double t_build = 0, t_set = 0, t_run = 0, t_get = 0; int n_calls = 0;   // per-Run profile (text groups), reset in Run

  template <class F>
  void Locked(bool priority, F&& f) {
    if (!priority)
      while (priority_waiting.load() > 0) std::this_thread::sleep_for(std::chrono::microseconds(300));
    std::lock_guard<std::mutex> lock(call_mutex);
    f();
  }

  const uint16_t* Embed() const { return static_cast<const uint16_t*>(embed_map.data()); }

  void RunVision(const float* chw, bool priority, std::vector<float>& image_hidden, std::vector<float> deep[kDeepStacks]) {
    std::vector<float> h(size_t(kPatches) * kPatchDim);
    PatchifyChw(chw, h.data());
    for (int g = 0; g < 4; ++g) {
      auto& prog = *vis[g];
      std::vector<float> next;
      Locked(priority, [&] {
        prog.SetInput(0, h.data());
        prog.SetInput(1, rope_cos.data());
        prog.SetInput(2, rope_sin.data());
        prog.Run();
        const size_t outputs = prog.Outputs().size();
        if (g < 3) {
          if (outputs != 2) throw std::runtime_error("embedding_vision_contract");
          next.resize(size_t(kPatches) * 1024);
          prog.GetOutput(0, next.data());
          deep[g].resize(size_t(kImageTokens) * kHidden);
          prog.GetOutput(1, deep[g].data());
        } else {
          if (outputs != 1) throw std::runtime_error("embedding_vision_contract");
          image_hidden.resize(size_t(kImageTokens) * kHidden);
          prog.GetOutput(0, image_hidden.data());
        }
      });
      if (g < 3) h = std::move(next);
    }
  }

  // One text group over the whole prompt: `hid` [L][2048] in, replaced by the group output.
  void RunGroup(int g, const std::vector<int32_t>& ids, const std::vector<float>& cos, const std::vector<float>& sin,
                const std::vector<float> deep[kDeepStacks], int image_start, bool priority, std::vector<float>& hid) {
    const int L = int(ids.size());
    auto& group = txt[g];
    const int first = g * kGroupLayers;
    const int n_ds = g == 0 ? kDeepStacks : 0;
    std::vector<float> hist(size_t(kGroupLayers) * 2 * kLayerKv, 0.0f);
    auto cache = [&](int layer, int kv) { return hist.data() + (size_t(layer) * 2 + kv) * kLayerKv; };
    for (int i = 0; i < kGroupLayers; ++i)
      for (int kv = 0; kv < 2; ++kv) {
        const float* src = prefix.data() + (size_t(first + i) * 2 + kv) * kKvHeads * kHeadDim;
        for (int h = 0; h < kKvHeads; ++h)
          std::memcpy(cache(i, kv) + size_t(h) * kCap * kHeadDim, src + size_t(h) * kHeadDim, kHeadDim * sizeof(float));
      }
    std::vector<float> next(size_t(L) * kHidden, 0.0f);
    std::vector<float> x, c, s, m, ds[kDeepStacks], out0;
    std::vector<float> kvout(size_t(kKvHeads) * kPrefill * kHeadDim);
    // v2 packages (a 1-row program exists): 256-row chunks then the pooled token alone. v3 packages: the whole prompt, last token
    // included, is ONE call of the smallest profile that holds it.
    std::vector<Chunk> plan;
    if (group.progs.count(1)) plan = PrefillPlan(L, kPrefill, 1);
    else {
      const int rows = L - 1;
      const auto fit = group.progs.lower_bound(rows);
      if (fit == group.progs.end()) throw std::invalid_argument("embedding_prompt_invalid");
      plan.push_back({1, rows, fit->first});
    }
    for (const auto& chunk : plan) {
      const int P = chunk.profile, q = chunk.rows, start = chunk.start;
      const auto b0 = Clock::now();
      x.assign(size_t(P) * kHidden, 0.0f);
      c.assign(size_t(P) * kHeadDim, 1.0f);
      s.assign(size_t(P) * kHeadDim, 0.0f);
      m.resize(size_t(P) * kCap);
      for (int j = 0; j < n_ds; ++j) ds[j].assign(size_t(P) * kHidden, 0.0f);
      for (int r = 0; r < P; ++r) {
        const int src = start + std::min(r, q - 1);   // pad rows duplicate the last real row
        std::memcpy(&x[size_t(r) * kHidden], &hid[size_t(src) * kHidden], kHidden * sizeof(float));
        std::memcpy(&c[size_t(r) * kHeadDim], &cos[size_t(src) * kHeadDim], kHeadDim * sizeof(float));
        std::memcpy(&s[size_t(r) * kHeadDim], &sin[size_t(src) * kHeadDim], kHeadDim * sizeof(float));
        if (n_ds && image_start >= 0 && src >= image_start && src < image_start + kImageTokens)
          for (int j = 0; j < n_ds; ++j)
            std::memcpy(&ds[j][size_t(r) * kHidden], &deep[j][size_t(src - image_start) * kHidden], kHidden * sizeof(float));
      }
      BuildMask(start, q, P, m.data());
      auto& slot = group.progs.at(P);
      BpuProgram& prog = *slot.prog;
      int& filled = slot.filled;
      out0.resize(size_t(P) * kHidden);
      t_build += Ms(b0, Clock::now());
      Locked(priority, [&] {
        const auto s0 = Clock::now();
        size_t in = 0;
        prog.SetInput(in++, x.data());
        prog.SetInput(in++, c.data());
        prog.SetInput(in++, s.data());
        prog.SetInput(in++, m.data());
        for (int j = 0; j < n_ds; ++j) prog.SetInput(in++, ds[j].data());
        for (int i = 0; i < kGroupLayers; ++i)
          for (int kv = 0; kv < 2; ++kv) {
            float* dst = prog.InputData(in);
            // The KV window is right-aligned: the past occupies the last `start` rows of each head.
            if (filled > start)
              for (int h = 0; h < kKvHeads; ++h)
                std::memset(dst + (size_t(h) * kCap + (kCap - filled)) * kHeadDim, 0, size_t(filled - start) * kHeadDim * sizeof(float));
            for (int h = 0; h < kKvHeads; ++h)
              std::memcpy(dst + (size_t(h) * kCap + (kCap - start)) * kHeadDim, cache(i, kv) + size_t(h) * kCap * kHeadDim,
                          size_t(start) * kHeadDim * sizeof(float));
            prog.FlushInput(in++);
          }
        filled = start;
        const auto r0 = Clock::now();
        prog.Run();
        const auto g0 = Clock::now();
        t_set += Ms(s0, r0); t_run += Ms(r0, g0); ++n_calls;
        prog.GetOutput(0, out0.data());
        for (int i = 0; i < kGroupLayers; ++i)
          for (int kv = 0; kv < 2; ++kv) {
            const float* src = prog.OutputData(1 + 2 * size_t(i) + kv);
            for (int h = 0; h < kKvHeads; ++h)
              std::memcpy(cache(i, kv) + (size_t(h) * kCap + start) * kHeadDim, src + size_t(h) * P * kHeadDim,
                          size_t(q) * kHeadDim * sizeof(float));
          }
        t_get += Ms(g0, Clock::now());
      });
      std::memcpy(&next[size_t(start) * kHidden], out0.data(), size_t(q) * kHidden * sizeof(float));
    }
    hid = std::move(next);
  }

  std::vector<float> Run(const std::vector<int32_t>& ids, const float* chw, bool priority, EmbeddingStats* stats) {
    const auto t0 = Clock::now();
    t_build = t_set = t_run = t_get = 0; n_calls = 0;
    const int L = int(ids.size());
    if (L < 3 || L > kMaxPromptTokens || ids[0] != kImStart) throw std::invalid_argument("embedding_prompt_invalid");
    for (int32_t id : ids)
      if (id < 0 || id >= kVocabRows) throw std::invalid_argument("embedding_token_out_of_range");
    const auto at = std::find(ids.begin(), ids.end(), kImagePad);
    const bool image = at != ids.end();
    if (image && !chw) throw std::invalid_argument("embedding_image_missing");
    std::vector<float> hid(size_t(L) * kHidden);
    for (int i = 0; i < L; ++i) {
      const uint16_t* row = Embed() + size_t(ids[i]) * kHidden;
      uint32_t* dst = reinterpret_cast<uint32_t*>(&hid[size_t(i) * kHidden]);
      for (int d = 0; d < kHidden; ++d) dst[d] = uint32_t(row[d]) << 16;
    }
    std::vector<float> deep[kDeepStacks], image_hidden;
    int image_start = -1;
    if (image) {
      image_start = int(at - ids.begin());
      RunVision(chw, priority, image_hidden, deep);
      std::memcpy(&hid[size_t(image_start) * kHidden], image_hidden.data(), image_hidden.size() * sizeof(float));
    }
    const auto t1 = Clock::now();
    std::vector<float> cos, sin;
    MropeCosSin(RopeIndex(ids), size_t(L), cos, sin);
    for (int g = 0; g < kGroups; ++g) RunGroup(g, ids, cos, sin, deep, image_start, priority, hid);
    std::vector<float> raw(kEmbeddingDimensions);
    Locked(priority, [&] {
      head->SetInput(0, &hid[size_t(L - 1) * kHidden]);
      head->Run();
      head->GetOutput(0, raw.data());
    });
    double norm = 0;
    for (float v : raw) {
      if (!std::isfinite(v)) throw std::runtime_error("embedding_output_invalid");
      norm += double(v) * v;
    }
    if (norm <= 0) throw std::runtime_error("embedding_output_invalid");
    const float inv = float(1.0 / std::sqrt(norm));
    for (float& v : raw) v *= inv;
    if (stats) {
      const auto t2 = Clock::now();
      stats->vision_ms = Ms(t0, t1); stats->text_ms = Ms(t1, t2); stats->total_ms = Ms(t0, t2);
      stats->build_ms = t_build; stats->set_ms = t_set; stats->run_ms = t_run; stats->get_ms = t_get; stats->calls = n_calls;
    }
    return raw;
  }
};


std::unique_ptr<Qwen3VlEmbedder> Qwen3VlEmbedder::Load(const EmbeddingFiles& files) {
  if (!files.path || !files.read) throw std::invalid_argument("embedding_files_missing");
  std::unique_ptr<Qwen3VlEmbedder> self(new Qwen3VlEmbedder());
  self->impl_ = std::make_unique<Impl>();
  auto& impl = *self->impl_;
  self->tokenizer_ = std::make_unique<QwenTokenizer>(files.read(kVocabJson), files.read(kMergesTxt));
  impl.embed_map = Mapped(files.path(kEmbedTable), size_t(kVocabRows) * kHidden * sizeof(uint16_t));
  const auto rope = ReadFloats(files.path(kVisionRope), size_t(2) * kPatches * 64);
  impl.rope_cos.assign(rope.begin(), rope.begin() + size_t(kPatches) * 64);
  impl.rope_sin.assign(rope.begin() + size_t(kPatches) * 64, rope.end());
  impl.prefix = ReadFloats(files.path(kPrefixKv), size_t(kLayers) * 2 * kKvHeads * kHeadDim);
  for (int g = 0; g < 4; ++g) {
    impl.vis_pack[g] = BpuPack::Load(files.path(kVisionHbm[g]));
    if (impl.vis_pack[g]->ModelNames().size() != 1) throw std::runtime_error("embedding_vision_contract");
    impl.vis[g] = std::make_unique<BpuProgram>(impl.vis_pack[g], impl.vis_pack[g]->ModelNames()[0]);
  }
  for (int g = 0; g < kGroups; ++g) {
    auto& group = impl.txt[g];
    group.pack = BpuPack::Load(files.path(kTextHbm[g]));
    static const std::regex profile_name(".*_s([0-9]+)$");
    for (const auto& name : group.pack->ModelNames()) {
      std::smatch match;
      if (!std::regex_match(name, match, profile_name)) throw std::runtime_error("embedding_text_contract");
      const int rows = std::stoi(match[1]);
      if (rows < 1 || rows > kCap - 1 || group.progs.count(rows)) throw std::runtime_error("embedding_text_contract");
      group.progs[rows].prog = std::make_unique<BpuProgram>(group.pack, name);
    }
    const bool legacy = group.progs.count(1) != 0;
    if (group.progs.empty() || (legacy && group.progs.size() != 2) || (!legacy && group.progs.rbegin()->first < kImageTokens + 24))
      throw std::runtime_error("embedding_text_contract");   // a v3 package must hold the image prompt in one call
    if (g > 0 && (legacy != (impl.txt[0].progs.count(1) != 0))) throw std::runtime_error("embedding_text_contract");
    const size_t n_ds = g == 0 ? kDeepStacks : 0;
    for (auto& [rows, slot] : group.progs) {
      auto* prog = slot.prog.get();
      (void)rows;
      const size_t expected_in = 4 + n_ds + 2 * kGroupLayers;
      if (prog->Inputs().size() != expected_in || prog->Outputs().size() != 1 + 2 * size_t(kGroupLayers))
        throw std::runtime_error("embedding_text_contract");
      for (size_t i = 4 + n_ds; i < expected_in; ++i)
        if (!prog->InputPacked(i) || prog->Inputs()[i].shape != std::vector<int64_t>{kKvHeads, kCap, kHeadDim})
          throw std::runtime_error("embedding_text_contract");
      for (size_t i = 1; i < prog->Outputs().size(); ++i)
        if (!prog->OutputPacked(i)) throw std::runtime_error("embedding_text_contract");
    }
  }
  impl.head_pack = BpuPack::Load(files.path(kHeadHbm));
  if (impl.head_pack->ModelNames().size() != 1) throw std::runtime_error("embedding_head_contract");
  impl.head = std::make_unique<BpuProgram>(impl.head_pack, impl.head_pack->ModelNames()[0]);
  return self;
}

Qwen3VlEmbedder::~Qwen3VlEmbedder() = default;

bool Qwen3VlEmbedder::Healthy() const { return ainvr::BpuRuntimeHealthy(); }

std::vector<float> Qwen3VlEmbedder::EmbedIds(const std::vector<int32_t>& ids, const uint8_t* rgb, bool priority, EmbeddingStats* stats) {
  if (!rgb) return EmbedIdsChw(ids, nullptr, priority, stats);
  std::vector<float> chw(size_t(3) * kImageHeight * kImageWidth);
  const float scale = 1.0f / 255.0f;
  for (int y = 0; y < kImageHeight; ++y)
    for (int x = 0; x < kImageWidth; ++x)
      for (int c = 0; c < 3; ++c)
        chw[(size_t(c) * kImageHeight + y) * kImageWidth + x] = (float(rgb[(size_t(y) * kImageWidth + x) * 3 + c]) * scale - 0.5f) / 0.5f;
  return EmbedIdsChw(ids, chw.data(), priority, stats);
}

std::vector<float> Qwen3VlEmbedder::EmbedIdsChw(const std::vector<int32_t>& ids, const float* chw, bool priority, EmbeddingStats* stats) {
  struct Guard {
    std::atomic<int>& n; bool on;
    Guard(std::atomic<int>& v, bool p) : n(v), on(p) { if (on) ++n; }
    ~Guard() { if (on) --n; }
  } guard(impl_->priority_waiting, priority);
  return impl_->Run(ids, chw, priority, stats);
}

std::vector<float> Qwen3VlEmbedder::EmbedImage(const uint8_t* rgb, EmbeddingStats* stats) {
  return EmbedIds(ImageIds(), rgb, false, stats);
}

std::vector<float> Qwen3VlEmbedder::EmbedImageChw(const float* chw, EmbeddingStats* stats) {
  return EmbedIdsChw(ImageIds(), chw, false, stats);
}

const std::vector<int32_t>& Qwen3VlEmbedder::ImageIds() const {
  std::call_once(image_ids_once_, [this] { image_ids_ = BuildImageIds(*tokenizer_, kImageTokens); });
  return image_ids_;
}

std::vector<float> Qwen3VlEmbedder::EmbedQuery(std::string_view text, EmbeddingStats* stats) {
  return EmbedIds(BuildQueryIds(*tokenizer_, text, kMaxQueryTokens), nullptr, true, stats);
}

}  // namespace ainvr::embedding
