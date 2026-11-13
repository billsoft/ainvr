// Software-only fixtures. No installed model reads, SDK allocation or image math.
#pragma once
#include "face_embedding/manifest.hpp"
namespace face_test {
using namespace ainvr::face;
inline ModelSpec Spec(const std::string& id="face-embed-mbf",bool embedding=true) {
  Json m={{"schema_version",1},{"target","rdk_s100p"},{"hbm_file",id+".hbm"},
    {"hbm_sha256",std::string(64,embedding?(id=="face-embed-mbf"?'a':'c'):'b')},{"hbm_bytes",4096}};
  if(embedding){
    m["task"]="face_embedding_512";m["adapter"]=nullptr;m["adapter_planned"]="arcface_bpu";
    m["input_contract"]="float_nchw_rgb_aligned112";
    m["output_contract"]="embedding[1,512]; L2-normalise, compare by cosine";
    m["preprocess"]={{"rgb_order",true},{"normalize","(x-127.5)/127.5"},
      {"alignment","similarity transform of 5 landmarks to ArcFace 112x112 template"}};
    m["inputs"]={{"input.1",{{"shape",{1,3,112,112}},{"dtype","hbDNNDataType.F32"}}}};
    m["outputs"]={{"516",{{"shape",{1,512}},{"dtype","hbDNNDataType.F32"}}}};
  }else{
    m["task"]="face_detect_kps";m["adapter"]="scrfd_bpu";m["input_contract"]="float_nchw";m["output_contract"]="scrfd_9_heads";
    m["preprocess"]={{"rgb_order",true},{"normalize",true},{"mean",{127.5,127.5,127.5}},{"std",{128,128,128}}};
    m["inputs"]=Json::array({{{"name","input.1"},{"shape",{1,3,640,640}}}});m["outputs"]=Json::array();
    for(int stride:{8,16,32})for(int columns:{1,4,10})m["outputs"].push_back({{"shape",{640/stride*640/stride*2,columns}}});
  }
  return ParseManifest(id,"/fixture/models/"+id+".hbm",m,embedding);
}
inline Candidate Face() {
  Candidate c;c.box={0,0,112,112};c.landmarks=kTemplate;c.has_landmarks=true;c.detection_score=.8;return c;
}
} // namespace face_test
