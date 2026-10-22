#include "layout.hpp"
#include <nlohmann/json.hpp>
#include <fstream>
#include <iostream>
int main(int argc,char** argv) {
  try {
    if(argc!=3)throw std::invalid_argument("usage: layout_probe INPUT OUTPUT");
    std::ifstream input(argv[1]); nlohmann::json j; input>>j;
    auto ids=j.at("input_ids").get<std::vector<int>>();
    nlohmann::json out; out["positions"]=ainvr::llm::Positions(ids);
    out["chunks"]=nlohmann::json::array();
    for(auto c:ainvr::llm::PrefillPlan(ids.size())) {
      std::vector<float> mask(c.profile*1024); ainvr::llm::FillMask(c,mask.data());
      out["chunks"].push_back({{"start",c.start},{"rows",c.rows},{"profile",c.profile},{"mask",mask}});
    }
    out["score"]=ainvr::llm::Score(j.value("yes",1.f),j.value("no",0.f),j.value("temperature",1.0));
    std::ofstream(argv[2])<<out.dump(); return 0;
  }catch(const std::exception& e){std::cerr<<e.what()<<std::endl;return 1;}
}
