#include "../../ai-service/src/analytics/review_image.hpp"
#include <fstream>
#include <iostream>
#include <cassert>
int main(int argc,char** argv) {
  try {
    if(argc!=2)throw std::invalid_argument("Expected JPEG fixture path");
    std::ifstream file(argv[1],std::ios::binary);
    std::vector<uint8_t> jpeg((std::istreambuf_iterator<char>(file)),{});
    const auto [w,h]=ai_service::analytics::JpegDimensions(jpeg);
    ai_service::analytics::ReviewImage image;
    const auto start=std::chrono::steady_clock::now();
    auto tensor=image.Prepare(jpeg,w,h,start+std::chrono::seconds(10),[]{return false;});
    assert(tensor.size()==3U*224*448);
    for(auto value:tensor)assert(std::isfinite(value));
    bool mismatch=false;
    try {image.Prepare(jpeg,w+1,h,start+std::chrono::seconds(10),[]{return false;});}
    catch(const std::invalid_argument&){mismatch=true;}assert(mismatch);
    std::cout<<"{\"status\":\"passed\",\"decode\":\"JPU\",\"preprocess\":\"GLES\",\"tensor_values\":"<<tensor.size()<<",\"inference_executed\":false}\n";
  }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
