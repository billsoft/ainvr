// Copyright AINVR. Internal, bounded PTZ observation contract; no detection.
#pragma once
#include <nlohmann/json.hpp>
#include <openssl/crypto.h>
#include <algorithm>
#include <cmath>
#include <functional>
#include <stdexcept>
#include <string>
#include <vector>
#include "analytics/jpeg_dimensions.hpp"

namespace ainvr::flow {
using Json = nlohmann::json;
constexpr int kWidth=512, kHeight=384;
constexpr size_t kPixels=size_t(kWidth)*kHeight, kMaxJpeg=2*1024*1024;
constexpr size_t kMaxEncoded=4*((kMaxJpeg+2)/3), kMaxBody=2*kMaxEncoded+1024;
// MODEL_ROOT is argv[3], the ai-service directory (not ai-service/models).
inline constexpr char kModel[]="models/search/hbm/neuflow-v2-384x512-i16-o2.hbm";
inline constexpr char kModelSha[]="005902951df0945c1160d32fbd203117953b9ed1010fabbd91812cd701a79773";
inline constexpr char kContractSha[]="c6ca1427f03ae1e129f59058348e51ae1513ae952e5e334cdd4b8951b2d601de";
class Error:public std::runtime_error {
 public: Error(int status,const char* code):std::runtime_error(code),status(status){} int status;
};
using Current=std::function<bool()>;
inline void Check(const Current& current){if(!current())throw Error(504,"flow_timeout");}
struct Peer {std::string address,token;};
inline bool Authorized(const Peer& peer,const std::string& token){
  return (peer.address=="127.0.0.1"||peer.address=="::1"||peer.address=="::ffff:127.0.0.1")&&
    token.size()>=32&&token.size()<=512&&token.size()==peer.token.size()&&
    CRYPTO_memcmp(token.data(),peer.token.data(),token.size())==0;
}
inline std::vector<uint8_t> DecodeJpeg(const std::string& text){
  if(text.size()>kMaxEncoded)throw Error(413,"flow_image_too_large");
  if(text.empty()||text.size()%4)throw Error(422,"flow_invalid_base64");
  auto digit=[](char c)->int {
    if(c>='A'&&c<='Z')return c-'A';if(c>='a'&&c<='z')return c-'a'+26;
    if(c>='0'&&c<='9')return c-'0'+52;if(c=='+')return 62;if(c=='/')return 63;return -1;
  };
  std::vector<uint8_t> out;out.reserve(text.size()/4*3);
  for(size_t i=0;i<text.size();i+=4){
    int a=digit(text[i]),b=digit(text[i+1]);
    bool pc=text[i+2]=='=',pd=text[i+3]=='=';
    int c=pc?0:digit(text[i+2]),d=pd?0:digit(text[i+3]);
    if(a<0||b<0||c<0||d<0||(pc&&!pd)||((pc||pd)&&i+4!=text.size())||
       (pc&&(b&15))||(!pc&&pd&&(c&3)))throw Error(422,"flow_invalid_base64");
    out.push_back(uint8_t((a<<2)|(b>>4)));
    if(!pc)out.push_back(uint8_t((b<<4)|(c>>2)));
    if(!pd)out.push_back(uint8_t((c<<6)|d));
  }
  if(out.size()>kMaxJpeg)throw Error(413,"flow_image_too_large");
  try{
    auto [w,h]=ai_service::analytics::JpegDimensions(out);
    if(w<16||h<16||w>4096||h>4096||uint64_t(w)*h>8*1024*1024)
      throw Error(422,"flow_unsupported_image");
  }catch(const std::invalid_argument&){throw Error(422,"flow_invalid_jpeg");}
  return out;
}
inline std::pair<std::vector<uint8_t>,std::vector<uint8_t>> Parse(const std::string& body){
  if(body.size()>kMaxBody)throw Error(413,"flow_body_too_large");
  try{
    auto j=Json::parse(body);
    if(!j.is_object()||j.size()!=2||!j.contains("frame0")||!j.contains("frame1")||
       !j["frame0"].is_string()||!j["frame1"].is_string())throw Error(422,"flow_invalid_request");
    return {DecodeJpeg(j["frame0"].get_ref<const std::string&>()),DecodeJpeg(j["frame1"].get_ref<const std::string&>())};
  }catch(const Json::exception&){throw Error(422,"flow_invalid_request");}
}
// Statistics only: dense-field filtering happens on GLES before this function.
// Median seed + radial MAD trim rejects whole vectors, never separate axes.
inline Json Reduce(const std::vector<float>& field){
  if(field.size()!=2*kPixels)throw Error(503,"flow_output_contract");
  std::vector<double> xs,ys,residuals;xs.reserve(kPixels);ys.reserve(kPixels);
  for(size_t i=0;i<kPixels;++i)if(std::isfinite(field[i])&&std::isfinite(field[kPixels+i])){
    xs.push_back(field[i]);ys.push_back(field[kPixels+i]);
  }
  if(xs.size()<kPixels/4)throw Error(422,"flow_insufficient_vectors");
  auto median=[](std::vector<double> v){auto m=v.begin()+v.size()/2;std::nth_element(v.begin(),m,v.end());return *m;};
  double mx=median(xs),my=median(ys);
  for(size_t i=0;i<xs.size();++i)residuals.push_back(std::hypot(xs[i]-mx,ys[i]-my));
  double med=median(residuals);std::vector<double> deviations;
  for(double r:residuals)deviations.push_back(std::abs(r-med));
  double threshold=std::max(0.5,med+3.0*1.4826*median(deviations));
  double dx=0,dy=0;size_t n=0;
  for(size_t i=0;i<xs.size();++i)if(residuals[i]<=threshold){dx+=xs[i];dy+=ys[i];++n;}
  if(n<kPixels/4)throw Error(422,"flow_insufficient_inliers");
  dx/=n;dy/=n;double variance=0;
  for(size_t i=0;i<xs.size();++i)if(residuals[i]<=threshold)
    variance+=(xs[i]-dx)*(xs[i]-dx)+(ys[i]-dy)*(ys[i]-dy);
  return {{"dx",dx},{"dy",dy},{"width",kWidth},{"height",kHeight},{"inliers",n},
    {"validRatio",double(n)/kPixels},{"spread",std::sqrt(variance/n)},
    {"finiteVectors",xs.size()},{"trimThreshold",threshold},{"backend","neuflow-bpu"}};
}
} // namespace ainvr::flow
