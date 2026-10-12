// Copyright AINVR. Batch geometry adapter for golden-fixture comparison.
#include "output/snapshot_plan.hpp"
#include <nlohmann/json.hpp>
#include <fstream>
#include <iostream>
int main(int argc,char**argv){try{
  if(argc!=2)throw std::runtime_error("Expected fixture path");
  std::ifstream file(argv[1]);nlohmann::json input;file>>input;nlohmann::json output=nlohmann::json::array();
  for(const auto& c:input){
    ai_service::config::SnapshotConfig cfg;cfg.padding_ratio=c.at("padding_ratio");cfg.max_crop_dimension=c.at("max_dimension");cfg.projection_mode=c.at("mode");
    auto p=ainvr::PlanSnapshot(c.at("bbox").get<std::array<double,4>>(),c.at("width"),c.at("height"),cfg,c.value("square",false));
    if(!p){output.push_back(nullptr);continue;}
    output.push_back({{"width",p->width},{"height",p->height},{"fov_h_deg",p->horizontal_fov*180/3.14159265358979323846},
      {"cx",p->center_x},{"cy",p->center_y},{"rectangle",p->source_rectangle},{"replicate",p->replicate_edges}});
  }
  std::cout<<output.dump()<<"\n";return 0;
}catch(const std::exception&e){std::cerr<<e.what()<<"\n";return 1;}}
