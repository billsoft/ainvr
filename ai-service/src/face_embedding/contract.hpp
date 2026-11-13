// Copyright AINVR. Coordinate/vector arithmetic only; no CPU image processing.
#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>
#include <openssl/evp.h>

namespace ainvr::face {
using Json = nlohmann::json;
using Point = std::array<double, 2>;
using Landmarks = std::array<Point, 5>;
inline constexpr int kDimensions = 512, kAlignedSize = 112;
// SCRFD order: left image eye, right image eye, nose, left/right image mouth.
inline constexpr Landmarks kTemplate{{{38.2946,51.6963},{73.5318,51.5014},
    {56.0252,71.7366},{41.5493,92.3655},{70.7299,92.2041}}};
inline constexpr const char* kInputVersion = "arcface112-rgb8-similarity5-gles-v1";
inline constexpr const char* kQualityVersion = "face-geometric-gate-v1";
inline std::string Sha256(const std::string& bytes) {
  unsigned char hash[32]; unsigned int size = 0;
  if (!EVP_Digest(bytes.data(),bytes.size(),hash,&size,EVP_sha256(),nullptr) || size != 32)
    throw std::runtime_error("face_hash_failed");
  std::string out; out.reserve(64); constexpr char hex[]="0123456789abcdef";
  for (auto c:hash) {out+=hex[c>>4];out+=hex[c&15];} return out;
}
inline bool IsHash(const std::string& value) {
  return value.size()==64 && std::all_of(value.begin(),value.end(),[](char c){
    return (c>='0'&&c<='9')||(c>='a'&&c<='f');});
}
struct Similarity {
  // source pixel centers -> aligned pixel centers, orientation preserving.
  double a=0,b=0,tx=0,ty=0,rms=0;
  Point Forward(Point p) const {return {a*p[0]-b*p[1]+tx,b*p[0]+a*p[1]+ty};}
  Point Inverse(Point p) const {
    const auto d=a*a+b*b;
    return {(a*(p[0]-tx)+b*(p[1]-ty))/d,(-b*(p[0]-tx)+a*(p[1]-ty))/d};
  }
  std::array<float,9> SourceUv(int width,int height) const {
    if(width<=0||height<=0||!std::isfinite(a*a+b*b)||a*a+b*b<1e-12)
      throw std::invalid_argument("invalid_face_transform");
    const double d=a*a+b*b,ia=a/d,ib=b/d;
    // GLES output u=(x+.5)/112; convert back to centers, then source UV.
    return {float(112*ia/width),float(112*ib/width),float((.5-ia*(tx+.5)-ib*(ty+.5))/width),
      float(-112*ib/height),float(112*ia/height),float((.5+ib*(tx+.5)-ia*(ty+.5))/height),0,0,1};
  }
};
inline Similarity FitSimilarity(const Landmarks& source) {
  Point s{},t{};
  for(size_t i=0;i<5;++i)for(size_t j=0;j<2;++j){
    if(!std::isfinite(source[i][j])||std::abs(source[i][j])>32768)
      throw std::invalid_argument("invalid_face_landmarks");
    s[j]+=source[i][j]/5;t[j]+=kTemplate[i][j]/5;
  }
  double variance=0,dot=0,cross=0;
  for(size_t i=0;i<5;++i){const double x=source[i][0]-s[0],y=source[i][1]-s[1];
    const double u=kTemplate[i][0]-t[0],v=kTemplate[i][1]-t[1];
    variance+=x*x+y*y;dot+=x*u+y*v;cross+=x*v-y*u;}
  if(variance<1e-8)throw std::invalid_argument("degenerate_face_landmarks");
  Similarity m; m.a=dot/variance;m.b=cross/variance;
  if(m.a*m.a+m.b*m.b<1e-12)throw std::invalid_argument("degenerate_face_landmarks");
  m.tx=t[0]-m.a*s[0]+m.b*s[1];m.ty=t[1]-m.b*s[0]-m.a*s[1];
  double error=0;for(size_t i=0;i<5;++i){auto p=m.Forward(source[i]);
    error+=std::pow(p[0]-kTemplate[i][0],2)+std::pow(p[1]-kTemplate[i][1],2);}
  m.rms=std::sqrt(error/5);return m;
}
struct Candidate {
  std::array<double,4> box{}; // x,y,width,height in this exact decoded frame.
  Landmarks landmarks{};
  bool has_landmarks=false;
  double detection_score=0;
};
struct Quality {
  bool accepted=false;
  std::string reason;
  double face_width=0,face_height=0,eye_distance=0,alignment_rms=0,roll_degrees=0;
  Json ToJson() const {return {{"version",kQualityVersion},{"accepted",accepted},{"reason",reason},
    {"face_pixels",{face_width,face_height}},{"eye_distance_px",eye_distance},
    {"alignment_rms_px",alignment_rms},{"roll_degrees",roll_degrees},
    {"scope","geometry_only"},{"blur_assessed",false},{"occlusion_assessed",false},
    {"liveness_assessed",false},{"accuracy_verified",false}};}
};
inline Quality Assess(const Candidate& c,int width,int height,Similarity& transform) {
  Quality q;auto reject=[&](const char* reason){q.reason=reason;return q;};
  if(width<16||height<16||width>4096||height>4096)return reject("invalid_frame_dimensions");
  if(!std::isfinite(c.detection_score)||c.detection_score<.5||c.detection_score>1)
    return reject("low_detection_score");
  for(double v:c.box)if(!std::isfinite(v))return reject("invalid_face_box");
  q.face_width=c.box[2];q.face_height=c.box[3];
  if(c.box[0]<0||c.box[1]<0||q.face_width<48||q.face_height<48||
      c.box[0]+q.face_width>width||c.box[1]+q.face_height>height)return reject("insufficient_face_pixels");
  if(!c.has_landmarks)return reject("missing_five_landmarks");
  for(auto p:c.landmarks)if(!std::isfinite(p[0])||!std::isfinite(p[1])||p[0]<0||p[1]<0||p[0]>=width||p[1]>=height||
      p[0]<c.box[0]||p[0]>c.box[0]+c.box[2]||p[1]<c.box[1]||p[1]>c.box[1]+c.box[3])return reject("landmarks_outside_face");
  const auto dx=c.landmarks[1][0]-c.landmarks[0][0],dy=c.landmarks[1][1]-c.landmarks[0][1];
  q.eye_distance=std::hypot(dx,dy);q.roll_degrees=std::atan2(dy,dx)*180/std::acos(-1.);
  if(q.eye_distance<16)return reject("insufficient_eye_distance");
  if(std::abs(q.roll_degrees)>45)return reject("unsupported_pose");
  try{transform=FitSimilarity(c.landmarks);}catch(const std::invalid_argument&){return reject("invalid_five_landmarks");}
  q.alignment_rms=transform.rms;
  if(q.alignment_rms>4)return reject("alignment_residual");
  // Reject missing pixels rather than letting border padding manufacture a face.
  for(auto p:std::array<Point,4>{{{0,0},{111,0},{0,111},{111,111}}}){
    auto s=transform.Inverse(p);
    if(s[0]<-1e-6||s[1]<-1e-6||s[0]>width-1+1e-6||s[1]>height-1+1e-6)return reject("alignment_crop_outside");
  }
  q.accepted=true;q.reason="accepted_geometry";return q;
}
inline std::array<float,kDimensions> Normalize(const std::vector<float>& raw) {
  if(raw.size()!=kDimensions)throw std::invalid_argument("invalid_embedding_dimensions");
  double norm=0;for(float v:raw){if(!std::isfinite(v))throw std::invalid_argument("nonfinite_embedding");norm+=double(v)*v;}
  if(!std::isfinite(norm)||norm<1e-20)throw std::invalid_argument("degenerate_embedding");
  norm=std::sqrt(norm);std::array<float,kDimensions> out{};
  for(size_t i=0;i<out.size();++i)out[i]=float(raw[i]/norm);
  return out;
}
// No recognition threshold/probability or "stranger" decision in this module.
struct Result {
  std::string status="unavailable",space_hash;
  Quality quality;
  std::array<float,kDimensions> embedding{};
  Json PublicJson() const {return {{"schema","ainvr.face-extraction.v1"},{"status",status},
    {"model_space_hash",space_hash},{"quality",quality.ToJson()},{"accuracy_verified",false}};}
  Json InternalJson() const {
    auto result=PublicJson();result["visibility"]="internal_only";
    if(status=="extracted"&&quality.accepted){result["embedding"]=embedding;result["dimensions"]=kDimensions;
      result["normalization"]="l2";result["input_spec_version"]=kInputVersion;}
    return result;
  }
};
} // namespace ainvr::face
