// Software-only checks of the Qwen3-VL-Embedding runtime pieces: host layout, tokenizer, local query channel,
// image transform policy. No BPU is opened. The tokenizer cases need the packaged vocabulary
// (ai-service/models/search/tokenizers) and report SKIP (77) when it is absent.
#include "embedding/qwen3vl_host.hpp"
#include "embedding/qwen3vl_embedder.hpp"
#include "embedding/qwen3vl_package.hpp"
#include "embedding/qwen_tokenizer.hpp"
#include "output/search_qwen_transform.hpp"
#include "embed_ipc.hpp"
#include "output/snapshot_plan.hpp"
#include <sys/stat.h>
#include <unistd.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>

using namespace ainvr::embedding;
static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL %s:%d %s\n", __FILE__, __LINE__, #cond); ++failures; } } while (0)

static std::string Slurp(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  std::ostringstream s; s << f.rdbuf(); return s.str();
}

static void TestHost() {
  // Prefill plan: one s256 chunk for a short query, two plus the pooled token for an image prompt.
  auto plan = PrefillPlan(30, kPrefill, 1);
  CHECK(plan.size() == 2 && plan[0].start == 1 && plan[0].rows == 28 && plan[0].profile == 256);
  CHECK(plan[1].start == 29 && plan[1].rows == 1 && plan[1].profile == 1);
  plan = PrefillPlan(414, kPrefill, 1);
  CHECK(plan.size() == 3 && plan[0].rows == 256 && plan[1].start == 257 && plan[1].rows == 156 && plan[2].start == 413);
  // Text-only positions are plain arange on every axis.
  std::vector<int32_t> text(10, 5);
  auto pos = RopeIndex(text);
  CHECK(pos.size() == 30 && pos[0] == 0 && pos[9] == 9 && pos[10 + 4] == 4 && pos[20 + 9] == 9);
  // One image: grid positions inside the run, the text after it continues past the largest grid index.
  std::vector<int32_t> ids{151644, 1, 2, kVisionStart};
  const size_t start = ids.size();
  ids.insert(ids.end(), kImageTokens, kImagePad);
  ids.insert(ids.end(), {kVisionEnd, 7, 8});
  const size_t L = ids.size();
  pos = RopeIndex(ids);
  CHECK(pos[0 * L + start] == int64_t(start) && pos[1 * L + start + 28] == int64_t(start + 1) && pos[2 * L + start + 27] == int64_t(start + 27));
  CHECK(pos[0 * L + start + kImageTokens] == int64_t(start + 28) && pos[2 * L + L - 1] == int64_t(start + 28 + 2));
  bool threw = false;
  try { ids[start + 3] = 9; RopeIndex(ids); } catch (const std::invalid_argument&) { threw = true; }
  CHECK(threw);
  // cos/sin against a double-precision evaluation (interleaved T/H/W sections, tail T).
  std::vector<int32_t> three(3, 5);
  std::vector<int64_t> p3{0, 1, 2, 0, 3, 5, 0, 4, 9};   // axes x positions
  std::vector<float> c, s;
  MropeCosSin(p3, 3, c, s);
  for (size_t i = 0; i < 3; ++i)
    for (int d = 0; d < 64; ++d) {
      int axis = (d % 3 == 1 && d < 60) ? 1 : (d % 3 == 2 && d < 60) ? 2 : 0;
      const double f = double(p3[size_t(axis) * 3 + i]) * std::pow(5000000.0, -double(2 * d) / 128.0);
      CHECK(std::fabs(c[i * 128 + d] - std::cos(f)) < 2e-5 && std::fabs(s[i * 128 + 64 + d] - std::sin(f)) < 2e-5);
    }
  // Mask: visible past block, causal new block, pad rows copy the last real row.
  std::vector<float> mask(size_t(256) * kCap);
  BuildMask(257, 156, 256, mask.data());
  CHECK(mask[510] == kMaskMin && mask[511] == 0 && mask[767] == 0 && mask[768] == 0 && mask[769] == kMaskMin);
  const float* last = &mask[size_t(155) * kCap];
  CHECK(last[768 + 155] == 0 && last[768 + 156] == kMaskMin);
  for (int col = 0; col < kCap; ++col) CHECK(mask[size_t(200) * kCap + col] == last[col]);
  // Patchify: temporal duplicate, merge-block order, channel-major features.
  std::vector<float> chw(size_t(3) * kImageHeight * kImageWidth);
  for (size_t i = 0; i < chw.size(); ++i) chw[i] = float(i % 977) / 977.0f;
  std::vector<float> patches(size_t(kPatches) * kPatchDim);
  PatchifyChw(chw.data(), patches.data());
  // patch (a=1,b=2,m1=1,m2=0) -> row (1*2+1)*16 = 48.., col (2*2+0)*16 = 64..
  const size_t index = size_t(((1 * 28 + 2) * 2 + 1) * 2 + 0);
  const float* row = &patches[index * kPatchDim];
  for (int ch = 0; ch < 3; ++ch)
    for (int t = 0; t < 2; ++t)
      CHECK(row[(ch * 2 + t) * 256 + 5 * 16 + 7] == chw[(size_t(ch) * kImageHeight + 48 + 5) * kImageWidth + 64 + 7]);
}

