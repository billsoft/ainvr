#include "clock.hpp"
#include <ctime>
#include <fstream>
#include <stdexcept>
namespace ainvr_license {
namespace {
int64_t Read(clockid_t clock){timespec ts{};if(clock_gettime(clock,&ts)!=0||ts.tv_sec<0||ts.tv_sec>INT64_MAX/1000000000LL)throw std::runtime_error("CLOCK_UNAVAILABLE");return ts.tv_sec*1000000000LL+ts.tv_nsec;}
}
int64_t SystemClock::WallSec(){auto w=std::time(nullptr);if(w<0||w>253402300799LL)throw std::runtime_error("CLOCK_WALL_INVALID");return w;}
int64_t SystemClock::MonoNs(){return Read(CLOCK_MONOTONIC_RAW);}
int64_t SystemClock::BootNs(){return Read(CLOCK_BOOTTIME);}
std::string SystemClock::BootId(){std::ifstream f("/proc/sys/kernel/random/boot_id");std::string id;if(!(f>>id)||id.size()!=36)throw std::runtime_error("BOOT_ID_UNAVAILABLE");return id;}
}
