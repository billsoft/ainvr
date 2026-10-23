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
  std::string encoded(4*((jpeg.size()+2)/3),'\0');EVP_EncodeBlock(reinterpret_cast<unsigned char*>(encoded.data()),jpeg.data(),int(jpeg.size()));
  nlohmann::json request={{"alarm",{{"kind","person"},{"description","target"}}},{"image",{{"jpeg_base64",encoded}}},{"preparation",{{"version",1},{"layout","target-crop-v1"},{"target",{.1,.1,.8,.8}}}}};
  assert(ParseReview(request).target.has_value());
  request["preparation"]["region"]={{.1,.1},{.8,.1},{.8,.8}};request["preparation"]["approach_width_fraction"]=.05;
  assert(ParseReview(request).region.size()==3);
  request["preparation"]["approach_width_fraction"]=2;Invalid([&]{ParseReview(request);});request["preparation"]["approach_width_fraction"]=0;
  request["preparation"]["region"]={{-.1,.1},{.8,.1},{.8,.8}};Invalid([&]{ParseReview(request);});request["preparation"].erase("region");
  request["preparation"]["target"]={.1,.1,.101,.101};
  try{ParseReview(request);assert(false);}catch(const InputError& e){assert(e.code=="insufficient_target_pixels");}
  request["preparation"]["layout"]="unknown";Invalid([&]{ParseReview(request);});
  jpeg.resize(12);
  Invalid([&] { JpegDimensions(jpeg); });
  for (const auto& kind : {"", "<|image_pad|>"}) {
    Invalid([&] { ParseReview({{"alarm",{{"kind",kind},{"description","check"}}}}); });
  }
}
