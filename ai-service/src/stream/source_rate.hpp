#pragma once
#include <cmath>
namespace ai_service::stream {
// Source rate is a recent observation, never a sticky last-known-good value.
inline double FreshSourceRate(double rate,double age_seconds,bool running) {
 return running&&std::isfinite(rate)&&rate>=0&&std::isfinite(age_seconds)&&age_seconds>=0&&age_seconds<=2.0?rate:0.0;
}
}
