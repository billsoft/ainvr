#pragma once
#include <nlohmann/json.hpp>
#include <openssl/evp.h>
#include <array>
#include <optional>
#include <cmath>
#include <string>
#include <vector>
#include <stdexcept>
namespace ainvr::llm {
struct InputError:std::invalid_argument{std::string code;InputError(std::string c,std::string m):std::invalid_argument(m),code(std::move(c)) {}};
struct ReviewRequest { std::string kind,description,id; std::vector<uint8_t> jpeg; int width,height; bool letterbox=false; double temperature=1; std::optional<std::array<float,4>> target; std::vector<std::array<float,2>> region; float approach=0; };
inline std::vector<uint8_t> DecodeBase64(const std::string& text) {
  if(text.empty()||text.size()>12*1024*1024||text.size()%4)throw std::invalid_argument("invalid image encoding or size");
  size_t padding=text.back()=='=' ? 1:0;
  if(text.size()>1&&text[text.size()-2]=='=')++padding;
  for(size_t i=0;i<text.size()-padding;++i) {
    char c=text[i]; if(!((c>='A'&&c<='Z')||(c>='a'&&c<='z')||(c>='0'&&c<='9')||c=='+'||c=='/'))
      throw std::invalid_argument("invalid base64 character");
  }
  std::vector<uint8_t> bytes(text.size()/4*3);
  int size=EVP_DecodeBlock(bytes.data(),reinterpret_cast<const unsigned char*>(text.data()),text.size());
  if(size<0)throw std::invalid_argument("invalid base64");
  bytes.resize(size-padding);return bytes;
}
inline std::array<int,2> JpegDimensions(const std::vector<uint8_t>& b,bool letterbox=false) {
  if(b.size()<4||b[0]!=0xff||b[1]!=0xd8)throw std::invalid_argument("JPEG required");
  size_t i=2;
  while(i<b.size()) {
    if(b[i++]!=0xff)throw std::invalid_argument("invalid JPEG marker");
    while(i<b.size()&&b[i]==0xff)++i;
    if(i>=b.size())break;
    int marker=b[i++];
    if(marker==0xd9||marker==0xda)break;
    if(marker==0x01||(marker>=0xd0&&marker<=0xd7))continue;
    if(i+2>b.size())break;
    size_t len=(size_t(b[i])<<8)|b[i+1];
    if(len<2||i+len>b.size())throw std::invalid_argument("truncated JPEG");
    if(marker==0xc0) {
      if(len!=17||b[i+2]!=8||b[i+7]!=3||b[i+9]!=0x22||b[i+12]!=0x11||b[i+15]!=0x11)
        throw std::invalid_argument("only baseline 8-bit 4:2:0 JPEG is enabled");
      int h=(b[i+3]<<8)|b[i+4],w=(b[i+5]<<8)|b[i+6];
      if(w<(letterbox?16:64)||h<(letterbox?16:64)||w>8192||h>4096||(!letterbox&&w!=2*h)||w%2||h%2)
        throw std::invalid_argument("image must be 2:1, even dimensions, within 8192x4096");
      return {w,h};
    }
    if(marker>=0xc1&&marker<=0xcf&&marker!=0xc4&&marker!=0xc8&&marker!=0xcc)
      throw std::invalid_argument("unsupported JPEG coding mode");
    i+=len;
  }
  throw std::invalid_argument("JPEG frame header missing");
}
inline ReviewRequest ParseReview(const nlohmann::json& j) {
  ReviewRequest r;
  r.kind=j.at("alarm").at("kind").get<std::string>(); r.description=j.at("alarm").at("description").get<std::string>();
  if(r.kind.empty()||r.description.empty()||r.kind.size()>1024||r.description.size()>8192)
    throw std::invalid_argument("invalid alarm text");
  if(r.kind.find("<|")!=std::string::npos||r.description.find("<|")!=std::string::npos)
    throw std::invalid_argument("reserved template delimiter");
  r.id=j.value("request_id",std::string());
  if(r.id.size()>128)throw std::invalid_argument("request_id too long");
  try{r.jpeg=DecodeBase64(j.at("image").at("jpeg_base64").get<std::string>());}catch(const std::invalid_argument& e){throw InputError("unsupported_image",e.what());}
  const auto fit=j.at("image").value("fit",std::string("strict"));
  if(fit!="strict"&&fit!="letterbox")throw std::invalid_argument("invalid image fit");
  r.letterbox=fit=="letterbox";
  std::array<int,2> size;try{size=JpegDimensions(r.jpeg,r.letterbox);}catch(const std::invalid_argument& e){throw InputError("unsupported_image",e.what());} r.width=size[0];r.height=size[1];
  if(j.contains("preparation")){
    const auto& p=j.at("preparation");
    if(p.at("version")!=1||p.at("layout")!="target-crop-v1")throw InputError("invalid_request","Unsupported preparation profile");
    auto box=p.at("target").get<std::array<float,4>>();
    for(auto v:box)if(!std::isfinite(v)||v<0||v>1)throw InputError("invalid_request","Invalid normalized target");
    if(box[2]<=box[0]||box[3]<=box[1])throw InputError("invalid_request","Empty target");
    if((box[2]-box[0])*r.width<16||(box[3]-box[1])*r.height<16)throw InputError("insufficient_target_pixels","Target has insufficient source detail");
    r.target=box;
    if(p.contains("region")){r.region=p.at("region").get<std::vector<std::array<float,2>>>();if(r.region.size()>32||(!r.region.empty()&&r.region.size()<3))throw InputError("invalid_request","Invalid region");for(auto xy:r.region)for(auto v:xy)if(!std::isfinite(v)||v<0||v>1)throw InputError("invalid_request","Invalid region coordinate");}
    r.approach=p.value("approach_width_fraction",0.f);if(!std::isfinite(r.approach)||r.approach<0||r.approach>1)throw InputError("invalid_request","Invalid approach distance");
  }
  return r;
}
} // namespace ainvr::llm
