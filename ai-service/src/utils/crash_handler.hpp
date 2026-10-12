// Copyright AINVR. Reused original runtime diagnostics.
// 致命信号（SIGSEGV/SIGBUS/SIGFPE/SIGILL/SIGABRT）时把信号、调用栈和本程序的
// 加载基址写到 stderr（systemd 下进 journald），再按默认动作退出，systemd 照常
// 重启。生产上 core dump 关闭、且进程虚拟内存大，这是崩溃留痕的最小手段：
// 拿日志里的 "+0x偏移" 用 addr2line -e ai_service 即可还原到源码行。
#pragma once

namespace ai_service::utils {

void InstallCrashHandler();

// 仅供测试：替换处理器里的"取栈"步骤（用来模拟 backtrace 卡死）。生产代码不调用。
void SetStackCaptureHookForTest(void (*hook)());

}  // namespace ai_service::utils
