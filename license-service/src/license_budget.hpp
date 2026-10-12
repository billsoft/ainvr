#pragma once
namespace ainvr_license {
// 租约预算参数（秒）。租约只能用到"已确认落盘"的预算，落盘是异步的，所以这里决定了系统盘卡顿时能扛多久。
//
// kMaxLeaseSec       单个租约最长时长；客户端协议上限也是 30 秒，不可随意加大。
// kBudgetAheadSec    已落盘预算剩余不足 kMaxLeaseSec+kBudgetAheadSec 就发起下一次落盘续期。
//                    落盘最多可以卡 kMaxLeaseSec+kBudgetAheadSec 才会让租约耗尽（卡 kBudgetAheadSec 起租约开始缩短）。
// kBudgetReservationSec 每次续期预留的预算。必须大于 kMaxLeaseSec+kBudgetAheadSec，否则会连续不停地续期。
//                    崩溃/断电后最多多扣这么多授权时间（按天计的授权可忽略），换来更少的落盘次数和更大的卡顿余量。
//
// 2026-10-02 实测：系统盘卡顿时授权主文件落盘最长 32.6 秒；原参数（60/10）只能扛 40 秒，余量过薄。
inline constexpr long long kMaxLeaseSec = 30;
inline constexpr long long kBudgetAheadSec = 60;
inline constexpr long long kBudgetReservationSec = 180;
static_assert(kBudgetReservationSec > kMaxLeaseSec + kBudgetAheadSec, "reservation must exceed the renewal trigger");
}
