#include "model_package.hpp"
#include "model_catalog.hpp"
#include <openssl/evp.h>
#include <array>
#include <cerrno>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <map>
#include <sstream>
#include <thread>
#include <type_traits>
#include <fcntl.h>
#include <unistd.h>
using namespace ainvr::search;
using Json = nlohmann::json;
namespace fs = std::filesystem;
namespace {
int cases = 0;
void Check(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
template<class Function> void Reject(Function fn) {
  bool failed = false; try { fn(); } catch (const std::exception&) { failed = true; }
  Check(failed, "invalid package accepted"); ++cases;
}
std::string Digest(const std::string& bytes) {
  std::array<unsigned char, EVP_MAX_MD_SIZE> hash{}; unsigned int length = 0;
  Check(EVP_Digest(bytes.data(), bytes.size(), hash.data(), &length, EVP_sha256(), nullptr) == 1, "test digest failed");
  std::ostringstream out; out << std::hex << std::setfill('0');
  for (unsigned int i = 0; i < length; ++i) out << std::setw(2) << unsigned(hash[i]);
  return out.str();
}
void Write(const fs::path& path, const std::string& bytes) {
  std::ofstream output(path, std::ios::binary | std::ios::trunc); output << bytes;
  Check(bool(output), "fixture write failed");
}
std::string Read(const fs::path& path) {
  std::ifstream input(path, std::ios::binary); return {std::istreambuf_iterator<char>(input), {}};
}
Json Tensor(const TensorSpec& spec) { return {{"name", spec.name}, {"dtype", spec.dtype}, {"shape", spec.shape}}; }
struct Fixture {
  fs::path root;
  const PackageSpec& spec;
  explicit Fixture(const PackageSpec& selected = FindPackageSpec(DefaultPackageId())) : spec(selected) {
    auto pattern = (fs::current_path() / "ainvr-model-package-fixture-XXXXXX").string();
    char* created = mkdtemp(pattern.data()); Check(created != nullptr, "fixture directory failed"); root = created;
    fs::create_directory(root / "hbm"); fs::create_directory(root / "tokenizers");
    Encoder(spec.vision, "image_embedding"); Encoder(spec.text, "text_embedding");
    Write(root / "tokenizers" / spec.tokenizer, "test-sentencepiece-bytes-v1");
    for (const auto& name : spec.tokenizer_auxiliary) Write(root / "tokenizers" / name, "PK-test-remapping-fixture");
    Manifest();
  }
  ~Fixture() { std::error_code error; fs::remove_all(root, error); }
  fs::path MetadataPath(bool text = false) const { return root / "hbm" / ((text ? spec.text.file : spec.vision.file) + ".ainvr.json"); }
  void Encoder(const EncoderSpec& encoder, const char* role) {
    const auto data = "test-hbm-bytes-for-" + encoder.program;
    Write(root / "hbm" / encoder.file, data);
    const Json program{{"inputs", Json::array({Tensor(encoder.input)})}, {"outputs", Json::array({Tensor(encoder.output)})}};
    Json metadata{{"schema_version", 1}, {"target", "rdk_s100p"}, {"hbm_file", encoder.file},
      {"hbm_sha256", Digest(data)}, {"hbm_bytes", data.size()}, {"role", role}, {"family", spec.family},
      {"programs", {{encoder.program, program}}}, {"accuracy_verified", false}, {"production_approved", false}};
    if (encoder.program == "pooler_output") {
      auto hidden = program; hidden["outputs"][0]["shape"] = {1,256,int64_t(spec.dimensions)};
      metadata["programs"]["last_hidden_state"] = hidden;
      metadata["default_program"] = "last_hidden_state"; // Explicit selection must override this unsafe default.
    }
    Write(root / "hbm" / (encoder.file + ".ainvr.json"), metadata.dump());
  }
  void Manifest() {
    std::map<std::string, std::string> hashes;
    for (const auto& dir : {root / "hbm", root / "tokenizers"}) for (const auto& entry : fs::directory_iterator(dir))
      if (entry.is_regular_file()) hashes[fs::relative(entry.path(), root).generic_string()] = Digest(Read(entry.path()));
    std::string text; for (const auto& [name, hash] : hashes) text += hash + "  ./" + name + "\n";
    Write(root / "SHA256SUMS.txt", text);
  }
  void Edit(bool text, const std::function<void(Json&)>& edit) {
    const auto path = MetadataPath(text); auto metadata = Json::parse(Read(path)); edit(metadata); Write(path, metadata.dump()); Manifest();
  }
  VerifiedPackage Verify() const { return VerifyPackageAtTrustedRoot(root.string(), spec.id); }
};
}  // namespace
int main() {
  static_assert(!std::is_copy_constructible_v<VerifiedPackage>);
  try {
    Check(std::string(DefaultPackageId()) == "siglip-so400m-i18n-full-int8", "wrong default");
    Check(PackageSpecs().size() == 4 && PackageSpecs()[0].id == DefaultPackageId(), "candidate duplication/order"); ++cases;
    Reject([] { FindPackageSpec("../../private"); });
    for (const auto& spec : PackageSpecs()) {
      Fixture fixture(spec); auto verified = fixture.Verify();
      Check(verified.files_verified && !verified.production_approval_declared && verified.model_version.size() == 74, "file/approval conflated");
      Check(verified.spec->vision.program == spec.vision.program && VerifyStillCurrent(verified), "program selection or held identities");
      const auto catalog = ModelCatalog(fixture.root.string());
      bool seen = false;
      for (const auto& item : catalog.at("items")) if (item.at("package_id") == spec.id) {
        Check(item.at("ready") == false && item.at("model_version").is_null(), "catalog fabricated readiness"); seen = true;
      }
      Check(seen, "valid package missing from catalog"); ++cases;
    }
    {
      Fixture fixture; fixture.Edit(true, [](auto& metadata) { metadata["family"] = "siglip2-base-patch16-256"; });
      Reject([&] { fixture.Verify(); });
      Check(ModelCatalog(fixture.root.string()).at("items").at(0).at("reason") == "model_package_invalid", "bad metadata disappeared");
    }
    for (const auto& mutation : std::vector<std::function<void(Json&)>>{
      [](auto& m) { m["target"] = "rdk_x5"; }, [](auto& m) { m["role"] = "text_embedding"; },
      [](auto& m) { m["schema_version"] = 1.0; }, [](auto& m) { m["hbm_file"] = "../outside.hbm"; },
      [](auto& m) { m["hbm_sha256"] = std::string(64, '0'); }, [](auto& m) { m["hbm_bytes"] = 1; },
      [](auto& m) { m["programs"]["pooler_output"]["outputs"][0]["shape"] = {1,1,768}; },
      [](auto& m) { m["programs"]["pooler_output"]["inputs"][0]["dtype"] = "S8"; },
      [](auto& m) { m["programs"]["pooler_output"]["inputs"][0]["name"] = "other"; },
      [](auto& m) { m["programs"].erase("pooler_output"); },
      [](auto& m) { m["production_approved"] = "true"; },
    }) {
      Fixture fixture; fixture.Edit(false, mutation); Reject([&] { fixture.Verify(); });
    }
    {
      Fixture fixture; fixture.Edit(true, [&](auto& m) { m["programs"][fixture.spec.text.program]["inputs"][0]["dtype"] = "S32"; });
      Reject([&] { fixture.Verify(); });
    }
    {
      Fixture fixture; Write(fixture.root / "hbm" / fixture.spec.text.file, "tampered"); Reject([&] { fixture.Verify(); });
    }
    {
      Fixture fixture; Write(fixture.root / "tokenizers" / fixture.spec.tokenizer, "tampered-tokenizer"); Reject([&] { fixture.Verify(); });
    }
    {
      Fixture fixture; auto first = fixture.Verify(); const auto old_version = first.model_version;
      Write(fixture.root / "tokenizers" / fixture.spec.tokenizer, "intentional-new-vocabulary"); fixture.Manifest();
      auto second = fixture.Verify(); Check(old_version != second.model_version && !VerifyStillCurrent(first), "tokenizer did not fence vector space"); ++cases;
    }
    {
      Fixture fixture(FindPackageSpec("siglip-so400m-i18n-pruned-int8")); auto first = fixture.Verify();
      Write(fixture.root / "tokenizers" / fixture.spec.tokenizer_auxiliary.front(), "new-mapping"); fixture.Manifest();
      auto second = fixture.Verify(); Check(first.model_version != second.model_version, "mapping missing from vector version"); ++cases;
      fs::remove(fixture.root / "tokenizers" / fixture.spec.tokenizer_auxiliary.front()); Reject([&] { fixture.Verify(); });
    }
    {
      Fixture fixture; for (bool text : {false, true}) fixture.Edit(text, [](auto& m) { m["accuracy_verified"] = true; m["production_approved"] = true; });
      auto verified = fixture.Verify(); Check(verified.production_approval_declared, "declaration not retained");
      const auto catalog = ModelCatalog(fixture.root.string());
      for (const auto& item : catalog.at("items")) Check(item.at("ready") == false, "metadata claims enabled inference");
      ++cases;
    }
    {
      Fixture fixture; const auto path = fixture.root / "hbm" / fixture.spec.vision.file;
      fs::rename(path, path.string() + ".original"); fs::create_symlink(path.string() + ".original", path); Reject([&] { fixture.Verify(); });
    }
    {
      Fixture fixture; fs::rename(fixture.root / "hbm", fixture.root / "real-hbm"); fs::create_directory_symlink("real-hbm", fixture.root / "hbm"); Reject([&] { fixture.Verify(); });
    }
    {
      Fixture fixture; auto alias = fixture.root / "alias"; fs::create_directory_symlink(fixture.root, alias);
      Reject([&] { VerifyPackageAtTrustedRoot(alias.string(), fixture.spec.id); });
      Reject([&] { VerifyPackageAtTrustedRoot(fixture.root.string() + "/../" + fixture.root.filename().string(), fixture.spec.id); });
    }
    {
      Fixture fixture; auto raw = Read(fixture.MetadataPath()); raw.insert(1, "\"target\":\"rdk_s100p\","); Write(fixture.MetadataPath(), raw); fixture.Manifest(); Reject([&] { fixture.Verify(); });
    }
    {
      Fixture fixture; Write(fixture.root / "SHA256SUMS.txt", std::string(64, 'a') + "  ../outside\n"); Reject([&] { fixture.Verify(); });
    }
    {
      Fixture fixture; auto verified = fixture.Verify(); const auto relative = "tokenizers/" + fixture.spec.tokenizer;
      const int stable = verified.BorrowedFileDescriptor(relative); const auto path = fixture.root / relative;
      std::thread replace([&] { Write(path.string() + ".new", "replacement"); fs::rename(path.string() + ".new", path); }); replace.join();
      Check(!VerifyStillCurrent(verified), "concurrent replacement accepted");
      char original = 0; Check(pread(stable, &original, 1, 0) == 1 && original == 't', "held FD followed replaced file"); ++cases;
    }
    {
      Fixture fixture; auto verified = fixture.Verify(); const auto path = fixture.root / "hbm" / fixture.spec.text.file;
      const auto size = fs::file_size(path); Write(path, std::string(size, 'x'));
      Check(!VerifyStillCurrent(verified), "same-inode rewrite accepted"); ++cases;
    }
    {
      Fixture fixture; auto verified = fixture.Verify(); fs::rename(fixture.root / "tokenizers", fixture.root / "old-tokenizers"); fs::create_directory(fixture.root / "tokenizers");
      Check(!VerifyStillCurrent(verified), "parent directory replacement accepted"); ++cases;
    }
    {
      int fd = -1; Fixture fixture;
      { auto verified = fixture.Verify(); fd = verified.BorrowedFileDescriptor("hbm/" + fixture.spec.vision.file);
        auto moved = std::move(verified); Check(fcntl(fd, F_GETFD) >= 0 && VerifyStillCurrent(moved), "move lost ownership"); }
      Check(fcntl(fd, F_GETFD) == -1 && errno == EBADF, "verified descriptor leaked"); ++cases;
    }
    std::cout << "model package: " << cases << " checks passed (small fixtures only; no BPU/model loading)\n";
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