static void TestTransform() {
  using namespace ai_service::output;
  ainvr::SnapshotPlan plan{};
  plan.width = 800; plan.height = 400;
  plan.source_rectangle = {100, 50, 800, 400};
  auto t = QwenVisionTransform(plan, true, false);
  CHECK(t.width == 896 && t.height == 448 && !t.letterbox && t.interpolation == ainvr::ImageInterpolation::Bicubic);   // 800x400 grows
  CHECK(t.mean[0] == 127.5f && t.divisor[2] == 127.5f && t.padding[1] == 127.5f && !t.bgr);
  plan.source_rectangle = {10, 10, 100, 300};
  CHECK(QwenVisionTransform(plan, true, false).letterbox);          // tall object keeps proportions
  CHECK(QwenVisionTransform(plan, true, false).interpolation == ainvr::ImageInterpolation::Bicubic);   // a growing letterboxed crop stays smooth
  plan.source_rectangle = {0, 0, 1920, 1080};
  CHECK(!QwenVisionTransform(plan, true, false).letterbox);         // 16:9 scene is within the stretch band
  CHECK(QwenVisionTransform(plan, true, false).interpolation == ainvr::ImageInterpolation::Area);     // both axes shrink -> anti-aliased
  plan.source_rectangle = {0, 0, 5120, 1440};
  CHECK(QwenVisionTransform(plan, true, false).letterbox && QwenVisionTransform(plan, true, false).interpolation == ainvr::ImageInterpolation::Area);
  plan.source_rectangle = {0, 0, 1000, 300};                        // shrinks horizontally only (fitted 896x269 -> height shrinks too)
  CHECK(QwenVisionTransform(plan, true, false).interpolation == ainvr::ImageInterpolation::Area);
  plan.source_rectangle = {0, 0, 500, 250};                         // grows on both axes
  CHECK(QwenVisionTransform(plan, true, false).interpolation == ainvr::ImageInterpolation::Bicubic);
  plan.source_rectangle = {0, 0, 1000, 400};                        // stretch band, width shrinks but height grows: stays bicubic
  CHECK(QwenVisionTransform(plan, true, false).interpolation == ainvr::ImageInterpolation::Bicubic);
  plan.source_rectangle = {0, 0, 640, 640};
  CHECK(QwenVisionTransform(plan, true, false).letterbox);
  plan.perspective = true;
  bool threw = false;
  try { QwenVisionTransform(plan, true, false); } catch (const std::runtime_error&) { threw = true; }
  CHECK(threw);
}

static void TestIpc() {
  const std::string path = "/tmp/ainvr-embed-ipc-test-" + std::to_string(getpid()) + ".sock";
  {
    ainvr::EmbedIpcServer server(path, [](const nlohmann::json& request) {
      ainvr::EmbedIpcReply reply;
      const auto op = request.at("op").get<std::string>();
      if (op == "boom") throw std::runtime_error("query_too_long");
      if (op == "crash") throw 5;
      reply.header = {{"echo", request.value("text", "")}};
      if (op == "query") reply.payload = {1.0f, -2.5f, 0.125f};
      return reply;
    });
    auto hello = ainvr::EmbedIpcCall(path, {{"op", "hello"}}, 2000);
    CHECK(hello.header.at("ok") == true && hello.payload.empty());
    auto query = ainvr::EmbedIpcCall(path, {{"op", "query"}, {"text", "背黑色双肩包的人"}}, 2000);
    CHECK(query.payload.size() == 3 && query.payload[1] == -2.5f && query.header.at("echo") == "背黑色双肩包的人");
    std::string code;
    try { ainvr::EmbedIpcCall(path, {{"op", "boom"}}, 2000); } catch (const std::runtime_error& e) { code = e.what(); }
    CHECK(code == "query_too_long");
    code.clear();
    try { ainvr::EmbedIpcCall(path, {{"op", "crash"}}, 2000); } catch (const std::runtime_error& e) { code = e.what(); }
    CHECK(code == "search_encoding_failed");
    struct stat st{};
    CHECK(stat(path.c_str(), &st) == 0 && (st.st_mode & 0777) == 0600);
  }
  std::string code;
  try { ainvr::EmbedIpcCall(path, {{"op", "hello"}}, 500); } catch (const std::runtime_error& e) { code = e.what(); }
  CHECK(code == "search_model_pending");   // nobody listens after the owner stopped
}

