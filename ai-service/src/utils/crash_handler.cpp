// Copyright AINVR. Reused original runtime diagnostics.
#include "crash_handler.hpp"

#include <execinfo.h>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>

#include <cstdint>
#include <cstring>
#include <initializer_list>

namespace ai_service::utils {
namespace {

// 信号处理里只能用异步信号安全的调用：write/open/read/backtrace_symbols_fd，
// 不能 malloc、不能 printf、不能加锁。
void Put(const char* s) { (void)!::write(STDERR_FILENO, s, std::strlen(s)); }

void PutNum(long v) {
  char buf[24];
  int i = sizeof(buf) - 1;
  buf[i] = '\0';
  bool neg = v < 0;
  unsigned long u = neg ? static_cast<unsigned long>(-v) : static_cast<unsigned long>(v);
  do {
    buf[--i] = static_cast<char>('0' + u % 10);
    u /= 10;
  } while (u && i > 1);
  if (neg) buf[--i] = '-';
  Put(buf + i);
}

void PutHex(uintptr_t v) {
  char buf[2 + 2 * sizeof(v) + 1];
  const char* digits = "0123456789abcdef";
  int n = 2 * sizeof(v);
  buf[0] = '0';
  buf[1] = 'x';
  for (int i = 0; i < n; ++i) buf[2 + i] = digits[(v >> (4 * (n - 1 - i))) & 0xF];
  buf[2 + n] = '\0';
  Put(buf);
}

const char* SigName(int sig) {
  switch (sig) {
    case SIGSEGV: return "SIGSEGV";
    case SIGBUS: return "SIGBUS";
    case SIGFPE: return "SIGFPE";
    case SIGILL: return "SIGILL";
    case SIGABRT: return "SIGABRT";
    default: return "?";
  }
}

// 本程序可执行段的映射行（addr2line 需要用 "+偏移" 或基址换算）
void PutOwnMappings() {
  char exe[512];
  ssize_t len = ::readlink("/proc/self/exe", exe, sizeof(exe) - 1);
  if (len <= 0) return;
  exe[len] = '\0';
  int fd = ::open("/proc/self/maps", O_RDONLY);
  if (fd < 0) return;
  char line[640];
  size_t used = 0;
  char chunk[512];
  ssize_t n;
  while ((n = ::read(fd, chunk, sizeof(chunk))) > 0) {
    for (ssize_t i = 0; i < n; ++i) {
      if (used < sizeof(line) - 1) line[used++] = chunk[i];
      if (chunk[i] != '\n') continue;
      line[used] = '\0';
      if (std::strstr(line, exe) && std::strstr(line, "r-xp")) Put(line);
      used = 0;
    }
  }
  ::close(fd);
}

void (*g_stack_hook)() = nullptr;  // 仅测试用：替换"取栈"这一步

// 看门狗：backtrace() 不是异步信号安全的（内部要取 dl_iterate_phdr 等的锁），崩溃时若别的线程
// 恰好持有这些锁，处理器会永远卡住——进程既不退出，systemd 也就不会重启。所以处理器一进来先
// 设 alarm：几秒后 SIGALRM（默认动作=终止进程）无论如何会把进程结束掉。
constexpr unsigned kWatchdogSeconds = 3;

void ArmWatchdog() {
  struct sigaction dfl {};
  dfl.sa_handler = SIG_DFL;          // 防止别的库改过 SIGALRM 的处理方式
  sigemptyset(&dfl.sa_mask);
  ::sigaction(SIGALRM, &dfl, nullptr);
  sigset_t unblock;                  // 崩溃线程的信号掩码里可能屏蔽了 SIGALRM
  sigemptyset(&unblock);
  sigaddset(&unblock, SIGALRM);
  ::sigprocmask(SIG_UNBLOCK, &unblock, nullptr);
  ::alarm(kWatchdogSeconds);
}

void OnFatalSignal(int sig, siginfo_t* info, void*) {
  ArmWatchdog();
  Put("\n[ai-service] 致命信号 ");
  PutNum(sig);
  Put(" (");
  Put(SigName(sig));
  Put(") 线程 ");
  PutNum(static_cast<long>(::gettid()));
  Put(" 地址 ");
  PutHex(reinterpret_cast<uintptr_t>(info ? info->si_addr : nullptr));
  Put("\n[ai-service] 调用栈:\n");
  if (g_stack_hook) {
    g_stack_hook();
  } else {
    void* frames[64];
    int count = ::backtrace(frames, 64);
    ::backtrace_symbols_fd(frames, count, STDERR_FILENO);
  }
  Put("[ai-service] 加载基址:\n");
  PutOwnMappings();
  // 恢复默认动作再重发：保持原本的退出方式（systemd 按信号退出照常重启）
  ::signal(sig, SIG_DFL);
  ::raise(sig);
}

}  // namespace

void SetStackCaptureHookForTest(void (*hook)()) { g_stack_hook = hook; }

void InstallCrashHandler() {
  // backtrace() 首次调用会加载 libgcc，不能发生在信号处理里：先预热一次
  void* warm[1];
  (void)::backtrace(warm, 1);

  // 栈溢出时原栈不可用：给安装线程一块备用栈（其他线程崩在自己的栈上，照常打印）
  static char alt_stack[64 * 1024];
  stack_t ss{};
  ss.ss_sp = alt_stack;
  ss.ss_size = sizeof(alt_stack);
  ::sigaltstack(&ss, nullptr);

  struct sigaction sa {};
  sa.sa_sigaction = OnFatalSignal;
  sa.sa_flags = SA_SIGINFO | SA_ONSTACK | SA_RESETHAND;
  sigemptyset(&sa.sa_mask);
  for (int sig : {SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGABRT}) ::sigaction(sig, &sa, nullptr);
}

}  // namespace ai_service::utils
