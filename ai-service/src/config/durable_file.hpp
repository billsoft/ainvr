#pragma once

#include <cerrno>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>
#include <fcntl.h>
#include <unistd.h>

namespace ai_service::config {
// Atomic visibility and durable directory entry. The injected sync function is
// only for deterministic I/O fault tests; production always uses fsync.
inline void WriteDurableFile(const std::filesystem::path& path, const std::string& bytes,
                             int (*sync_fd)(int) = ::fsync) {
  const auto parent = path.parent_path().empty() ? std::filesystem::path(".") : path.parent_path();
  int dir = ::open(parent.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (dir < 0) throw std::runtime_error("cannot open configuration directory");
  std::string name = path.string() + ".tmp.XXXXXX";
  std::vector<char> tmp(name.begin(), name.end()); tmp.push_back('\0');
  int fd = ::mkstemp(tmp.data());
  if (fd < 0) { ::close(dir); throw std::runtime_error("cannot create configuration temporary file"); }
  try {
    size_t offset = 0;
    while (offset < bytes.size()) {
      const auto n = ::write(fd, bytes.data() + offset, bytes.size() - offset);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) throw std::runtime_error("configuration write failed");
      offset += static_cast<size_t>(n);
    }
    if (sync_fd(fd) != 0) throw std::runtime_error("configuration file fsync failed");
    const int closing = fd; fd = -1;
    if (::close(closing) != 0) throw std::runtime_error("configuration close failed");
    if (::rename(tmp.data(), path.c_str()) != 0) throw std::runtime_error("configuration rename failed");
    if (sync_fd(dir) != 0) throw std::runtime_error("configuration directory fsync failed");
    ::close(dir);
  } catch (...) {
    if (fd >= 0) ::close(fd);
    ::unlink(tmp.data());
    ::close(dir);
    throw;
  }
}
}  // namespace ai_service::config