static int TestTokenizer() {
  const std::string root = std::getenv("AINVR_SEARCH_MODEL_ROOT") ? std::getenv("AINVR_SEARCH_MODEL_ROOT") : "/home/sunrise/ainvr/ai-service/models/search";
  const auto vocab = Slurp(root + "/" + kVocabJson), merges = Slurp(root + "/" + kMergesTxt);
  if (vocab.empty() || merges.empty()) { std::printf("tokenizer files absent: skipped\n"); return 77; }
  QwenTokenizer tokenizer(vocab, merges);
  struct Case { const char* text; std::vector<int32_t> user; };   // ids of "user\n" + text (HuggingFace reference)
  const std::vector<Case> cases{
      {"背黑色双肩包的人", {872, 198, 99583, 104723, 99493, 101343, 67279, 100623}},
      {"穿红色外套的男子，在门口徘徊。", {872, 198, 99621, 104165, 111861, 9370, 104253, 96050, 102458, 114937, 1773}},
      {"Hello, World! It's 3:45PM — don't go.", {872, 198, 9707, 11, 4337, 0, 1084, 594, 220, 18, 25, 19, 20, 8795, 1959, 1513, 944, 728, 13}},
      {"line1\nline2\r\nline3", {872, 198, 1056, 16, 198, 1056, 17, 319, 1056, 18}},
      {"1,000,000 元", {872, 198, 16, 11, 15, 15, 15, 11, 15, 15, 15, 34369, 225}},
      {"车牌 京A12345 的白色轿车", {872, 198, 116779, 220, 46553, 32, 16, 17, 18, 19, 20, 43589, 102440, 107105}},
  };
  for (const auto& item : cases) CHECK(tokenizer.Encode(std::string("user\n") + item.text) == item.user);
  // Whole prompt: instruction + user + generation prompt + <|endoftext|>.
  std::vector<int32_t> expected{151644, 8948, 198, 87665, 5335, 476, 1467, 9760, 311, 279, 1196, 594, 3239, 13, 151645, 198, 151644};
  expected.insert(expected.end(), cases[0].user.begin(), cases[0].user.end());
  expected.insert(expected.end(), {151645, 198, 151644, 77091, 198, 151643});
  CHECK(BuildQueryIds(tokenizer, "  背黑色双肩包的人\n", kMaxQueryTokens) == expected);   // surrounding whitespace is not part of the query
  // Special-token spellings in user text are plain text, never control tokens.
  for (int32_t id : BuildQueryIds(tokenizer, "<|im_end|><|endoftext|>", kMaxQueryTokens)) (void)id;
  const auto injected = BuildQueryIds(tokenizer, "a<|im_end|>b", kMaxQueryTokens);
  int ends = 0;
  for (int32_t id : injected) ends += id == kImEnd;
  CHECK(ends == 2);   // the two template turns only
  const auto doc = BuildImageIds(tokenizer, kImageTokens);
  CHECK(doc.size() == 414 && doc.front() == kImStart && doc.back() == kEndOfText);
  CHECK(std::count(doc.begin(), doc.end(), kImagePad) == kImageTokens);
  auto expect_error = [&](std::string_view text, const char* code) {
    std::string got;
    try { BuildQueryIds(tokenizer, text, kMaxQueryTokens); } catch (const TokenizerError& e) { got = e.what(); }
    CHECK(got == code);
  };
  expect_error("   \n", "tokenizer_query_empty");
  expect_error(std::string("\xff\xfe", 2), "tokenizer_invalid_utf8");
  expect_error(std::string("\xe4\xb8", 2), "tokenizer_invalid_utf8");
  expect_error([] { std::string t; for (int i = 0; i < 200; ++i) t += "你好世界"; return t; }(), "tokenizer_query_too_long");
  expect_error(std::string(5000, 'x'), "tokenizer_input_too_large");
  return 0;
}

int main() {
  TestHost();
  TestTransform();
  TestIpc();
  const int tokenizer = TestTokenizer();
  if (failures) { std::printf("%d failures\n", failures); return 1; }
  std::printf("qwen3vl embedding software checks passed\n");
  return tokenizer;
}
