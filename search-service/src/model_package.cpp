#include "model_package.hpp"
#include "../../shared/cpp/siglip_text_contract.hpp"
#include <openssl/evp.h>
#include <algorithm>
#include <array>
#include <cerrno>
#include <fcntl.h>
#include <iomanip>
#include <map>
#include <regex>
#include <set>
#include <sstream>
#include <stdexcept>
#include <sys/stat.h>
#include <unistd.h>
namespace ainvr::search {
namespace {
using Json = nlohmann::json;
constexpr uint64_t kMaxHbmBytes = 8ULL * 1024 * 1024 * 1024;
constexpr uint64_t kMaxTokenizerBytes = 64 * 1024 * 1024, kMaxMetadataBytes = 65536;
[[noreturn]] void Invalid() { throw std::runtime_error("model_package_invalid"); }
class Fd {
 public:
  explicit Fd(int value = -1) : value_(value) {}
  ~Fd() { if (value_ >= 0) close(value_); }
  Fd(Fd&& other) noexcept : value_(other.value_) { other.value_ = -1; }
  Fd& operator=(Fd&& other) noexcept {
    if (this != &other) { if (value_ >= 0) close(value_); value_ = other.value_; other.value_ = -1; }
    return *this;
  }
  Fd(const Fd&) = delete; Fd& operator=(const Fd&) = delete;
  int get() const { return value_; }
 private: int value_;
};
struct HeldFile { std::string relative; Fd fd; struct stat identity{}; };
bool Same(const struct stat& a, const struct stat& b) {
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_size == b.st_size && a.st_mode == b.st_mode &&
    a.st_mtim.tv_sec == b.st_mtim.tv_sec && a.st_mtim.tv_nsec == b.st_mtim.tv_nsec &&
    a.st_ctim.tv_sec == b.st_ctim.tv_sec && a.st_ctim.tv_nsec == b.st_ctim.tv_nsec;
}
std::vector<std::string> Components(const std::string& path, bool absolute) {
  if (path.empty() || (absolute ? path.front() != '/' : path.front() == '/') ||
      path.find_first_of("\\\r\n\0", 0, 4) != std::string::npos) Invalid();
  std::vector<std::string> parts; size_t from = absolute ? 1 : 0;
  while (from < path.size()) {
    const auto end = path.find('/', from); const auto part = path.substr(from, end - from);
    if (part.empty() || part == "." || part == "..") Invalid();
    parts.push_back(part);
    if (end == std::string::npos) break;
    from = end + 1;
  }
  if (parts.empty() || path.back() == '/') Invalid();
  return parts;
}
Fd Root(const std::string& path) {
  const auto parts = Components(path, true);
  Fd current(open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
  if (current.get() < 0) Invalid();
  for (const auto& part : parts) {
    Fd next(openat(current.get(), part.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
    if (next.get() < 0) Invalid();
    current = std::move(next);
  }
  return current;
}
HeldFile Open(int root, const std::string& path, bool directory, uint64_t maximum) {
  const auto parts = Components(path, false);
  Fd current(fcntl(root, F_DUPFD_CLOEXEC, 0)); if (current.get() < 0) Invalid();
  for (size_t index = 0; index < parts.size(); ++index) {
    const bool dir = directory || index + 1 < parts.size();
    const int flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | (dir ? O_DIRECTORY : 0);
    Fd next(openat(current.get(), parts[index].c_str(), flags));
    if (next.get() < 0) Invalid();
    current = std::move(next);
  }
  struct stat st{};
  if (fstat(current.get(), &st) || (directory ? !S_ISDIR(st.st_mode) :
      (!S_ISREG(st.st_mode) || st.st_size <= 0 || uint64_t(st.st_size) > maximum))) Invalid();
  return {path, std::move(current), st};
}
void Unchanged(const HeldFile& file) {
  struct stat after{}; if (fstat(file.fd.get(), &after) || !Same(file.identity, after)) Invalid();
}
std::string Bytes(const HeldFile& file, uint64_t maximum) {
  if (file.identity.st_size <= 0 || uint64_t(file.identity.st_size) > maximum) Invalid();
  std::string bytes(size_t(file.identity.st_size), '\0'); size_t done = 0;
  while (done < bytes.size()) {
    const auto n = pread(file.fd.get(), bytes.data() + done, bytes.size() - done, off_t(done));
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) Invalid();
    done += size_t(n);
  }
  Unchanged(file); return bytes;
}
std::string Hex(const unsigned char* digest, unsigned int size) {
  std::ostringstream out; out << std::hex << std::setfill('0');
  for (unsigned int i = 0; i < size; ++i) out << std::setw(2) << unsigned(digest[i]);
  return out.str();
}
std::string Hash(const HeldFile& file) {
  auto ctx = std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)>(EVP_MD_CTX_new(), EVP_MD_CTX_free);
  if (!ctx || EVP_DigestInit_ex(ctx.get(), EVP_sha256(), nullptr) != 1) Invalid();
  std::array<char, 1024 * 1024> buffer{}; uint64_t offset = 0;
  while (offset < uint64_t(file.identity.st_size)) {
    const auto size = std::min<uint64_t>(buffer.size(), uint64_t(file.identity.st_size) - offset);
    const auto n = pread(file.fd.get(), buffer.data(), size_t(size), off_t(offset));
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0 || EVP_DigestUpdate(ctx.get(), buffer.data(), size_t(n)) != 1) Invalid();
    offset += uint64_t(n);
  }
  std::array<unsigned char, EVP_MAX_MD_SIZE> digest{}; unsigned int size = 0;
  if (EVP_DigestFinal_ex(ctx.get(), digest.data(), &size) != 1) Invalid();
  Unchanged(file); return Hex(digest.data(), size);
}
std::string HashText(const std::string& text) {
  std::array<unsigned char, EVP_MAX_MD_SIZE> digest{}; unsigned int size = 0;
  if (EVP_Digest(text.data(), text.size(), digest.data(), &size, EVP_sha256(), nullptr) != 1) Invalid();
  return Hex(digest.data(), size);
}
Json Metadata(const HeldFile& file) {
  std::vector<std::set<std::string>> keys;
  return Json::parse(Bytes(file, kMaxMetadataBytes), [&](int depth, Json::parse_event_t event, Json& value) {
    if (depth > 20) Invalid();
    if (event == Json::parse_event_t::object_start) keys.emplace_back();
    if (event == Json::parse_event_t::key && (keys.empty() || !keys.back().insert(value.get<std::string>()).second)) Invalid();
    if (event == Json::parse_event_t::object_end) keys.pop_back();
    return true;
  });
}
bool Sha(const std::string& value) { return std::regex_match(value, std::regex("[a-f0-9]{64}")); }
void Tensor(const Json& raw, const TensorSpec& spec) {
  if (!raw.is_object() || raw.at("name") != spec.name || raw.at("dtype") != spec.dtype || raw.at("shape") != Json(spec.shape)) Invalid();
  for (const auto& dimension : raw.at("shape")) if (!dimension.is_number_integer() || dimension <= 0) Invalid();
}
void EncoderMetadata(const Json& raw, const PackageSpec& spec, const EncoderSpec& encoder, const char* role) {
  if (!raw.is_object() || !raw.at("schema_version").is_number_integer() || raw.at("schema_version") != 1 || raw.at("target") != "rdk_s100p" ||
      raw.at("hbm_file") != encoder.file || raw.at("role") != role || raw.at("family") != spec.family ||
      !raw.at("accuracy_verified").is_boolean() || !raw.at("production_approved").is_boolean() ||
      !raw.at("hbm_bytes").is_number_integer() || raw.at("hbm_bytes") <= 0 || raw.at("hbm_bytes") > kMaxHbmBytes ||
      !Sha(raw.at("hbm_sha256").get<std::string>())) Invalid();
  const auto& programs = raw.at("programs");
  if (!programs.is_object() || programs.empty() || programs.size() > 16) Invalid();
  const auto& selected = programs.at(encoder.program);
  if (!selected.at("inputs").is_array() || selected.at("inputs").size() != 1 ||
      !selected.at("outputs").is_array() || selected.at("outputs").size() != 1) Invalid();
  Tensor(selected.at("inputs").at(0), encoder.input); Tensor(selected.at("outputs").at(0), encoder.output);
}
std::map<std::string, std::string> Checksums(const HeldFile& manifest) {
  std::map<std::string, std::string> result; std::istringstream input(Bytes(manifest, kMaxMetadataBytes)); std::string line;
  while (std::getline(input, line)) {
    if (line.size() < 67 || !Sha(line.substr(0, 64)) || line[64] != ' ' || (line[65] != ' ' && line[65] != '*')) Invalid();
    auto relative = line.substr(66); if (relative.rfind("./", 0) == 0) relative.erase(0, 2);
    Components(relative, false);
    if (!result.emplace(relative, line.substr(0, 64)).second) Invalid();
  }
  if (result.empty()) Invalid();
  return result;
}
TensorSpec TS(const char* name, const char* dtype, std::initializer_list<int64_t> shape) { return {name, dtype, shape}; }
PackageSpec Spec(bool so400m, bool pruned) {
  PackageSpec spec;
  spec.id = std::string(so400m ? "siglip-so400m-i18n-" : "siglip2-base-") + (pruned ? "pruned-int8" : "full-int8");
  spec.title = std::string(so400m ? "SigLIP so400m · " : "SigLIP2 base · ") + (pruned ? "裁词表备选" : "完整词表 INT8");
  spec.family = so400m ? "siglip-so400m-patch16-256-i18n" : "siglip2-base-patch16-256";
  spec.embedding_vocab_size = pruned ? 32768 : so400m ? ainvr::text::kSiglipEmbeddingRows : 256000;
  spec.dimensions = so400m ? 1152 : 768; spec.pruned = pruned; spec.pad_id = so400m ? 1 : 0;
  spec.vision = so400m
    ? EncoderSpec{"siglip-so400m-patch16-256-i18n-vision.hbm", "pooler_output", TS("_input_0", "F32", {1,3,256,256}), TS("_output_0", "F32", {1,1,1152})}
    : EncoderSpec{"siglip2-base-patch16-256-vision-o2.hbm", "siglip2_base_vision", TS("pixel_values", "F32", {1,3,256,256}), TS("image_embedding", "F32", {1,768})};
  spec.text = {std::string(so400m ? "siglip-so400m-i18n-text64-" : "siglip2-base-text64-") + (pruned ? "p16k-tbl8-o2.hbm" : "tbl8-o2.hbm"),
    so400m ? "siglip_text" : "siglip2_base_text", TS("input_ids", "S64", {1,64}), TS("text_embedding", "F32", {1, int64_t(spec.dimensions)})};
  spec.tokenizer = so400m ? "siglip-so400m-i18n.spiece.model" : "siglip2-base.tokenizer.model";
  if (pruned) spec.tokenizer_auxiliary = {std::string(so400m ? "so400m_top16000" : "siglip2_top16000") + ".npz"};
  spec.input_spec_version = "image-area-rgb-u8-round-before-normalize-mean127.5-div127.5-squash256-l2-v1;source-yuv-matrix-range-from-frame-metadata;";
  spec.input_spec_version += so400m ? ainvr::text::kSiglipNormalizationSpec : "text-gemma-lower-sp-eos1-pad0-s64x64-v1";
  if (pruned) spec.input_spec_version += ";pruned-longest-kept-piece-remap-v1";
  return spec;
}
}  // namespace
struct PackageVerificationState {
  std::string root_path, manifest_sha256;
  Fd root;
  struct stat root_identity{};
  std::vector<HeldFile> files, directories;
};
const std::vector<PackageSpec>& PackageSpecs() {
  static const std::vector<PackageSpec> specs{Spec(true, false), Spec(false, false), Spec(true, true), Spec(false, true)};
  return specs;
}
const PackageSpec& FindPackageSpec(const std::string& id) {
  for (const auto& spec : PackageSpecs()) if (spec.id == id) return spec;
  throw std::invalid_argument("unknown_search_model_package");
}
const char* DefaultPackageId() { return "siglip-so400m-i18n-full-int8"; }
int VerifiedPackage::BorrowedFileDescriptor(const std::string& relative_path) const {
  if (state_ && files_verified) for (const auto& file : state_->files) if (file.relative == relative_path) return file.fd.get();
  throw std::invalid_argument("unverified_model_artifact");
}
bool VerifyStillCurrent(const VerifiedPackage& package) {
  if (!package.files_verified || !package.state_) return false;
  try {
    const auto& state = *package.state_; auto root = Root(state.root_path); struct stat root_now{};
    if (fstat(root.get(), &root_now) || !Same(root_now, state.root_identity)) return false;
    for (const auto& dir : state.directories) {
      Unchanged(dir); auto current = Open(root.get(), dir.relative, true, 0);
      if (!Same(current.identity, dir.identity)) return false;
    }
    for (const auto& file : state.files) {
      Unchanged(file); auto current = Open(root.get(), file.relative, false, kMaxHbmBytes);
      if (!Same(current.identity, file.identity)) return false;
      // Timestamp granularity can hide a same-inode, same-size rewrite. This is
      // a loading-boundary check, never a per-query or per-frame operation.
      std::string expected = state.manifest_sha256;
      if (file.relative != "SHA256SUMS.txt") {
        const auto item = std::find_if(package.artifacts.begin(), package.artifacts.end(),
          [&](const auto& artifact) { return artifact.relative_path == file.relative; });
        if (item == package.artifacts.end()) return false;
        expected = item->sha256;
      }
      if (Hash(file) != expected) return false;
    }
    return true;
  } catch (...) { return false; }
}
VerifiedPackage VerifyPackage(const std::string& package_id) { return VerifyPackageAtTrustedRoot(kSearchModelRoot, package_id); }
VerifiedPackage VerifyPackageAtTrustedRoot(const std::string& root_path, const std::string& package_id) {
  const auto& spec = FindPackageSpec(package_id);
  auto state = std::make_shared<PackageVerificationState>(); state->root_path = root_path; state->root = Root(root_path);
  if (fstat(state->root.get(), &state->root_identity)) Invalid();
  state->directories.push_back(Open(state->root.get(), "hbm", true, 0));
  state->directories.push_back(Open(state->root.get(), "tokenizers", true, 0));
  state->files.push_back(Open(state->root.get(), "SHA256SUMS.txt", false, kMaxMetadataBytes));
  state->manifest_sha256 = Hash(state->files.back());
  const auto sums = Checksums(state->files.back());
  VerifiedPackage result; result.spec = &spec; result.state_ = state;
  Json version{{"schema", "ainvr-search-vector-space-v1"}, {"package_id", spec.id}, {"family", spec.family},
    {"dimensions", spec.dimensions}, {"embedding_vocab_size", spec.embedding_vocab_size}, {"vision_program", spec.vision.program}, {"text_program", spec.text.program},
    {"input_spec", spec.input_spec_version}, {"pad_id", spec.pad_id}, {"eos_id", spec.eos_id}};
  auto artifact = [&](const std::string& relative, uint64_t maximum) -> HeldFile& {
    state->files.push_back(Open(state->root.get(), relative, false, maximum)); auto& file = state->files.back();
    const auto hash = Hash(file); const auto expected = sums.find(relative);
    if (expected == sums.end() || expected->second != hash) Invalid();
    result.artifacts.push_back({relative, hash, uint64_t(file.identity.st_size)}); return file;
  };
  auto encoder = [&](const EncoderSpec& contract, const char* role) {
    const auto relative = "hbm/" + contract.file;
    const auto metadata = Metadata(artifact(relative + ".ainvr.json", kMaxMetadataBytes));
    EncoderMetadata(metadata, spec, contract, role);
    const auto& file = artifact(relative, kMaxHbmBytes); const auto& actual = result.artifacts.back();
    if (metadata.at("hbm_bytes") != uint64_t(file.identity.st_size) || metadata.at("hbm_sha256") != actual.sha256) Invalid();
    version[role] = {{"sha256", actual.sha256}, {"program", contract.program}, {"input", {{"name", contract.input.name}, {"dtype", contract.input.dtype}, {"shape", contract.input.shape}}},
      {"output", {{"name", contract.output.name}, {"dtype", contract.output.dtype}, {"shape", contract.output.shape}}}};
    return metadata.at("accuracy_verified").get<bool>() && metadata.at("production_approved").get<bool>();
  };
  const bool vision_approval = encoder(spec.vision, "image_embedding");
  const bool text_approval = encoder(spec.text, "text_embedding");
  std::vector<std::string> tokenizer_files{spec.tokenizer};
  tokenizer_files.insert(tokenizer_files.end(), spec.tokenizer_auxiliary.begin(), spec.tokenizer_auxiliary.end());
  for (const auto& name : tokenizer_files) {
    artifact("tokenizers/" + name, kMaxTokenizerBytes); version["tokenizers"][name] = result.artifacts.back().sha256;
  }
  result.production_approval_declared = vision_approval && text_approval;
  result.model_version = "search-v1-" + HashText(version.dump()); result.files_verified = true;
  if (!VerifyStillCurrent(result)) Invalid();
  return result;
}
Json InspectPackageMetadata(const std::string& trusted_root, const PackageSpec& spec) {
  const auto& expected = FindPackageSpec(spec.id); auto root = Root(trusted_root);
  auto vision = Open(root.get(), "hbm/" + expected.vision.file, false, kMaxHbmBytes);
  auto text = Open(root.get(), "hbm/" + expected.text.file, false, kMaxHbmBytes);
  auto vfile = Open(root.get(), vision.relative + ".ainvr.json", false, kMaxMetadataBytes);
  auto tfile = Open(root.get(), text.relative + ".ainvr.json", false, kMaxMetadataBytes);
  const auto v = Metadata(vfile), t = Metadata(tfile);
  EncoderMetadata(v, expected, expected.vision, "image_embedding"); EncoderMetadata(t, expected, expected.text, "text_embedding");
  if (v.at("hbm_bytes") != uint64_t(vision.identity.st_size) || t.at("hbm_bytes") != uint64_t(text.identity.st_size)) Invalid();
  Open(root.get(), "tokenizers/" + expected.tokenizer, false, kMaxTokenizerBytes);
  for (const auto& auxiliary : expected.tokenizer_auxiliary) Open(root.get(), "tokenizers/" + auxiliary, false, kMaxTokenizerBytes);
  const bool declared = v.at("accuracy_verified").get<bool>() && t.at("accuracy_verified").get<bool>() &&
    v.at("production_approved").get<bool>() && t.at("production_approved").get<bool>();
  return {{"production_approval_declared", declared}};
}
bool PackageArtifactsPresent(const std::string& trusted_root, const PackageSpec& spec) {
  try {
    const auto& expected = FindPackageSpec(spec.id); auto root = Root(trusted_root);
    Open(root.get(), "hbm/" + expected.vision.file, false, kMaxHbmBytes);
    Open(root.get(), "hbm/" + expected.text.file, false, kMaxHbmBytes);
    return true;
  } catch (...) { return false; }
}
}  // namespace ainvr::search
