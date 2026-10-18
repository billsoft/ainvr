// Copyright AINVR.
#include "detection_decode.hpp"
#include "pipeline/postprocessor.hpp"
#include <algorithm>
#include <atomic>
#include <cmath>
#include <map>
#include <stdexcept>
namespace ainvr {
namespace p=ai_service::pipeline;
namespace {
std::atomic<uint64_t> clamped_probabilities{0}, clamped_distances{0}, rejected_geometry{0};
// Only absorb small floating/dequantization roundoff. Large probability
// violations still indicate a wrong model contract and must fail the frame.
double Probability(float value) {
  constexpr double tolerance=1e-3;
  if(value < -tolerance || value > 1+tolerance)
    throw std::invalid_argument("Model scores must be probabilities");
  if(value<0 || value>1)++clamped_probabilities;
  return std::clamp(double(value),0.0,1.0);
}
void Validate(const p::ScaleInfo& s,const DetectionOptions& o){
  if(s.orig_w<=0||s.orig_h<=0||s.target_w<=0||s.target_h<=0||!std::isfinite(s.scale)||s.scale<=0||
     !std::isfinite(o.confidence)||o.confidence<0||o.confidence>1||!std::isfinite(o.iou)||o.iou<0||o.iou>1||o.maximum<1)
    throw std::invalid_argument("Invalid detection scale or thresholds");
}
std::pair<int64_t,int64_t> Matrix(const DenseTensor& t){
  auto shape=t.shape;if(shape.size()==3&&shape[0]==1)shape.erase(shape.begin());
  if(shape.size()!=2||shape[0]<=0||shape[1]<=0||uint64_t(shape[0])>t.values.size()/uint64_t(shape[1])||uint64_t(shape[0])*shape[1]!=t.values.size())
    throw std::invalid_argument("Invalid dense output matrix: "+t.name);
  for(float v:t.values)if(!std::isfinite(v))throw std::invalid_argument("Non-finite model output: "+t.name);
  return {shape[0],shape[1]};
}
}
DetectionDecodeStats GetDetectionDecodeStats() {
  return {clamped_probabilities.load(),clamped_distances.load(),rejected_geometry.load()};
}
std::vector<ai_service::Detection> DecodeScrfd(const std::vector<DenseTensor>& outputs,const p::ScaleInfo& s,const DetectionOptions& o){
  Validate(s,o);if(outputs.size()!=9||s.target_w%32||s.target_h%32)throw std::invalid_argument("SCRFD requires nine outputs and input dimensions divisible by 32");
  // Compiler output ordering may differ. Bind only unambiguous [anchors,columns]
  // contracts; never infer head semantics from the runtime output index.
  std::map<std::pair<int64_t,int64_t>,const DenseTensor*> heads;
  for(const auto& t:outputs)if(!heads.emplace(Matrix(t),&t).second)throw std::invalid_argument("Duplicate SCRFD head shape");
  std::vector<p::Box> boxes;std::vector<double> scores;
  std::vector<std::vector<std::array<double,2>>> landmarks;
  for(int stride:{8,16,32}){
    int fw=s.target_w/stride,fh=s.target_h/stride;int64_t count=int64_t(fw)*fh*2;
    auto get=[&](int columns)->const std::vector<float>&{auto it=heads.find({count,columns});if(it==heads.end())throw std::invalid_argument("Missing SCRFD head shape");return it->second->values;};
    const auto& score=get(1);const auto& box=get(4);const auto& kps=get(10);
    for(int64_t i=0;i<count;++i){
      const double probability=Probability(score[i]);
      if(probability<o.confidence)continue;
      double cx=(i/2%fw)*stride,cy=(i/2/fw)*stride;
      std::array<double,4> distance;bool invalid=false;
      for(int j=0;j<4;++j){
        const double value=box[i*4+j];
        if(value < -1e-3)invalid=true;
        if(value<0 && value>=-1e-3)++clamped_distances;
        distance[j]=std::max(0.0,value);
      }
      if(invalid || distance[0]+distance[2]<=0 || distance[1]+distance[3]<=0){++rejected_geometry;continue;}
      boxes.push_back({cx-distance[0]*stride,cy-distance[1]*stride,cx+distance[2]*stride,cy+distance[3]*stride});scores.push_back(probability);
      std::vector<std::array<double,2>> points;
      for(int k=0;k<5;++k)points.push_back({(cx+kps[i*10+k*2]*stride-s.pad_left)/s.scale,(cy+kps[i*10+k*2+1]*stride-s.pad_top)/s.scale});
      landmarks.push_back(std::move(points));
    }
  }
  auto keep=p::nms(boxes,scores,o.iou);if(keep.size()>size_t(o.maximum))keep.resize(o.maximum);
  std::vector<p::Box> selected;for(auto index:keep)selected.push_back(boxes[index]);
  auto original=p::xyxy2xywh(p::scale_boxes(selected,s));std::vector<ai_service::Detection> result;
  for(size_t i=0;i<keep.size();++i){auto index=keep[i];ai_service::Detection d;d.class_name="face";d.confidence=scores[index];d.bbox=original[i];d.landmarks=landmarks[index];result.push_back(std::move(d));}
  return result;
}
std::vector<ai_service::Detection> DecodeEndToEnd(const DenseTensor& t,const p::ScaleInfo& s,const std::vector<std::string>& classes,const DetectionOptions& o){
  Validate(s,o);auto [rows,columns]=Matrix(t);if(columns!=6||classes.empty())throw std::invalid_argument("End-to-end output requires six columns and explicit classes");
  std::vector<ai_service::Detection> result;
  for(int64_t row=0;row<rows;++row){
    auto* v=t.values.data()+row*6;const double probability=Probability(v[4]);
    if(probability<o.confidence)continue;
    if(v[5]<0||v[5]>=classes.size()||std::trunc(v[5])!=v[5])throw std::invalid_argument("Invalid detection class");
    if(v[2]<=v[0]||v[3]<=v[1]){++rejected_geometry;continue;}
    ai_service::Detection d;d.class_id=int(v[5]);d.class_name=classes[d.class_id];d.confidence=probability;
    d.bbox=p::xyxy2xywh(p::scale_boxes({p::Box{v[0],v[1],v[2],v[3]}},s))[0];result.push_back(std::move(d));
  }
  std::stable_sort(result.begin(),result.end(),[](const auto& a,const auto& b){return a.confidence>b.confidence;});
  if(result.size()>size_t(o.maximum))result.resize(o.maximum);return result;
}
std::vector<ai_service::Detection> DecodeYoloeRaw(const DenseTensor& t,const p::ScaleInfo& s,
    const std::vector<std::string>& classes,const DetectionOptions& o) {
  Validate(s,o);auto [rows,anchors]=Matrix(t);
  if(t.shape.size()!=3||t.shape[0]!=1||rows<5||rows>260||anchors>100000||
      classes.empty()||classes.size()>size_t(rows-4))
    throw std::invalid_argument("Invalid raw YOLOE tensor or active class count");
  for(const auto& name:classes)if(name.empty())throw std::invalid_argument("Empty active YOLOE class name");
  struct Candidate {p::Box box;double score;size_t class_id;int64_t anchor;};
  std::vector<Candidate> candidates;
  for(int64_t anchor=0;anchor<anchors;++anchor) {
    double score=-1;size_t class_id=0;
    for(size_t k=0;k<classes.size();++k) {
      const double value=Probability(t.values[(4+k)*anchors+anchor]);
      if(value>score){score=value;class_id=k;}
    }
    if(score<o.confidence)continue;
    const double x=t.values[anchor],y=t.values[anchors+anchor];
    const double w=t.values[2*anchors+anchor],h=t.values[3*anchors+anchor];
    if(w<=0||h<=0){++rejected_geometry;continue;}
    candidates.push_back({{x-w/2,y-h/2,x+w/2,y+h/2},score,class_id,anchor});
  }
  std::stable_sort(candidates.begin(),candidates.end(),[](const auto& a,const auto& b){return a.score>b.score;});
  if(candidates.size()>30000)candidates.resize(30000);
  std::map<size_t,std::vector<size_t>> groups;
  for(size_t i=0;i<candidates.size();++i)groups[candidates[i].class_id].push_back(i);
  std::vector<size_t> selected;
  for(const auto& [class_id,indices]:groups) {
    std::vector<p::Box> boxes;std::vector<double> scores;
    for(auto index:indices){boxes.push_back(candidates[index].box);scores.push_back(candidates[index].score);}
    for(auto keep:p::nms(boxes,scores,o.iou))selected.push_back(indices[keep]);
  }
  std::stable_sort(selected.begin(),selected.end(),[&](auto a,auto b){
    const auto& x=candidates[a];const auto& y=candidates[b];
    return x.score!=y.score?x.score>y.score:x.anchor<y.anchor;
  });
  if(selected.size()>size_t(o.maximum))selected.resize(o.maximum);
  std::vector<p::Box> boxes;for(auto index:selected)boxes.push_back(candidates[index].box);
  auto scaled=p::xyxy2xywh(p::scale_boxes(boxes,s));
  std::vector<ai_service::Detection> result;
  for(size_t i=0;i<selected.size();++i) {
    const auto& candidate=candidates[selected[i]];ai_service::Detection d;
    d.class_id=int(candidate.class_id);d.class_name=classes[candidate.class_id];
    d.confidence=candidate.score;d.bbox=scaled[i];result.push_back(std::move(d));
  }
  return result;
}
}
