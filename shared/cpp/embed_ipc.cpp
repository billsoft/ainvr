#include "embed_ipc.hpp"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#include <chrono>
#include <cstring>
#include <stdexcept>

namespace ainvr {
namespace {
constexpr size_t kMaxLine = 16384;
constexpr size_t kMaxPayloadBytes = 1 << 20;

bool WriteAll(int fd, const void* data, size_t size) {
  const char* p = static_cast<const char*>(data);
  while (size) {
    const ssize_t n = ::send(fd, p, size, MSG_NOSIGNAL);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return false;
    p += n; size -= size_t(n);
  }
  return true;
}
bool ReadExact(int fd, void* data, size_t size) {
  char* p = static_cast<char*>(data);
  while (size) {
    const ssize_t n = ::recv(fd, p, size, 0);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return false;
    p += n; size -= size_t(n);
  }
  return true;
}
// Reads up to and including '\n' without over-reading into the payload.
bool ReadLine(int fd, std::string& line) {
  line.clear();
  char c;
  while (line.size() < kMaxLine) {
    const ssize_t n = ::recv(fd, &c, 1, 0);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return false;
    if (c == '\n') return true;
    line.push_back(c);
  }
  return false;
}
void Timeouts(int fd, int ms) {
  timeval tv{ms / 1000, (ms % 1000) * 1000};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
}
sockaddr_un Address(const std::string& path) {
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  if (path.empty() || path.size() >= sizeof address.sun_path) throw std::invalid_argument("embed_ipc_path");
  std::memcpy(address.sun_path, path.c_str(), path.size() + 1);
  return address;
}
}  // namespace

EmbedIpcServer::EmbedIpcServer(std::string socket_path, EmbedIpcHandler handler)
    : path_(std::move(socket_path)), handler_(std::move(handler)) {
  if (!handler_) throw std::invalid_argument("embed_ipc_handler");
  const auto address = Address(path_);
  listen_fd_ = ::socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (listen_fd_ < 0) throw std::runtime_error("embed_ipc_socket");
  ::unlink(path_.c_str());
  const mode_t old = ::umask(0177);
  const int rc = ::bind(listen_fd_, reinterpret_cast<const sockaddr*>(&address), sizeof address);
  ::umask(old);
  if (rc != 0 || ::chmod(path_.c_str(), 0600) != 0 || ::listen(listen_fd_, 8) != 0 || ::pipe2(wake_, O_CLOEXEC) != 0) {
    ::close(listen_fd_); ::unlink(path_.c_str());
    throw std::runtime_error("embed_ipc_bind");
  }
  thread_ = std::thread([this] { Serve(); });
}

EmbedIpcServer::~EmbedIpcServer() {
  stop_.store(true);
  if (wake_[1] >= 0) { const char b = 1; (void)!::write(wake_[1], &b, 1); }
  if (thread_.joinable()) thread_.join();
  for (int fd : {listen_fd_, wake_[0], wake_[1]}) if (fd >= 0) ::close(fd);
  ::unlink(path_.c_str());
}

void EmbedIpcServer::Serve() {
  while (!stop_.load()) {
    pollfd fds[2] = {{listen_fd_, POLLIN, 0}, {wake_[0], POLLIN, 0}};
    if (::poll(fds, 2, -1) < 0 && errno != EINTR) break;
    if (stop_.load() || (fds[1].revents & POLLIN)) break;
    if (!(fds[0].revents & POLLIN)) continue;
    const int fd = ::accept4(listen_fd_, nullptr, nullptr, SOCK_CLOEXEC);
    if (fd < 0) continue;
    Timeouts(fd, 5000);
    std::string line;
    nlohmann::json header;
    std::vector<float> payload;
    try {
      if (!ReadLine(fd, line)) { ::close(fd); continue; }
      const auto request = nlohmann::json::parse(line);
      auto reply = handler_(request);
      header = std::move(reply.header);
      payload = std::move(reply.payload);
      header["ok"] = true;
      header["payload"] = payload.size() * sizeof(float);
    } catch (const std::runtime_error& e) {
      header = {{"ok", false}, {"error", std::string(e.what()).substr(0, 64)}};
      payload.clear();
    } catch (...) {
      header = {{"ok", false}, {"error", "search_encoding_failed"}};
      payload.clear();
    }
    const std::string text = header.dump() + "\n";
    if (WriteAll(fd, text.data(), text.size()) && !payload.empty()) WriteAll(fd, payload.data(), payload.size() * sizeof(float));
    ::close(fd);
  }
}

EmbedIpcReply EmbedIpcCall(const std::string& socket_path, const nlohmann::json& request, int timeout_ms) {
  const auto address = Address(socket_path);
  const int fd = ::socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) throw std::runtime_error("search_ipc_failed");
  struct Closer { int fd; ~Closer() { ::close(fd); } } closer{fd};
  Timeouts(fd, timeout_ms);
  if (::connect(fd, reinterpret_cast<const sockaddr*>(&address), sizeof address) != 0) {
    if (errno == ENOENT || errno == ECONNREFUSED) throw std::runtime_error("search_model_pending");
    throw std::runtime_error("search_ipc_failed");
  }
  const std::string text = request.dump() + "\n";
  if (text.size() > kMaxLine || !WriteAll(fd, text.data(), text.size())) throw std::runtime_error("search_ipc_failed");
  std::string line;
  if (!ReadLine(fd, line)) throw std::runtime_error("search_ipc_failed");
  EmbedIpcReply reply;
  try {
    reply.header = nlohmann::json::parse(line);
    if (!reply.header.value("ok", false)) throw std::runtime_error(reply.header.value("error", std::string("search_ipc_failed")));
    const size_t bytes = reply.header.value("payload", size_t(0));
    if (bytes > kMaxPayloadBytes || bytes % sizeof(float)) throw std::runtime_error("search_ipc_failed");
    reply.payload.resize(bytes / sizeof(float));
    if (bytes && !ReadExact(fd, reply.payload.data(), bytes)) throw std::runtime_error("search_ipc_failed");
  } catch (const nlohmann::json::exception&) { throw std::runtime_error("search_ipc_failed"); }
  return reply;
}

}  // namespace ainvr
