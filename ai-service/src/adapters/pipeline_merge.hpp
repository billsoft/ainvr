// Copyright AINVR. Model-independent label ownership; no duplicate rule observations.
#pragma once
#include "output/result.hpp"
#include <map>
#include <algorithm>
#include <set>
namespace ai_service::adapters {
class PipelineLabels {
 public:
  struct Label {std::string id,name,owner,description;int class_id;};
  void Add(const std::string& node,const nlohmann::json& catalog,bool named_semantics){
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
  nlohmann::json Catalog()const{auto rows=nlohmann::json::array();for(const auto& [key,label]:semantics_)rows.push_back({{"class_id",label.class_id},{"label_id",label.id},{"name",label.name},{"description",label.description},{"source_node",label.owner}});std::sort(rows.begin(),rows.end(),[](const auto& a,const auto& b){return a.at("class_id").template get<int>()<b.at("class_id").template get<int>();});return {{"schema_version","1.0"},{"adapter","analysis_pipeline"},{"labels",rows}};}
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
  std::map<std::pair<std::string,int>,Label> labels_;
};
}
