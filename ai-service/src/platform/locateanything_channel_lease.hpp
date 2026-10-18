// Copyright AINVR. One native channel owns the shared complete-model executor.
#pragma once
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <cerrno>
#include <stdexcept>
#include <string>

namespace ainvr {
class LocateAnythingChannelLease final {
 public:
  static constexpr const char* kPath = "/home/sunrise/ainvr/data/ai/locateanything-channel.lock";
  static constexpr const char* kBusy = "已有开放词汇试用通道运行，请先停止该通道后再启动另一路";
  explicit LocateAnythingChannelLease(const std::string& path = kPath) {
    // Each open has a separate file description: flock also excludes another
    // channel in this process. CLOEXEC prevents child programs retaining it.
    fd_ = ::open(path.c_str(), O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (fd_ < 0) throw std::runtime_error("无法取得开放词汇通道运行锁");
    struct stat info{};
    if (::fstat(fd_, &info) || !S_ISREG(info.st_mode) ||
        info.st_uid != ::geteuid() || info.st_nlink != 1 || (info.st_mode & 0077)) {
      Close();
      throw std::runtime_error("开放词汇通道运行锁的归属或权限不正确");
    }
    if (::flock(fd_, LOCK_EX | LOCK_NB)) {
      const int error = errno;
      Close();
      if (error == EWOULDBLOCK || error == EAGAIN) throw std::runtime_error(kBusy);
      throw std::runtime_error("无法取得开放词汇通道运行锁");
    }
  }
  ~LocateAnythingChannelLease() { Close(); }
  LocateAnythingChannelLease(const LocateAnythingChannelLease&) = delete;
  LocateAnythingChannelLease& operator=(const LocateAnythingChannelLease&) = delete;
 private:
  void Close() noexcept {
    // Keep the inode. Unlinking a held lock could permit a second owner.
    if (fd_ >= 0) { ::close(fd_); fd_ = -1; }
  }
  int fd_ = -1;
};
}  // namespace ainvr
