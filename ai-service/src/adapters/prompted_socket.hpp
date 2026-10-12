#pragma once

#include <arpa/inet.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <poll.h>
#include <unistd.h>
#include <fcntl.h>
#include <chrono>
#include <cstring>
#include <functional>
#include <utility>
#include "base_adapter.hpp"

namespace ai_service::adapters {

// 套接字只对本机同一服务用户开放；一个模型只允许一个通道占用。
class PromptedSocketAdapter : public BaseModelAdapter {
 public:
  explicit PromptedSocketAdapter(std::pair<int, int> size = {448, 448}, std::string provider = "tensorrt")
      : size_(size), provider_(std::move(provider)) {}
  ~PromptedSocketAdapter() override { if (lease_ >= 0) ::close(lease_); }
  bool IsPrompted() const override { return true; }
  std::string ActualProvider() const override { return provider_; }
  std::string TaskType() const override { return "open_vocabulary_detection"; }
  std::pair<int, int> InputSize() const override { return size_; }
  // 保存配置时只校验文本容量，不占用通道租约，也不加载 GPU 模型。
  static nlohmann::json ValidatePrompt(const std::string& path, const std::string& description, int tokens) {
    PromptedSocketAdapter adapter;
    adapter.SetPath(path);
    return adapter.Request({{"operation", "validate"}, {"description", description}, {"tokens", tokens}},
                           {}, [] { return false; });
  }
  void Load(const std::string& path, const std::string&, const std::string&) override {
    SetPath(path);
    lease_ = ::open((path + ".lease").c_str(), O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (lease_ < 0 || ::flock(lease_, LOCK_EX | LOCK_NB))
      throw std::runtime_error("开放词汇模型已被其他通道使用");
    auto health = Request({{"operation", "health"}}, {}, [] { return false; });
    if (!health.value("ready", false)) throw std::runtime_error("开放词汇执行器未就绪");
  }
  void SetPath(const std::string& path) {
    if (path.size() >= sizeof(sockaddr_un::sun_path))
      throw std::runtime_error("开放词汇执行器地址过长");
    path_ = path;
    struct stat st{};
    if (::lstat(path.c_str(), &st) || !S_ISSOCK(st.st_mode) || st.st_uid != ::getuid() ||
        (st.st_mode & 0077)) throw std::runtime_error("开放词汇执行器未就绪或权限不正确");
  }
  nlohmann::json InferPrompted(const cv::Mat& rgba, const std::string& description, int tokens,
                             const std::function<bool()>& cancelled) override {
    if (rgba.type() != CV_8UC4 || !rgba.isContinuous() || rgba.total() * 4 > 256U * 1024 * 1024)
      throw std::runtime_error("开放词汇输入图像不符合契约");
    return Request({{"width", rgba.cols}, {"height", rgba.rows},
                    {"description", description}, {"tokens", tokens}}, rgba, cancelled);
  }

 private:
  struct Socket {
    int fd = -1;
    ~Socket() { if (fd >= 0) ::close(fd); }
  };
  nlohmann::json Request(const nlohmann::json& request, const cv::Mat& frame,
                        const std::function<bool()>& cancelled) {
    Socket socket{::socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0)};
    if (socket.fd < 0) throw std::runtime_error("无法连接开放词汇执行器");
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, path_.c_str(), path_.size() + 1);
    if (::connect(socket.fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)))
      throw std::runtime_error("开放词汇执行器不可用");
    ucred peer{}; socklen_t length = sizeof(peer);
    if (::getsockopt(socket.fd, SOL_SOCKET, SO_PEERCRED, &peer, &length) || peer.uid != ::getuid())
      throw std::runtime_error("开放词汇执行器身份不匹配");
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(28);
    auto transfer = [&](void* data, size_t size, bool sending) {
      size_t done = 0;
      while (done < size) {
        if (cancelled()) throw std::runtime_error("开放词汇请求已取消");
        if (std::chrono::steady_clock::now() >= deadline)
          throw std::runtime_error("开放词汇推理超过时间上限");
        pollfd poller{socket.fd, static_cast<short>(sending ? POLLOUT : POLLIN), 0};
        auto ready = ::poll(&poller, 1, 100);
        if (ready < 0 && errno == EINTR) continue;
        if (ready < 0) throw std::runtime_error("开放词汇连接等待失败");
        if (!ready) continue;
        auto* ptr = static_cast<char*>(data) + done;
        auto n = sending ? ::send(socket.fd, ptr, size - done, MSG_NOSIGNAL)
                         : ::recv(socket.fd, ptr, size - done, 0);
        if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
        if (n <= 0) throw std::runtime_error("开放词汇执行器连接中断");
        done += static_cast<size_t>(n);
      }
    };
    auto json = request.dump();
    uint32_t size = htonl(static_cast<uint32_t>(json.size()));
    transfer(&size, sizeof(size), true);
    transfer(json.data(), json.size(), true);
    if (!frame.empty()) transfer(frame.data, frame.total() * frame.elemSize(), true);
    transfer(&size, sizeof(size), false);
    size = ntohl(size);
    if (size > 65536) throw std::runtime_error("开放词汇响应超过上限");
    std::string response(size, '\0');
    transfer(response.data(), response.size(), false);
    auto result = nlohmann::json::parse(response);
    if (!result.value("ok", false))
      throw std::runtime_error("开放词汇识别失败(详细原因已记录在执行器日志)");
    return result;
  }
  std::pair<int, int> size_;
  std::string provider_;
  int lease_ = -1;
  std::string path_;
};
}  // namespace ai_service::adapters
