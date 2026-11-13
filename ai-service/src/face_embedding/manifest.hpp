// Copyright AINVR. Strict installed-sidecar contracts; no model/config writes.
#pragma once
#include "contract.hpp"
#include <filesystem>
#include <fstream>
#include <map>
#include <set>

namespace ainvr::face {
struct ModelSpec {
  std::string id,path,hbm_hash;
  uint64_t bytes=0;
  Json manifest;
};
inline ModelSpec ParseManifest(const std::string& id,const std::string& path,const Json& m,bool embedding) {
  if(m.at("schema_version")!=1||m.at("target")!="rdk_s100p"||
      m.at("hbm_file")!=std::filesystem::path(path).filename().string())throw std::invalid_argument("face_manifest_contract");
  ModelSpec spec{id,path,m.at("hbm_sha256").get<std::string>(),m.at("hbm_bytes").get<uint64_t>(),m};
  if(!IsHash(spec.hbm_hash)||!spec.bytes||spec.bytes>128ULL*1024*1024)throw std::invalid_argument("face_manifest_identity");
  const auto& pre=m.at("preprocess");
  if(pre.at("rgb_order")!=true)throw std::invalid_argument("face_rgb_contract");
  if(embedding){
    // adapter=null is an installed data contract, not a detector adapter grant.
    if(m.at("task")!="face_embedding_512"||m.at("input_contract")!="float_nchw_rgb_aligned112"||
        m.at("adapter_planned")!="arcface_bpu"||(!m.at("adapter").is_null()&&m.at("adapter")!="arcface_bpu")||
        pre.at("normalize")!="(x-127.5)/127.5"||
        pre.at("alignment")!="similarity transform of 5 landmarks to ArcFace 112x112 template"||
        m.at("output_contract")!="embedding[1,512]; L2-normalise, compare by cosine")
      throw std::invalid_argument("face_embedding_contract");
    for(const auto* key:{"inputs","outputs"})if(!m.at(key).is_object()||m.at(key).size()!=1)
      throw std::invalid_argument("face_embedding_ports");
    const auto& in=m.at("inputs").begin().value();const auto& out=m.at("outputs").begin().value();
    if(in.at("shape")!=Json::array({1,3,112,112})||out.at("shape")!=Json::array({1,512})||
        in.at("dtype")!="hbDNNDataType.F32"||out.at("dtype")!="hbDNNDataType.F32")
      throw std::invalid_argument("face_embedding_shape");
  }else{
    if(m.at("adapter")!="scrfd_bpu"||m.at("task")!="face_detect_kps"||m.at("input_contract")!="float_nchw"||
        m.at("output_contract")!="scrfd_9_heads"||pre.at("normalize")!=true||
        pre.at("mean")!=Json::array({127.5,127.5,127.5})||pre.at("std")!=Json::array({128.,128.,128.})||
        !m.at("inputs").is_array()||m.at("inputs").size()!=1||
        m.at("inputs").at(0).at("shape")!=Json::array({1,3,640,640})||
        !m.at("outputs").is_array()||m.at("outputs").size()!=9)
      throw std::invalid_argument("face_detector_contract");
  }
  return spec;
}
inline ModelSpec ReadSpec(const std::string& root,const std::string& id,bool embedding) {
  const std::set<std::string> allowed=embedding?std::set<std::string>{"face-embed-mbf","face-embed-r50"}:
    std::set<std::string>{"face-det-scrfd-500m","face-det-scrfd-2g5"};
  if(!allowed.contains(id))throw std::invalid_argument("unsupported_face_model");
  const auto base=std::filesystem::canonical(std::filesystem::path(root)/"models/derived/s100p");
  const auto path=std::filesystem::canonical(base/(id+".hbm"));
  const auto sidecar=std::filesystem::canonical(base/(id+".hbm.ainvr.json"));
  if(path.parent_path()!=base||sidecar.parent_path()!=base||!std::filesystem::is_regular_file(sidecar)||
      std::filesystem::file_size(sidecar)>65536)throw std::invalid_argument("face_model_path");
  std::ifstream file(sidecar);std::string data(65537,'\0');file.read(data.data(),data.size());data.resize(file.gcount());
  if(data.empty()||data.size()>65536)throw std::invalid_argument("face_manifest_size");
  return ParseManifest(id,path.string(),Json::parse(data),embedding);
}
inline std::string SpaceHash(const ModelSpec& spec) {
  // Detector identity is pinned separately. MBF/R50 and preprocessing revisions
  // never share a vector space merely because all emit 512 floats.
  return Sha256(Json{{"schema","ainvr.face-space.v1"},{"hbm_sha256",spec.hbm_hash},
    {"input_spec_version",kInputVersion},{"template",kTemplate},{"dimensions",kDimensions},
    {"rgb",true},{"mean",127.5},{"divisor",127.5},{"normalization","l2"},
    {"aligned_pixel_format","rgb8"},{"jpeg_color","bt601_full"}}.dump());
}
struct Settings {
  bool enabled=false;
  uint64_t generation=0;
  ModelSpec detector,embedding;
  std::string space_hash;
};
using Demand=std::map<std::string,std::set<std::string>>;
inline void AppendDemand(Demand& demand,const Settings& settings) {
  if(!settings.enabled)return;
  demand[settings.detector.path+":"].insert("face-identity/detection");
  demand[settings.embedding.path+":"].insert("face-identity/embedding");
}
} // namespace ainvr::face
