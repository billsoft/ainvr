#include "request.hpp"
#include <cassert>
#include <functional>

void Invalid(const std::function<void()>& run) {
  bool rejected = false;
  try { run(); } catch (const std::invalid_argument&) { rejected = true; }
  assert(rejected);
}

int main() {
  using namespace ainvr::llm;
  assert(DecodeBase64("AQID") == std::vector<uint8_t>({1, 2, 3}));
  assert(DecodeBase64("AQ==") == std::vector<uint8_t>({1}));
  for (const auto& s : {"", "=AAA", "AAAA=", "A A=", "===="}) {
    Invalid([&] { DecodeBase64(s); });
  }
  std::vector<uint8_t> jpeg = {255,216,255,192,0,17,8,1,192,3,128,3,1,0x22,0,2,0x11,1,3,0x11,1};
  assert((JpegDimensions(jpeg) == std::array<int,2>{896,448}));
  auto progressive = jpeg; progressive[3] = 194;
  Invalid([&] { JpegDimensions(progressive); });
  auto chroma = jpeg; chroma[13] = 0x11;
  Invalid([&] { JpegDimensions(chroma); });
  jpeg.resize(12);
  Invalid([&] { JpegDimensions(jpeg); });
  for (const auto& kind : {"", "<|image_pad|>"}) {
    Invalid([&] { ParseReview({{"alarm",{{"kind",kind},{"description","check"}}}}); });
  }
}
