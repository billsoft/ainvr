// Copyright AINVR. Model-independent label ownership; no duplicate rule observations.
#pragma once
#include "output/result.hpp"
#include <map>
#include <algorithm>
#include <set>
#include <cmath>
namespace ai_service::adapters {
class PipelineLabels {
 public:
  struct Label {std::string id,name,owner,description;int class_id;};
  struct Fusion {std::vector<Detection> detections;nlohmann::json unassociated=nlohmann::json::array();size_t omitted=0;};
  void Add(const std::string& node,const nlohmann::json& catalog,bool named_semantics){
    adapters_[node]=catalog.value("adapter",std::string("unknown"));
    if(catalog.contains("attributes"))for(const auto& [key,value]:catalog.at("attributes").items()){
      if(attributes_.contains(key)&&attributes_.at(key)!=value)throw std::runtime_error("Incompatible pipeline attribute schemas");
      attributes_[key]=value;
    }
    for(const auto& row:catalog.at("labels")){
      const int local=row.at("class_id");const std::string name=row.at("name");
      const auto original=row.at("label_id").get<std::string>();
      // Custom prompt labels only merge through their explicit stable identity.
      const auto semantic=named_semantics?"builtin:"+name:"label:"+original;
      auto found=semantics_.find(semantic);
      if(found!=semantics_.end()){if(!named_semantics && found->second.description!=row.value("description",std::string()))throw std::runtime_error("Same label identity has conflicting descriptions");labels_[{node,local}]=found->second;continue;}
      Label label{node=="primary"?original:"node:"+node+":"+original,name,node,row.value("description",std::string()),
        node=="primary"?local:int(semantics_.size())};
      if(semantics_.size()>=128)throw std::runtime_error("Merged label catalog exceeds 128 labels");
      semantics_[semantic]=label;labels_[{node,local}]=label;
    }
  }
  std::vector<Detection> Map(const std::string& node,std::vector<Detection> input) const {
    std::vector<Detection> out;
    for(auto& d:input){const auto it=labels_.find({node,d.class_id});
      if(it==labels_.end())throw std::runtime_error("Unknown pipeline output label");
      const auto& label=it->second;if(label.owner!=node)continue;
      d.model_extra["source_node"]=node;d.model_extra["source_class_id"]=d.class_id;
      d.class_id=label.class_id;d.label_id=label.id;d.class_name=label.name;out.push_back(std::move(d));
    }return out;
  }
  // Invoked once with outputs from the SAME leased source frame. Additional
  // observations never create a second tracked person or replace the owner box.
  Fusion Merge(std::vector<std::pair<std::string,std::vector<Detection>>> inputs) const {
    Fusion out;
    std::vector<std::pair<std::string,Detection>> auxiliary;
    for(auto& [node,rows]:inputs)for(auto& d:rows){
      const auto it=labels_.find({node,d.class_id});
      if(it==labels_.end())throw std::runtime_error("Unknown pipeline output label");
      const auto& label=it->second;
      d.model_extra["source_node"]=node;d.model_extra["source_class_id"]=d.class_id;
      d.class_id=label.class_id;d.label_id=label.id;d.class_name=label.name;
      if(label.owner==node)out.detections.push_back(std::move(d));
      else if(d.model_extra.contains("attributes")&&d.model_extra["attributes"].is_object()&&!d.model_extra["attributes"].empty())
        auxiliary.emplace_back(node,std::move(d));
    }
    const auto iou=[](const Detection& a,const Detection& b){
      for(const auto* d:{&a,&b}){for(const auto v:d->bbox)if(!std::isfinite(v))return 0.0;if(d->bbox[2]<=0||d->bbox[3]<=0)return 0.0;}
      const double w=std::max(0.0,std::min(a.bbox[0]+a.bbox[2],b.bbox[0]+b.bbox[2])-std::max(a.bbox[0],b.bbox[0]));
      const double h=std::max(0.0,std::min(a.bbox[1]+a.bbox[3],b.bbox[1]+b.bbox[3])-std::max(a.bbox[1],b.bbox[1]));
      const double area=w*h,denominator=a.bbox[2]*a.bbox[3]+b.bbox[2]*b.bbox[3]-area;
      return std::isfinite(denominator)&&denominator>0?area/denominator:0.0;
    };
    const auto unresolved=[&](const std::string& node,const Detection& d,const char* reason){
      // Bound optional display evidence independently of the detector output.
      if(out.unassociated.size()>=32||d.model_extra.at("attributes").dump().size()>2048){++out.omitted;return;}
      out.unassociated.push_back({{"source_node",node},{"label_id",d.label_id},{"bbox",d.bbox},
        {"attributes",d.model_extra.at("attributes")},{"association","unknown"},{"reason",reason}});
    };
    for(size_t a=0;a<auxiliary.size();++a){
      const auto& [node,d]=auxiliary[a];double best=0,second=0;size_t target=out.detections.size();
      for(size_t i=0;i<out.detections.size();++i){const auto& primary=out.detections[i];if(primary.label_id!=d.label_id)continue;
        const auto score=iou(primary,d);if(score>best){second=best;best=score;target=i;}else second=std::max(second,score);
      }
      if(best<.5||best-second<.1||target==out.detections.size()){unresolved(node,d,"ambiguous_or_unmatched");continue;}
      // Reciprocal uniqueness: two auxiliary people must not attach to one owner.
      bool unique=true;
      for(size_t j=0;j<auxiliary.size();++j)if(j!=a&&auxiliary[j].first==node&&auxiliary[j].second.label_id==d.label_id&&iou(out.detections[target],auxiliary[j].second)>best-.1){unique=false;break;}
      if(!unique){unresolved(node,d,"ambiguous_or_unmatched");continue;}
      auto attributes=out.detections[target].model_extra.value("attributes",nlohmann::json::object());
      bool conflict=false;
      for(const auto& [key,value]:d.model_extra.at("attributes").items()){
        if(attributes.contains(key)){conflict=true;continue;}
        auto attributed=value.is_object()?value:nlohmann::json{{"value",value}};
        attributed["source_node"]=node;attributed["association"]={{"method","same_frame_mutual_iou"},{"iou",best}};
        attributes[key]=std::move(attributed);
      }
      if(attributes.dump().size()>2048){unresolved(node,d,"attribute_budget");continue;}
      out.detections[target].model_extra["attributes"]=std::move(attributes);
      if(conflict)unresolved(node,d,"owner_attribute_preserved");
    }
    return out;
  }
  nlohmann::json Catalog()const{auto rows=nlohmann::json::array();for(const auto& [key,label]:semantics_)rows.push_back({{"class_id",label.class_id},{"label_id",label.id},{"name",label.name},{"description",label.description},{"source_node",label.owner},{"source_adapter",adapters_.at(label.owner)}});std::sort(rows.begin(),rows.end(),[](const auto& a,const auto& b){return a.at("class_id").template get<int>()<b.at("class_id").template get<int>();});nlohmann::json result={{"schema_version","1.0"},{"adapter","analysis_pipeline"},{"labels",rows}};if(!attributes_.empty())result["attributes"]=attributes_;return result;}
  // Catalog identity is independent of execution/priority order. Every duplicate
  // maps to one canonical label; only its selected producer changes.
  void SetPriority(const std::vector<std::string>& order) {
    for(auto& [semantic,label]:semantics_) {
      for(const auto& node:order) {
        const bool present=std::any_of(labels_.begin(),labels_.end(),[&](const auto& item){return item.first.first==node&&item.second.id==label.id;});
        if(present){label.owner=node;break;}
      }
      for(auto& [key,mapped]:labels_)if(mapped.id==label.id)mapped.owner=label.owner;
    }
  }
 private:
  std::map<std::string,Label> semantics_;
  std::map<std::string,std::string> adapters_;
  nlohmann::json attributes_=nlohmann::json::object();
  std::map<std::pair<std::string,int>,Label> labels_;
};
}
