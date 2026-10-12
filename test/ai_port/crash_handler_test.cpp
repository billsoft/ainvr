// Copyright AINVR. Reused original runtime diagnostics.
// 进程收到致命信号（段错误等）时，要把调用栈和程序加载基址写进日志再退出——
// 2026-09-30 现场两次段错误都没留下任何现场（core dump 关闭），无从定位。
#include <gtest/gtest.h>

#include <fcntl.h>
#include <unistd.h>

#include <csignal>
#include <cstdlib>
#include <string>

#include "utils/crash_handler.hpp"

namespace {
std::string g_child_stderr;
[[gnu::noinline]] void CrashHere() {
  volatile int* p = nullptr;
  *p = 42;
}

void InstallThenSegfault() {
  ai_service::utils::InstallCrashHandler();
  CrashHere();
}

void InstallThenAbort() {
  ai_service::utils::InstallCrashHandler();
  std::abort();
}
}  // namespace

// gtest 死亡测试的正则对中文字节、跨行匹配不可靠：按同一行里的 ASCII 关键字逐项断言
TEST(CrashHandlerDeathTest, SegfaultWritesSignalBacktraceAndLoadAddress) {
  ::testing::FLAGS_gtest_death_test_style = "threadsafe";
  EXPECT_DEATH(InstallThenSegfault(), " 11 \\(SIGSEGV\\)");
  // 调用栈帧带 "+0x偏移"：用 addr2line -e <程序> 可还原到源码行
  EXPECT_DEATH(InstallThenSegfault(), "crash_handler_test\\(\\+0x[0-9a-f]+\\)");
  // 程序可执行段的加载基址
  EXPECT_DEATH(InstallThenSegfault(), "r-xp .*crash_handler_test");
}

TEST(CrashHandlerDeathTest, AbortIsAlsoReported) {
  ::testing::FLAGS_gtest_death_test_style = "threadsafe";
  EXPECT_DEATH(InstallThenAbort(), " 6 \\(SIGABRT\\)");
}

// ---- 取栈卡住也不能妨碍退出 ----
// backtrace() 不是异步信号安全的：崩溃那一刻若别的线程正持有它内部要用的锁（例如 dl_iterate_phdr
// 的锁），处理器会永远卡住，进程既不退出、systemd 也不会重启。处理器一进来就先设 alarm 看门狗：
// 即使取栈卡死，几秒后进程也会被 SIGALRM 终止；"最小现场"在取栈之前就已经写出。
#include <sys/wait.h>
#include <chrono>
#include <thread>

namespace {
void BlockForever() { for (;;) std::this_thread::sleep_for(std::chrono::seconds(60)); }

// 在子进程里：安装处理器，让取栈永远阻塞，然后段错误。返回子进程是在多久内死的（秒），<0 表示超时仍活着
double SecondsUntilChildDies(int timeout_s) {
  int fds[2];
  if (::pipe(fds)) return -2;
  pid_t pid = ::fork();
  if (pid == 0) {
    ::dup2(fds[1], STDERR_FILENO);
    ::close(fds[0]);
    ai_service::utils::SetStackCaptureHookForTest(&BlockForever);
    ai_service::utils::InstallCrashHandler();
    CrashHere();
    ::_exit(0);
  }
  ::close(fds[1]);
  auto t0 = std::chrono::steady_clock::now();
  int status = 0;
  double took = -1;
  while (std::chrono::steady_clock::now() - t0 < std::chrono::seconds(timeout_s)) {
    if (::waitpid(pid, &status, WNOHANG) == pid) {
      took = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  if (took < 0) {
    ::kill(pid, SIGKILL);
    ::waitpid(pid, &status, 0);
  }
  std::string out;
  char buf[512];
  ::fcntl(fds[0], F_SETFL, O_NONBLOCK);
  for (ssize_t n; (n = ::read(fds[0], buf, sizeof buf)) > 0;) out.append(buf, n);
  ::close(fds[0]);
  g_child_stderr = out;
  return took;
}
}  // namespace

TEST(CrashHandlerWatchdog, HungStackCaptureStillTerminatesTheProcess) {
  const double took = SecondsUntilChildDies(10);
  EXPECT_GT(took, 0.0) << "取栈卡住后进程没有退出，systemd 无从重启";
  EXPECT_LT(took, 8.0);
  // 最小现场在取栈之前已经写出
  EXPECT_NE(g_child_stderr.find(" 11 (SIGSEGV)"), std::string::npos) << g_child_stderr;
}
