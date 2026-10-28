#pragma once
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <cerrno>
#include <fcntl.h>
#include <memory>
#include <regex>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

namespace ainvr::config {
// One private bootstrap transport shared by native services. Credentials are
// never accepted through command-line values or emitted in exception text.
inline nlohmann::json ReadPrivateJson(const std::string& path) {
  const int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (fd < 0) throw std::runtime_error("private configuration file required");
  struct Close { int fd; ~Close() { close(fd); } } close_file{fd};
  struct stat st{};
  if (fstat(fd, &st) || !S_ISREG(st.st_mode) || (st.st_mode & 077) ||
      st.st_size <= 0 || st.st_size > 65536)
    throw std::runtime_error("private configuration file required");
  std::string body;
  char buffer[4096];
  while (true) {
    const auto count = read(fd, buffer, sizeof(buffer));
    if (count == 0) break;
    if (count < 0) { if (errno == EINTR) continue; throw std::runtime_error("private configuration read failed"); }
    if (body.size() + size_t(count) > 65536) throw std::runtime_error("private configuration file required");
    body.append(buffer, size_t(count));
  }
  return nlohmann::json::parse(body, [](int depth, auto, auto&) {
    if (depth > 16) throw std::invalid_argument("private configuration depth");
    return true;
  });
}
class ConfigTransport {
 public:
  explicit ConfigTransport(const nlohmann::json& bootstrap)
      : token_(bootstrap.at("service_token").get<std::string>()) {
    const auto url = bootstrap.at("control_url").get<std::string>();
    std::smatch match;
    if (!std::regex_match(url, match, std::regex("http://(127\\.0\\.0\\.1|localhost):([0-9]{1,5})/?")))
      throw std::invalid_argument("local config endpoint required");
    const int port = std::stoi(match[2]);
    if (port < 1 || port > 65535 || token_.size() < 32 || token_.size() > 512 ||
        token_.find_first_of("\r\n") != std::string::npos)
      throw std::invalid_argument("invalid bootstrap");
    client_ = std::make_unique<httplib::Client>(match[1], port);
    client_->set_connection_timeout(3); client_->set_read_timeout(10); client_->set_write_timeout(10);
    client_->set_follow_location(false);
  }
  nlohmann::json Request(const std::string& path, const nlohmann::json* body = nullptr) {
    const auto envelope = RequestAt("/api/v1/config/" + path, body);
    if (envelope.at("code") != 0) throw std::runtime_error("configuration request failed");
    return envelope.at("data");
  }
  // The same local, bounded, authenticated transport also serves versioned
  // effective-runtime views. This does not grant foreign secret namespaces.
  nlohmann::json RequestAt(const std::string& path, const nlohmann::json* body = nullptr) {
    if (path.rfind("/api/", 0) != 0 || path.size() > 1024 || path.find_first_of("\r\n") != std::string::npos)
      throw std::invalid_argument("invalid configuration path");
    httplib::Request request;
    request.method = body ? "POST" : "GET"; request.path = path;
    request.headers.emplace("x-service-token", token_);
    if (body) {
      request.body = body->dump(); request.headers.emplace("Content-Type", "application/json");
      if (request.body.size() > 1024 * 1024) throw std::invalid_argument("configuration request too large");
    }
    std::string received;
    request.response_handler = [](const auto& response) { return response.status == 200; };
    request.content_receiver = [&](const char* data, size_t size, uint64_t, uint64_t) {
      if (size > 1024 * 1024 - received.size()) return false;
      received.append(data, size); return true;
    };
    const auto result = client_->send(request);
    if (!result || result->status != 200) throw std::runtime_error("configuration center unavailable");
    return nlohmann::json::parse(received, [](int depth, auto, auto&) {
      if (depth > 32) throw std::invalid_argument("configuration response depth");
      return true;
    });
  }
 private:
  std::string token_;
  std::unique_ptr<httplib::Client> client_;
};
}  // namespace ainvr::config
