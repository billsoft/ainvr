#include "scale_info.hpp"

#include <algorithm>
#include <cmath>

namespace ai_service::pipeline {

namespace {
// Python `//` 是向负无穷取整的地板除,C++ 内置 `/` 对整数是向零截断——
// 两者只在结果为负时不同。pad_left/pad_top 正常情况下不会是负的,但用
// 地板除而不是想当然地直接用 `/`,不留这个符号边界的隐患。
int floor_div(int a, int b) {
  int q = a / b;
  int r = a % b;
  if (r != 0 && ((r < 0) != (b < 0))) --q;
  return q;
}
}  // namespace

ScaleInfo compute_scale(int orig_w, int orig_h, int target_w, int target_h) {
  ScaleInfo si;
  si.orig_w = orig_w;
  si.orig_h = orig_h;
  si.target_w = target_w;
  si.target_h = target_h;
  si.scale = std::min(static_cast<double>(target_w) / orig_w,
                       static_cast<double>(target_h) / orig_h);
  // Python int(round(x)):round-half-to-even,用 nearbyint(默认舍入模式)
  // 贴近这个语义,而不是 std::round(round-half-away-from-zero)。
  si.new_w = static_cast<int>(std::nearbyint(orig_w * si.scale));
  si.new_h = static_cast<int>(std::nearbyint(orig_h * si.scale));
  si.pad_left = floor_div(target_w - si.new_w, 2);
  si.pad_top = floor_div(target_h - si.new_h, 2);
  return si;
}

}  // namespace ai_service::pipeline
