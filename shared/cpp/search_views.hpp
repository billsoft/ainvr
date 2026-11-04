// AINVR. Whole-frame search views. Pure geometry; no detector, image, model or storage dependency.
#pragma once
#include <array>
#include <cmath>
#include <cstddef>
#include <stdexcept>

namespace ainvr::search {
// One scene sample carries kSceneViews unit-norm vectors, concatenated view-major:
//   view 0      the whole frame, resized to the model square;
//   views 1..3  squares of side min(width,height) spread along the long axis
//               (left, middle, right for a landscape frame; top, middle, bottom for a portrait one).
// Squares overlap whenever the long side is less than three times the short side, so nothing is cut at a seam.
// Every view is squashed to the model input square like the whole frame: the SigLIP family was trained that way
// and padding to keep the aspect ratio measurably hurt retrieval in the 2026-11-04 A/B.
inline constexpr std::size_t kSceneViews = 4;
inline constexpr const char* kSceneViewLayout = "whole+3squares-shortedge-v1";

struct ViewRect { double x = 0, y = 0, w = 0, h = 0; };

inline std::array<ViewRect, kSceneViews> PlanSceneViews(int width, int height) {
  if (width < 2 || height < 2 || width > 65536 || height > 65536) throw std::invalid_argument("scene_view_dimensions");
  const double side = std::min(width, height);
  const bool landscape = width >= height;
  const double travel = (landscape ? width : height) - side;
  std::array<ViewRect, kSceneViews> out{};
  out[0] = {0, 0, double(width), double(height)};
  for (std::size_t k = 0; k < 3; ++k) {
    const double offset = std::floor(travel * double(k) / 2.0 + 0.5);
    out[k + 1] = landscape ? ViewRect{offset, 0, side, side} : ViewRect{0, offset, side, side};
  }
  return out;
}
}  // namespace ainvr::search
