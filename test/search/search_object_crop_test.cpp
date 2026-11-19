// Detector-crop admission geometry only: no image, model, tracker or service.
#include "output/search_object_crop.hpp"
#include <iostream>
#include <stdexcept>
using namespace ai_service;
using namespace ai_service::output;
namespace {
size_t checks = 0;
void Check(bool ok, const char* what) { ++checks; if (!ok) throw std::runtime_error(what); }
Detection Box(const std::string& track, double w, double h) { Detection d; d.track_id = track; d.bbox = {10, 10, w, h}; return d; }
}  // namespace
int main() {
  try {
    FrameResult result; result.frame_width = 1280; result.frame_height = 720;
    result.detections = {Box("tall", 20, 90), Box("small", 14, 40), Box("twice", 50, 50), Box("twice", 60, 60)};
    // Observation 1280x720 of a 2560x1440 source: every axis scales by 2.
    Check(SearchObjectShortEdgePx(result, "tall", 2560, 1440) == 40.0, "short edge in source pixels");
    Check(SearchObjectLargeEnough(result, "tall", 2560, 1440, 30), "a 40 px wide person is stored");
    Check(!SearchObjectLargeEnough(result, "small", 2560, 1440, 30), "a 28 px box is left to the scene views");
    Check(SearchObjectLargeEnough(result, "small", 2560, 1440, 20), "threshold is a parameter");
    Check(!SearchObjectShortEdgePx(result, "twice", 2560, 1440) && !SearchObjectShortEdgePx(result, "absent", 2560, 1440),
          "only exactly one box of the track counts");
    Check(!SearchObjectShortEdgePx(result, "tall", 0, 1440) && !SearchObjectShortEdgePx(result, "", 2560, 1440), "invalid frame refused");
    result.detections = {Box("flat", 0, 90)};
    Check(!SearchObjectLargeEnough(result, "flat", 2560, 1440, 0), "an empty box is refused");
    std::cout << "search object crop: " << checks << " checks passed\n";
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
