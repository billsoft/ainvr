#include "index_shard_files.hpp"
#include <nlohmann/json.hpp>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <algorithm>
#include <array>
#include <cerrno>
#include <cstring>
#include <ctime>
#include <dirent.h>
#include <fcntl.h>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <limits>
#include <mutex>
#include <numeric>
#include <regex>
#include <sstream>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <unistd.h>

namespace ainvr::search {
namespace {
using Json = nlohmann::json;
constexpr uint64_t kSafeInteger = 9007199254740991ULL;
constexpr size_t kManifestLimit = 65536, kMetadataLimit = 4096;
constexpr unsigned char kMagic[8] = {'A','I','N','V','R','S','H','1'};
static_assert(sizeof(float) == 4 && std::numeric_limits<float>::is_iec559, "F32LE needs IEEE float32");
struct CloseDirectory { void operator()(DIR* directory) const { if (directory) closedir(directory); } };
[[noreturn]] void Fail(const char* code) { throw std::runtime_error(code); }
class Fd {
 public:
  explicit Fd(int fd = -1) : fd_(fd) {}
  ~Fd() { if (fd_ >= 0) close(fd_); }
  Fd(Fd&& other) noexcept : fd_(other.fd_) { other.fd_ = -1; }
  Fd& operator=(Fd&& other) noexcept { if (this != &other) { if (fd_ >= 0) close(fd_); fd_ = other.fd_; other.fd_ = -1; } return *this; }
  Fd(const Fd&) = delete; Fd& operator=(const Fd&) = delete;
  int get() const { return fd_; }
 private: int fd_;
};
bool Hex(char c){return(c>='0'&&c<='9')||(c>='a'&&c<='f');}
bool HashString(const std::string& value) { return value.size()==64&&std::all_of(value.begin(),value.end(),Hex); }
bool Uuid(const std::string& value) {
  if(value.size()!=36)return false;
  for(size_t i=0;i<value.size();++i){
    if(i==8||i==13||i==18||i==23){if(value[i]!='-')return false;}
    else if(!Hex(value[i]))return false;
  }
  return true;
}
bool Controls(const std::string& value) {
  for (const unsigned char c : value) if (c < 32 || c == 127) return true;
  return false;
}
std::vector<std::string> Parts(const std::string& path, bool absolute) {
  if (path.empty() || path.size() > (absolute ? 4096U : 1024U) || Controls(path) ||
      (path.front() == '/') != absolute || path.back() == '/') Fail("search_index_path_invalid");
  std::vector<std::string> result; size_t at = absolute ? 1 : 0;
  while (at < path.size()) {
    const auto end = path.find('/', at); const auto part = path.substr(at, end - at);
    if (part.empty() || part == "." || part == ".." || part.size() > 255) Fail("search_index_path_invalid");
    result.push_back(part); if (end == std::string::npos) break; at = end + 1;
  }
  if (result.empty()) Fail("search_index_path_invalid");
  return result;
}
struct stat Stat(int fd) { struct stat out{}; if (fstat(fd, &out)) Fail("search_index_storage_unavailable"); return out; }
bool Same(const struct stat& a, const struct stat& b) {
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_size == b.st_size &&
    a.st_mtim.tv_sec == b.st_mtim.tv_sec && a.st_mtim.tv_nsec == b.st_mtim.tv_nsec &&
    a.st_ctim.tv_sec == b.st_ctim.tv_sec && a.st_ctim.tv_nsec == b.st_ctim.tv_nsec;
}
void Sync(int fd) { if (fsync(fd)) Fail("search_index_sync_failed"); }
Fd Absolute(const std::string& path) {
  Fd current(open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
  if (current.get() < 0) Fail("search_index_storage_unavailable");
  for (const auto& part : Parts(path, true)) {
    Fd next(openat(current.get(), part.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    if (next.get() < 0) Fail("search_index_storage_unavailable");
    current = std::move(next);
  }
  return current;
}
Fd Child(int parent, const std::string& name, dev_t device, bool create, bool private_directory = true) {
  bool created = false;
  if (create) {
    if (mkdirat(parent, name.c_str(), 0700) == 0) created = true;
    else if (errno != EEXIST) Fail("search_index_storage_unavailable");
  }
  Fd child(openat(parent, name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  if (child.get() < 0) Fail("search_index_storage_unavailable");
  const auto st = Stat(child.get());
  if (st.st_dev != device || !S_ISDIR(st.st_mode) ||
      (private_directory && (st.st_uid != geteuid() || (st.st_mode & 0777) != 0700)))
    Fail("search_index_storage_identity_mismatch");
  if (created) Sync(parent);
  return child;
}
std::string Hex(const unsigned char* value, size_t bytes) {
  std::ostringstream out; out << std::hex << std::setfill('0');
  for (size_t i = 0; i < bytes; ++i) out << std::setw(2) << unsigned(value[i]);
  return out.str();
}
class Digest {
 public:
  Digest() : ctx_(EVP_MD_CTX_new(), EVP_MD_CTX_free) {
    if (!ctx_ || EVP_DigestInit_ex(ctx_.get(), EVP_sha256(), nullptr) != 1) Fail("search_index_hash_failed");
  }
  void Add(const void* bytes, size_t count) { if (EVP_DigestUpdate(ctx_.get(), bytes, count) != 1) Fail("search_index_hash_failed"); }
  std::string Finish() {
    unsigned char hash[EVP_MAX_MD_SIZE]; unsigned int size = 0;
    if (EVP_DigestFinal_ex(ctx_.get(), hash, &size) != 1) Fail("search_index_hash_failed");
    return Hex(hash, size);
  }
 private: std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> ctx_;
};
std::string Sha(const std::string& bytes) { Digest digest; digest.Add(bytes.data(), bytes.size()); return digest.Finish(); }
std::string Nonce() { unsigned char bytes[8]; if (RAND_bytes(bytes, 8) != 1) Fail("search_index_random_failed"); return Hex(bytes, 8); }
void WriteAll(int fd, const void* bytes, size_t count) {
  const auto* at = static_cast<const unsigned char*>(bytes);
  while (count) {
    const auto n = write(fd, at, count); if (n < 0 && errno == EINTR) continue;
    if (n <= 0) Fail("search_index_write_failed");
    at += n; count -= size_t(n);
  }
}
void ReadAll(int fd, uint64_t& offset, void* bytes, size_t count, uint64_t total) {
  if (offset > total || count > total - offset) Fail("search_index_file_invalid");
  auto* at = static_cast<unsigned char*>(bytes);
  while (count) {
    const auto n = pread(fd, at, count, off_t(offset)); if (n < 0 && errno == EINTR) continue;
    if (n <= 0) Fail("search_index_read_failed");
    at += n; count -= size_t(n); offset += uint64_t(n);
  }
}
Fd Regular(int parent, const std::string& name, dev_t device, uint64_t maximum) {
  Fd file(openat(parent, name.c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC));
  if (file.get() < 0) Fail("search_index_file_unavailable");
  const auto st = Stat(file.get());
  if (st.st_dev != device || !S_ISREG(st.st_mode) || st.st_nlink != 1 || st.st_uid != geteuid() ||
      st.st_size < 0 || uint64_t(st.st_size) > maximum || (st.st_mode & 0022)) Fail("search_index_file_invalid");
  return file;
}
std::string FileSha(int fd, uint64_t expected) {
  const auto before = Stat(fd); if (before.st_size < 0 || uint64_t(before.st_size) != expected) Fail("search_index_file_invalid");
  Digest digest; std::array<unsigned char, 65536> buffer{}; uint64_t offset = 0;
  while (offset < expected) {
    const auto bytes = size_t(std::min<uint64_t>(buffer.size(), expected - offset));
    ReadAll(fd, offset, buffer.data(), bytes, expected); digest.Add(buffer.data(), bytes);
  }
  if (!Same(before, Stat(fd))) Fail("search_index_file_changed");
  return digest.Finish();
}
std::string FileText(int fd, uint64_t maximum) {
  const auto before = Stat(fd); if (before.st_size <= 0 || uint64_t(before.st_size) > maximum) Fail("search_index_file_invalid");
  std::string out(size_t(before.st_size), '\0'); uint64_t at = 0; ReadAll(fd, at, out.data(), out.size(), out.size());
  if (!Same(before, Stat(fd))) Fail("search_index_file_changed");
  return out;
}
Json Parse(const std::string& bytes) {
  std::vector<std::set<std::string>> keys;
  try {
    return Json::parse(bytes, [&](int depth, Json::parse_event_t event, Json& value) {
      if (depth > 8) Fail("search_index_file_invalid");
      if (event == Json::parse_event_t::object_start) keys.emplace_back();
      if (event == Json::parse_event_t::key && (keys.empty() || !keys.back().insert(value.get<std::string>()).second)) Fail("search_index_file_invalid");
      if (event == Json::parse_event_t::object_end) keys.pop_back();
      return true;
    });
  } catch (const Json::exception&) { Fail("search_index_file_invalid"); }
}
int64_t DayStart(const std::string& day) {
  if (!std::regex_match(day, std::regex("[0-9]{4}-[0-9]{2}-[0-9]{2}"))) Fail("search_index_day_invalid");
  std::tm parsed{}; std::istringstream input(day); input >> std::get_time(&parsed, "%Y-%m-%d");
  if (input.fail()) Fail("search_index_day_invalid");
  const auto utc = timegm(&parsed);
  std::tm back{}; char canonical[11]{};
  if (utc < 0 || !gmtime_r(&utc, &back) || !strftime(canonical, sizeof(canonical), "%Y-%m-%d", &back) || day != canonical)
    Fail("search_index_day_invalid");
  return int64_t(utc) * 1000;
}
void KeyIdentity(const IndexShardIdentity& value) {
  if (!Uuid(value.id) || !Uuid(value.channel_id) || !value.revision || value.revision > kSafeInteger ||
      !std::regex_match(value.model_version, std::regex("[a-zA-Z0-9_.:-]{1,128}")) ||
      !HashString(value.storage_generation)) Fail("search_index_identity_invalid");
  (void)DayStart(value.utc_day);
}
void Identity(const IndexShardIdentity& value) {
  KeyIdentity(value);
  if(value.dimensions==0||value.dimensions>4096||value.checkpoint<0||uint64_t(value.checkpoint)>kSafeInteger)
    Fail("search_index_identity_invalid");
}
std::string Base(const IndexShardIdentity& value) { Identity(value); return std::to_string(value.revision); }
Json Metadata(const Record& record, const IndexShardIdentity& identity) {
  const auto start = DayStart(identity.utc_day);
  for (const auto* value : {&record.id, &record.channel, &record.processor, &record.session, &record.track})
    if (value->size() > 256 || Controls(*value)) Fail("search_index_record_invalid");
  if (record.id.empty() || record.channel != identity.channel_id || record.model != identity.model_version ||
      record.captured_ms < start || record.captured_ms >= start + 86400000 ||
      (!record.scene && (record.processor.empty() || record.session.empty() || record.track.empty())) ||
      !HashString(record.fingerprint)) Fail("search_index_record_invalid");
  return {{"id",record.id},{"channel",record.channel},{"processor",record.processor},{"session",record.session},
    {"track",record.track},{"model",record.model},{"captured_ms",record.captured_ms},{"scene",record.scene},{"fingerprint",record.fingerprint}};
}
std::string Unescape(const std::string& value) {
  std::string out;
  for (size_t i = 0; i < value.size(); ++i) {
    if (value[i] != '\\') { out += value[i]; continue; }
    if (i + 3 >= value.size()) Fail("search_index_mount_unverified");
    unsigned int cp = 0;
    for (size_t k = 1; k <= 3; ++k) { if (value[i+k] < '0' || value[i+k] > '7') Fail("search_index_mount_unverified"); cp = cp*8 + unsigned(value[i+k]-'0'); }
    out += char(cp); i += 3;
  }
  return out;
}
struct Mount { std::string id, path, source, filesystem; dev_t device = 0; };
Mount InspectMount(const IndexStorageAuthorization& authorization) {
  Parts(authorization.relative_path, false); Parts(authorization.resolved_path, true);
  if (authorization.volume_id.empty() || authorization.volume_id.size() > 128 || Controls(authorization.volume_id) ||
      !HashString(authorization.generation)) Fail("search_index_storage_identity_mismatch");
  const auto suffix = "/" + authorization.relative_path;
  if (authorization.resolved_path.size() <= suffix.size() ||
      authorization.resolved_path.compare(authorization.resolved_path.size()-suffix.size(), suffix.size(), suffix)) Fail("search_index_storage_identity_mismatch");
  const auto mount = authorization.resolved_path.substr(0, authorization.resolved_path.size()-suffix.size());
  if (mount.rfind("/mnt/",0) && mount.rfind("/media/",0) && mount.rfind("/run/media/",0)) Fail("search_index_mount_unverified");
  std::ifstream file("/proc/self/mountinfo"); std::string line; Mount found; size_t lines = 0, bytes = 0, matches = 0;
  while (std::getline(file,line)) {
    bytes += line.size(); if (++lines > 4096 || bytes > 1024*1024 || line.size() > 8192) Fail("search_index_mount_unverified");
    std::istringstream row(line); std::string id,parent,dev,root,path,options,value; row >> id >> parent >> dev >> root >> path >> options;
    if (Unescape(path) != mount) continue;
    while (row >> value && value != "-") {}
    std::string fs,source,super; if (value != "-" || !(row >> fs >> source >> super)) Fail("search_index_mount_unverified");
    if (Unescape(root) != "/" || (","+options+",").find(",ro,") != std::string::npos ||
        (","+super+",").find(",ro,") != std::string::npos) Fail("search_index_mount_unverified");
    const auto colon = dev.find(':'); if (colon == std::string::npos) Fail("search_index_mount_unverified");
    try { found = {id,mount,Unescape(source),fs,makedev(std::stoul(dev.substr(0,colon)),std::stoul(dev.substr(colon+1)))}; }
    catch (...) { Fail("search_index_mount_unverified"); }
    ++matches;
  }
  if (!file.eof() || matches != 1) Fail("search_index_mount_unverified");
  // No UUID format guess: match the actual udev filename exactly and prove its
  // block device. If this namespace is unavailable, production stays closed.
  DIR* raw = opendir("/dev/disk/by-uuid"); if (!raw) Fail("search_index_mount_unverified");
  std::unique_ptr<DIR,CloseDirectory> directory(raw); size_t count = 0; std::string device;
  errno = 0;
  while (auto* entry = readdir(directory.get())) {
    if (++count > 512) Fail("search_index_mount_unverified");
    if (authorization.volume_id == entry->d_name) {
      try { device = std::filesystem::canonical(std::string("/dev/disk/by-uuid/")+entry->d_name).string(); }
      catch (...) { Fail("search_index_mount_unverified"); }
    }
    errno = 0;
  }
  if (errno) Fail("search_index_mount_unverified");
  struct stat block{}, system{};
  if (device.empty() || stat(device.c_str(),&block) || !S_ISBLK(block.st_mode) || block.st_rdev != found.device ||
      stat("/",&system) || found.device == system.st_dev) Fail("search_index_storage_identity_mismatch");
  try { if (std::filesystem::canonical(found.source).string() != device) Fail("search_index_storage_identity_mismatch"); }
  catch (...) { Fail("search_index_storage_identity_mismatch"); }
  if (Sha(Json::array({authorization.volume_id,device,found.filesystem,mount,authorization.relative_path,authorization.resolved_path}).dump()) != authorization.generation)
    Fail("search_index_storage_identity_mismatch");
  return found;
}
}  // namespace

namespace {
using Sink = std::function<void(const void*, size_t)>;
void Integer(const Sink& sink, uint64_t value, size_t bytes) {
  unsigned char data[8]{};
  for (size_t i = 0; i < bytes; ++i) data[i] = (value >> (8*i)) & 255;
  sink(data, bytes);
}
uint64_t ReadInteger(int fd, uint64_t& offset, size_t bytes, uint64_t total) {
  unsigned char data[8]{}; ReadAll(fd, offset, data, bytes, total); uint64_t result = 0;
  for (size_t i = 0; i < bytes; ++i) result |= uint64_t(data[i]) << (8*i);
  return result;
}
void Emit(const IndexShardIdentity& identity, const std::vector<Record>& records,
          const std::vector<size_t>& order, const Sink& sink) {
  sink(kMagic, sizeof(kMagic)); Integer(sink, 1, 4); Integer(sink, identity.dimensions, 4); Integer(sink, records.size(), 8);
  for (const auto index : order) {
    const auto& record = records[index];
    std::string metadata;
    try { metadata = Metadata(record, identity).dump(); }
    catch (const Json::exception&) { Fail("search_index_record_invalid"); }
    if (metadata.size() > kMetadataLimit) Fail("search_index_record_invalid");
    std::vector<float> normalized;
    try { normalized = NormalizeVector(record.vector, identity.dimensions); }
    catch (...) { Fail("search_index_record_invalid"); }
    Integer(sink, metadata.size(), 4); sink(metadata.data(), metadata.size());
    std::vector<unsigned char> bytes(normalized.size()*4);
    for (size_t i = 0; i < normalized.size(); ++i) {
      uint32_t bits; static_assert(sizeof(bits) == sizeof(float)); std::memcpy(&bits, &normalized[i], sizeof(bits));
      for (size_t k = 0; k < 4; ++k) bytes[i*4+k] = (bits >> (8*k)) & 255;
    }
    sink(bytes.data(), bytes.size());
  }
}
class IoLock {
 public:
  explicit IoLock(int fd) : fd_(fd) { if (flock(fd_, LOCK_EX | LOCK_NB)) Fail("search_index_busy"); }
  ~IoLock() { flock(fd_, LOCK_UN); }
 private: int fd_;
};
class Temporary {
 public:
  Temporary(int directory, std::string label) : directory_(directory), name_(".tmp-"+std::move(label)+"-"+Nonce()),
      file_(openat(directory_,name_.c_str(),O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600)) {
    if (file_.get() < 0) Fail("search_index_temporary_unavailable");
  }
  ~Temporary() { if (!name_.empty()) unlinkat(directory_,name_.c_str(),0); }
  int get() const { return file_.get(); }
  void Commit(const std::string& final) {
    if (syscall(SYS_renameat2,directory_,name_.c_str(),directory_,final.c_str(),1U) == 0) {
      name_.clear(); return;
    }
    if (errno == EEXIST) Fail("search_index_revision_conflict");
    if (errno != ENOSYS && errno != EINVAL && errno != EOPNOTSUPP) Fail("search_index_publish_failed");
    // linkat provides atomic NOREPLACE even on kernels lacking renameat2. The
    // brief second link is removed before publication; crash leftovers are
    // cleaned under the same IO lock before any load accepts link counts.
    if (linkat(directory_,name_.c_str(),directory_,final.c_str(),0)) {
      if (errno == EEXIST) Fail("search_index_revision_conflict");
      Fail("search_index_atomic_publish_unsupported");
    }
    if (unlinkat(directory_,name_.c_str(),0)) Fail("search_index_publish_failed");
    name_.clear();
  }
 private:
  int directory_;
  std::string name_;
  Fd file_;
};
void Commit(Temporary& temporary, int directory, const std::string& final) {
  (void)directory;
  temporary.Commit(final);
}
struct Usage { size_t files = 0; uint64_t bytes = 0; };
std::vector<std::string> Names(int fd) {
  Fd copy(openat(fd,".",O_RDONLY|O_DIRECTORY|O_CLOEXEC));
  if (copy.get() < 0) Fail("search_index_storage_unavailable");
  const int duplicate = fcntl(copy.get(),F_DUPFD_CLOEXEC,0);
  if (duplicate < 0) Fail("search_index_storage_unavailable");
  DIR* raw = fdopendir(duplicate);
  if (!raw) { close(duplicate); Fail("search_index_storage_unavailable"); }
  std::unique_ptr<DIR,CloseDirectory> entries(raw); std::vector<std::string> names;
  errno = 0;
  while (auto* entry = readdir(entries.get())) {
    const std::string name = entry->d_name;
    if (name == "." || name == "..") continue;
    if (names.size() >= 65554) Fail("search_index_file_capacity");
    names.push_back(name); errno = 0;
  }
  if (errno) Fail("search_index_storage_unavailable");
  return names;
}
}  // namespace

struct IndexShardFiles::Impl {
  IndexStorageAuthorization authorization;
  IndexShardFileLimits limits;
  bool testing = false;
  bool owner_ready = false;
  Mount mount;
  Fd root, writer;
  struct stat root_identity{};
  std::mutex mutex;

  void Initialize() {
    if (limits.max_total_bytes < 1024 || limits.max_total_bytes > 1099511627776ULL ||
        limits.max_shard_bytes < 24 || limits.max_shard_bytes > limits.max_total_bytes ||
        limits.max_files < 5 || limits.max_files > 65536 || limits.max_records == 0 || limits.max_records > 1000000 ||
        limits.max_temporary_files < 2 || limits.max_temporary_files > 16 ||
        limits.max_temporary_bytes < 1024 || limits.max_temporary_bytes > 1099511627776ULL) Fail("invalid_search_index_file_limits");
    root_identity = Stat(root.get());
    if (!S_ISDIR(root_identity.st_mode) || root_identity.st_uid != geteuid() || (root_identity.st_mode & 0777) != 0700)
      Fail("search_index_root_not_private");
    writer = Fd(openat(root.get(),".writer.lock",O_RDWR|O_CREAT|O_NOFOLLOW|O_CLOEXEC,0600));
    if (writer.get() < 0) Fail("search_index_storage_unavailable");
    const auto st = Stat(writer.get());
    if (!S_ISREG(st.st_mode) || st.st_dev != root_identity.st_dev || st.st_uid != geteuid() || st.st_nlink != 1 || (st.st_mode & 0077))
      Fail("search_index_file_invalid");
    IoLock lock(writer.get()); Current(); Owner(); owner_ready = true; (void)Scan(true); Current();
  }

  void Current() const {
    if (!testing) {
      const auto actual = InspectMount(authorization);
      if (actual.id != mount.id || actual.device != mount.device || actual.path != mount.path || actual.filesystem != mount.filesystem)
        Fail("search_index_storage_identity_mismatch");
    }
    auto actual = Absolute(authorization.resolved_path); const auto st = Stat(actual.get());
    if (st.st_dev != root_identity.st_dev || st.st_ino != root_identity.st_ino || st.st_uid != geteuid() ||
        (st.st_mode & 0777) != 0700) Fail("search_index_storage_identity_mismatch");
    auto named_lock = Regular(root.get(),".writer.lock",root_identity.st_dev,1024);
    const auto named = Stat(named_lock.get()), held = Stat(writer.get());
    if (named.st_dev != held.st_dev || named.st_ino != held.st_ino || held.st_nlink != 1)
      Fail("search_index_writer_identity_mismatch");
    if (owner_ready) {
      const Json expected{{"schema_version",1},{"kind","ainvr-search-index"},{"volume_id",authorization.volume_id},{"test_only",testing}};
      auto marker = Regular(root.get(),".owner.json",root_identity.st_dev,1024);
      if (Parse(FileText(marker.get(),1024)) != expected) Fail("search_index_owner_mismatch");
    }
  }
  void Check(const IndexShardIdentity& identity, bool current_generation = true) const {
    Identity(identity);
    if (current_generation && identity.storage_generation != authorization.generation) Fail("search_index_storage_generation_mismatch");
  }
  void Owner() {
    const Json expected{{"schema_version",1},{"kind","ainvr-search-index"},{"volume_id",authorization.volume_id},{"test_only",testing}};
    for (const auto& name : Names(root.get())) if (std::regex_match(name,std::regex("\\.tmp-owner-[a-f0-9]{16}"))) {
      struct stat orphan{};
      if (fstatat(root.get(),name.c_str(),&orphan,AT_SYMLINK_NOFOLLOW) || !S_ISREG(orphan.st_mode) ||
          orphan.st_dev != root_identity.st_dev || orphan.st_uid != geteuid() || orphan.st_nlink > 2 ||
          unlinkat(root.get(),name.c_str(),0)) Fail("search_index_temporary_cleanup_failed");
    }
    struct stat st{};
    if (!fstatat(root.get(),".owner.json",&st,AT_SYMLINK_NOFOLLOW)) {
      auto marker = Regular(root.get(),".owner.json",root_identity.st_dev,1024);
      if (Parse(FileText(marker.get(),1024)) != expected) Fail("search_index_owner_mismatch");
      return;
    }
    if (errno != ENOENT) Fail("search_index_storage_unavailable");
    for (const auto& name : Names(root.get())) {
      if (name == ".writer.lock") continue;
      if (!std::regex_match(name,std::regex("\\.tmp-owner-[a-f0-9]{16}"))) Fail("search_index_root_not_private");
      auto file = Regular(root.get(),name,root_identity.st_dev,1024);
      if (unlinkat(root.get(),name.c_str(),0)) Fail("search_index_temporary_cleanup_failed");
    }
    Temporary marker(root.get(),"owner"); const auto text = expected.dump();
    WriteAll(marker.get(),text.data(),text.size()); Sync(marker.get()); Commit(marker,root.get(),".owner.json"); Sync(root.get());
  }
  Usage Scan(bool cleanup) {
    Usage usage; size_t visited = 0;
    auto account = [&](const struct stat& st) {
      if (++usage.files > 65554 || st.st_dev != root_identity.st_dev || st.st_uid != geteuid()) Fail("search_index_file_capacity");
      if (S_ISREG(st.st_mode)) {
        if (st.st_size < 0 || uint64_t(st.st_size) > (1099511627776ULL - usage.bytes)) Fail("search_index_byte_capacity");
        usage.bytes += uint64_t(st.st_size);
      }
    };
    for (const auto& name : Names(root.get())) {
      if (++visited > 65554) Fail("search_index_file_capacity");
      struct stat st{}; if (fstatat(root.get(),name.c_str(),&st,AT_SYMLINK_NOFOLLOW)) Fail("search_index_storage_unavailable");
      if (name == ".writer.lock" || name == ".owner.json") {
        auto file = Regular(root.get(),name,root_identity.st_dev,1024); account(st); continue;
      }
      if (!Uuid(name) || !S_ISDIR(st.st_mode)) Fail("search_index_file_invalid");
      auto shard = Child(root.get(),name,root_identity.st_dev,false); account(st);
      const auto children = Names(shard.get());
      if (children.size() > 65554-visited) Fail("search_index_file_capacity");
      visited += children.size();
      if (cleanup) for (const auto& orphan : children) {
        if (!std::regex_match(orphan,std::regex("\\.tmp-[1-9][0-9]{0,15}-(?:data|manifest)-[a-f0-9]{16}"))) continue;
        struct stat old{};
        if (fstatat(shard.get(),orphan.c_str(),&old,AT_SYMLINK_NOFOLLOW) || !S_ISREG(old.st_mode) ||
            old.st_dev != root_identity.st_dev || old.st_uid != geteuid() || old.st_nlink > 2 ||
            unlinkat(shard.get(),orphan.c_str(),0)) Fail("search_index_temporary_cleanup_failed");
      }
      size_t surviving = 0;
      for (const auto& child : children) {
        if (cleanup && std::regex_match(child,std::regex("\\.tmp-[1-9][0-9]{0,15}-(?:data|manifest)-[a-f0-9]{16}"))) continue;
        if (fstatat(shard.get(),child.c_str(),&st,AT_SYMLINK_NOFOLLOW) || !S_ISREG(st.st_mode) ||
            st.st_dev != root_identity.st_dev || st.st_uid != geteuid() || (st.st_mode & 0022)) Fail("search_index_file_invalid");
        const bool temporary = std::regex_match(child,std::regex("\\.tmp-[1-9][0-9]{0,15}-(?:data|manifest)-[a-f0-9]{16}"));
        if (temporary && cleanup) {
          if (unlinkat(shard.get(),child.c_str(),0)) Fail("search_index_temporary_cleanup_failed");
          continue;
        }
        if (temporary || !std::regex_match(child,std::regex("[1-9][0-9]{0,15}\\.(?:records\\.f32le|manifest\\.json)")) || st.st_nlink != 1)
          Fail("search_index_file_invalid");
        account(st);
        ++surviving;
      }
      if (cleanup) Sync(shard.get());
      if (cleanup && !surviving) {
        if (unlinkat(root.get(),name.c_str(),AT_REMOVEDIR)) Fail("search_index_temporary_cleanup_failed");
        --usage.files; Sync(root.get());
      }
    }
    return usage;
  }
  Json Manifest(const IndexShardIdentity& identity, uint64_t count, uint64_t bytes, const std::string& hash) const {
    return {{"schema_version",1},{"shard_id",identity.id},{"revision",identity.revision},{"channel_id",identity.channel_id},
      {"model_version",identity.model_version},{"utc_day",identity.utc_day},{"dimensions",identity.dimensions},
      {"checkpoint",identity.checkpoint},{"storage_generation",identity.storage_generation},{"volume_id",authorization.volume_id},
      {"record_count",count},{"dtype","F32LE"},{"normalization","l2-f32-v1"},
      {"data",{{"file",Base(identity)+".records.f32le"},{"bytes",bytes},{"sha256",hash}}}};
  }
  struct Validated {
    Fd data;
    uint64_t bytes = 0, count = 0;
    struct stat identity{};
  };
  Validated Verify(int directory, const IndexShardIdentity& identity, const ShardPublication& publication) const {
    if (publication.manifest_key != identity.id+"/"+Base(identity)+".manifest.json" || !HashString(publication.manifest_sha256) ||
        publication.checkpoint != identity.checkpoint) Fail("search_index_publication_invalid");
    auto manifest = Regular(directory,Base(identity)+".manifest.json",root_identity.st_dev,kManifestLimit);
    const auto raw = FileText(manifest.get(),kManifestLimit);
    if (Sha(raw) != publication.manifest_sha256) Fail("search_index_manifest_hash_mismatch");
    const auto parsed = Parse(raw);
    uint64_t bytes = 0, count = 0; std::string hash;
    try {
      if (!parsed.at("data").at("bytes").is_number_unsigned() || !parsed.at("record_count").is_number_unsigned()) Fail("search_index_file_invalid");
      bytes = parsed.at("data").at("bytes").get<uint64_t>(); count = parsed.at("record_count").get<uint64_t>();
      hash = parsed.at("data").at("sha256").get<std::string>();
      if (bytes < 24 || bytes > limits.max_shard_bytes || count > limits.max_records ||
          count > 64000000ULL/identity.dimensions || !HashString(hash) ||
          raw != Manifest(identity,count,bytes,hash).dump() || count != publication.record_count ||
          bytes+raw.size() != publication.byte_count) Fail("search_index_manifest_invalid");
    } catch (const Json::exception&) { Fail("search_index_manifest_invalid"); }
    auto data = Regular(directory,Base(identity)+".records.f32le",root_identity.st_dev,limits.max_shard_bytes);
    if (FileSha(data.get(),bytes) != hash) Fail("search_index_data_hash_mismatch");
    const auto st = Stat(data.get()); return {std::move(data),bytes,count,st};
  }
};

IndexShardFiles::IndexShardFiles(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {}
IndexShardFiles::~IndexShardFiles() = default;
std::unique_ptr<IndexShardFiles> IndexShardFiles::OpenProduction(const IndexStorageAuthorization& authorization,
                                                              IndexShardFileLimits limits) {
  auto impl = std::make_unique<Impl>(); impl->authorization = authorization; impl->limits = limits;
  impl->mount = InspectMount(authorization); auto current = Absolute(impl->mount.path);
  if (Stat(current.get()).st_dev != impl->mount.device) Fail("search_index_storage_identity_mismatch");
  const auto parts = Parts(authorization.relative_path,false);
  for (size_t i = 0; i < parts.size(); ++i)
    current = Child(current.get(),parts[i],impl->mount.device,true,i+1 == parts.size());
  impl->root = std::move(current); impl->Initialize();
  return std::unique_ptr<IndexShardFiles>(new IndexShardFiles(std::move(impl)));
}
#ifdef AINVR_SHARD_FILES_TESTING
std::unique_ptr<IndexShardFiles> IndexShardFiles::OpenForTesting(const std::string& directory, IndexShardFileLimits limits) {
  auto impl = std::make_unique<Impl>(); impl->testing = true; impl->limits = limits;
  impl->authorization = {"test-only","private-index",directory,Sha(Json::array({"test-only",directory}).dump())};
  impl->root = Absolute(directory); impl->Initialize();
  return std::unique_ptr<IndexShardFiles>(new IndexShardFiles(std::move(impl)));
}
#endif
const std::string& IndexShardFiles::StorageGeneration() const { return impl_->authorization.generation; }
std::string IndexShardFiles::ManifestKey(const IndexShardIdentity& identity) {
  return identity.id+"/"+Base(identity)+".manifest.json";
}
ShardPublication IndexShardFiles::Publish(const IndexShardIdentity& identity, const std::vector<Record>& records) {
  std::unique_lock<std::mutex> serial(impl_->mutex,std::try_to_lock);
  if (!serial.owns_lock()) Fail("search_index_busy");
  IoLock io(impl_->writer.get()); impl_->Current(); impl_->Check(identity);
  if (records.size() > impl_->limits.max_records || records.size() > 64000000ULL/identity.dimensions)
    Fail("search_index_record_capacity");
  std::vector<size_t> order(records.size()); std::iota(order.begin(),order.end(),0);
  for (const auto& record : records) if (record.id.empty() || record.id.size() > 256) Fail("search_index_record_invalid");
  std::sort(order.begin(),order.end(),[&](size_t a,size_t b) { return records[a].id < records[b].id; });
  for (size_t i = 1; i < order.size(); ++i) if (records[order[i-1]].id == records[order[i]].id) Fail("search_index_duplicate_record");
  uint64_t bytes = 0; Digest expected;
  Emit(identity,records,order,[&](const void* data,size_t count) {
    if (count > impl_->limits.max_shard_bytes - bytes) Fail("search_index_byte_capacity");
    bytes += count; expected.Add(data,count);
  });
  const auto hash = expected.Finish(); const auto manifest = impl_->Manifest(identity,records.size(),bytes,hash).dump();
  if (manifest.size() > kManifestLimit) Fail("search_index_manifest_invalid");
  ShardPublication publication{ManifestKey(identity),Sha(manifest),identity.checkpoint,records.size(),bytes+manifest.size()};
  auto usage = impl_->Scan(true); const auto base = Base(identity);
  struct stat st{}; const bool new_directory = fstatat(impl_->root.get(),identity.id.c_str(),&st,AT_SYMLINK_NOFOLLOW) != 0;
  if (new_directory && errno != ENOENT) Fail("search_index_storage_unavailable");
  Fd directory;
  bool existing_data = false;
  if (!new_directory) {
    directory = Child(impl_->root.get(),identity.id,impl_->root_identity.st_dev,false);
    if (!fstatat(directory.get(),(base+".manifest.json").c_str(),&st,AT_SYMLINK_NOFOLLOW)) {
      (void)impl_->Verify(directory.get(),identity,publication); impl_->Current(); return publication;
    }
    if (errno != ENOENT) Fail("search_index_storage_unavailable");
    if (!fstatat(directory.get(),(base+".records.f32le").c_str(),&st,AT_SYMLINK_NOFOLLOW)) {
      auto file = Regular(directory.get(),base+".records.f32le",impl_->root_identity.st_dev,impl_->limits.max_shard_bytes);
      if (FileSha(file.get(),bytes) != hash) Fail("search_index_revision_conflict");
      existing_data = true;
    } else if (errno != ENOENT) Fail("search_index_storage_unavailable");
  }
  const uint64_t added_bytes = (existing_data ? 0 : bytes) + manifest.size();
  const size_t added_files = (new_directory ? 1 : 0) + (existing_data ? 1 : 2);
  if (usage.files > impl_->limits.max_files || added_files > impl_->limits.max_files - usage.files ||
      usage.bytes > impl_->limits.max_total_bytes || added_bytes > impl_->limits.max_total_bytes - usage.bytes ||
      added_bytes > impl_->limits.max_temporary_bytes) Fail("search_index_file_quota");
  if (new_directory) { directory = Child(impl_->root.get(),identity.id,impl_->root_identity.st_dev,true); Sync(impl_->root.get()); }
  std::unique_ptr<Temporary> data;
  if (!existing_data) {
    data = std::make_unique<Temporary>(directory.get(),base+"-data"); Digest actual; uint64_t written = 0;
    Emit(identity,records,order,[&](const void* source,size_t count) {
      if (count > bytes-written) Fail("search_index_record_changed");
      WriteAll(data->get(),source,count); actual.Add(source,count); written += count;
    });
    if (written != bytes || actual.Finish() != hash) Fail("search_index_record_changed");
    Sync(data->get());
  }
  Temporary pending(directory.get(),base+"-manifest"); WriteAll(pending.get(),manifest.data(),manifest.size()); Sync(pending.get());
  impl_->Current();
  if (data) { Commit(*data,directory.get(),base+".records.f32le"); Sync(directory.get()); }
  Commit(pending,directory.get(),base+".manifest.json"); Sync(directory.get()); impl_->Current();
  return publication;
}
std::vector<Record> IndexShardFiles::Load(const IndexShardIdentity& identity, const ShardPublication& publication) {
  std::unique_lock<std::mutex> serial(impl_->mutex,std::try_to_lock);
  if (!serial.owns_lock()) Fail("search_index_busy");
  IoLock io(impl_->writer.get()); impl_->Current(); impl_->Check(identity); (void)impl_->Scan(true);
  auto directory = Child(impl_->root.get(),identity.id,impl_->root_identity.st_dev,false);
  auto file = impl_->Verify(directory.get(),identity,publication); uint64_t at = 0;
  unsigned char magic[8]; ReadAll(file.data.get(),at,magic,sizeof(magic),file.bytes);
  if (std::memcmp(magic,kMagic,8) || ReadInteger(file.data.get(),at,4,file.bytes) != 1 ||
      ReadInteger(file.data.get(),at,4,file.bytes) != identity.dimensions || ReadInteger(file.data.get(),at,8,file.bytes) != file.count)
    Fail("search_index_file_invalid");
  std::vector<Record> result; result.reserve(size_t(file.count)); std::string previous;
  for (uint64_t row = 0; row < file.count; ++row) {
    const auto length = ReadInteger(file.data.get(),at,4,file.bytes);
    if (!length || length > kMetadataLimit) Fail("search_index_record_invalid");
    std::string raw(size_t(length),'\0'); ReadAll(file.data.get(),at,raw.data(),raw.size(),file.bytes);
    const auto metadata = Parse(raw); Record record;
    try {
      if (!metadata.at("captured_ms").is_number_integer() || !metadata.at("scene").is_boolean()) Fail("search_index_record_invalid");
      record = {metadata.at("id").get<std::string>(),metadata.at("channel").get<std::string>(),
        metadata.at("processor").get<std::string>(),metadata.at("session").get<std::string>(),metadata.at("track").get<std::string>(),
        metadata.at("model").get<std::string>(),metadata.at("captured_ms").get<int64_t>(),metadata.at("scene").get<bool>(),{},
        metadata.at("fingerprint").get<std::string>()};
      if (Metadata(record,identity).dump() != raw || (row && record.id <= previous)) Fail("search_index_record_invalid");
    } catch (const Json::exception&) { Fail("search_index_record_invalid"); }
    previous = record.id; std::vector<unsigned char> bytes(identity.dimensions*4);
    ReadAll(file.data.get(),at,bytes.data(),bytes.size(),file.bytes); record.vector.resize(identity.dimensions);
    for (size_t i = 0; i < identity.dimensions; ++i) {
      uint32_t bits = 0; for (size_t k = 0; k < 4; ++k) bits |= uint32_t(bytes[i*4+k]) << (8*k);
      std::memcpy(&record.vector[i],&bits,sizeof(bits));
    }
    try { record.vector = NormalizeVector(record.vector,identity.dimensions); }
    catch (...) { Fail("search_index_vector_invalid"); }
    result.push_back(std::move(record));
  }
  if (at != file.bytes || !Same(file.identity,Stat(file.data.get()))) Fail("search_index_file_changed");
  impl_->Current(); return result;
}
void IndexShardFiles::DeleteAuthorized(const IndexShardIdentity& identity, const ShardPublication& publication) {
  Identity(identity);
  if (publication.manifest_key != ManifestKey(identity) || !HashString(publication.manifest_sha256) || publication.checkpoint != identity.checkpoint)
    Fail("search_index_publication_invalid");
  DeleteExact(identity);
}
void IndexShardFiles::DeleteRetired(const IndexShardIdentity& identity,const std::string& manifest_key) {
  KeyIdentity(identity);
  if(identity.storage_generation!=impl_->authorization.generation)Fail("search_index_storage_generation_mismatch");
  if(manifest_key!=identity.id+"/"+std::to_string(identity.revision)+".manifest.json")Fail("search_index_publication_invalid");
  DeleteExact(identity);
}
void IndexShardFiles::DeleteExact(const IndexShardIdentity& identity) {
  std::unique_lock<std::mutex> serial(impl_->mutex,std::try_to_lock);
  if (!serial.owns_lock()) Fail("search_index_busy");
  IoLock io(impl_->writer.get()); impl_->Current(); KeyIdentity(identity); (void)impl_->Scan(true);
  struct stat found{};
  if (fstatat(impl_->root.get(),identity.id.c_str(),&found,AT_SYMLINK_NOFOLLOW)) {
    if (errno == ENOENT) return;
    Fail("search_index_storage_unavailable");
  }
  auto directory = Child(impl_->root.get(),identity.id,impl_->root_identity.st_dev,false);
  const auto base = std::to_string(identity.revision);
  Fd manifest_file, data_file;
  bool manifest_present = false, data_present = false;
  if (!fstatat(directory.get(),(base+".manifest.json").c_str(),&found,AT_SYMLINK_NOFOLLOW)) {
    manifest_file = Regular(directory.get(),base+".manifest.json",impl_->root_identity.st_dev,1099511627776ULL);
    manifest_present = true;
  } else if (errno != ENOENT) Fail("search_index_storage_unavailable");
  if (!fstatat(directory.get(),(base+".records.f32le").c_str(),&found,AT_SYMLINK_NOFOLLOW)) {
    data_file = Regular(directory.get(),base+".records.f32le",impl_->root_identity.st_dev,1099511627776ULL);
    data_present = true;
  } else if (errno != ENOENT) Fail("search_index_storage_unavailable");
  // PG already hid and authorized this immutable exact key. Corrupt derived
  // bytes must remain reclaimable; content hashes are a LOAD condition, not a
  // reason to retain garbage forever. Both objects are type-checked first.
  if (manifest_present) {
    if (unlinkat(directory.get(),(base+".manifest.json").c_str(),0)) Fail("search_index_delete_failed");
    Sync(directory.get());
  }
  // A replay after manifest-first deletion may finish its exact private data
  // file, just as a catalog-authorized unpublished build can be discarded.
  if (data_present) {
    if (unlinkat(directory.get(),(base+".records.f32le").c_str(),0)) Fail("search_index_delete_failed");
    Sync(directory.get());
  }
  if (!unlinkat(impl_->root.get(),identity.id.c_str(),AT_REMOVEDIR)) Sync(impl_->root.get());
  else if (errno != ENOTEMPTY) Fail("search_index_delete_failed");
  impl_->Current();
}
void IndexShardFiles::DiscardUnpublished(const IndexShardIdentity& identity) {
  std::unique_lock<std::mutex> serial(impl_->mutex,std::try_to_lock);
  if (!serial.owns_lock()) Fail("search_index_busy");
  IoLock io(impl_->writer.get()); impl_->Current(); impl_->Check(identity,false); (void)impl_->Scan(true);
  struct stat st{};
  if (fstatat(impl_->root.get(),identity.id.c_str(),&st,AT_SYMLINK_NOFOLLOW)) {
    if (errno == ENOENT) return;
    Fail("search_index_storage_unavailable");
  }
  auto directory = Child(impl_->root.get(),identity.id,impl_->root_identity.st_dev,false);
  const auto base = Base(identity);
  if (!fstatat(directory.get(),(base+".manifest.json").c_str(),&st,AT_SYMLINK_NOFOLLOW) || errno != ENOENT)
    Fail("search_index_manifest_requires_authorized_delete");
  if (!fstatat(directory.get(),(base+".records.f32le").c_str(),&st,AT_SYMLINK_NOFOLLOW)) {
    auto data = Regular(directory.get(),base+".records.f32le",impl_->root_identity.st_dev,1099511627776ULL);
    if (unlinkat(directory.get(),(base+".records.f32le").c_str(),0)) Fail("search_index_delete_failed");
    Sync(directory.get());
  } else if (errno != ENOENT) Fail("search_index_storage_unavailable");
  if (!unlinkat(impl_->root.get(),identity.id.c_str(),AT_REMOVEDIR)) Sync(impl_->root.get());
  else if (errno != ENOTEMPTY) Fail("search_index_delete_failed");
  impl_->Current();
}
}  // namespace ainvr::search
