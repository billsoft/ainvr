#include "engine.hpp"
#include <fstream>
#include <iostream>
#include <chrono>
int main(int argc,char** argv) {
  try {
    if(argc<4)throw std::invalid_argument("usage: probe PACKAGE encode|infer ITEMS_JSONL [OUTPUT_JSONL]");
    ainvr::llm::Engine engine(argv[1]); bool infer=std::string(argv[2])=="infer";
    if(infer)engine.Load();
    std::ifstream items(argv[3]); if(!items)throw std::runtime_error("missing items");
    std::ofstream file; if(argc>4)file.open(argv[4]); std::ostream& output=argc>4?file:std::cout;
    std::string line;
    while(std::getline(items,line)) {
      auto item=nlohmann::json::parse(line); nlohmann::json result={{"id",item.at("id")}};
      if(infer) {
        auto start=std::chrono::steady_clock::now();
        auto logits=engine.Infer(item.at("input_ids").get<std::vector<int>>(),ainvr::llm::ReadFloats(item.at("patches")));
        result["logits"]=logits; result["real_score"]=ainvr::llm::Score(logits.at(0),logits.at(1),1);
        result["elapsed_ms"]=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
      }else result["input_ids"]=engine.Encode(item.at("kind"),item.at("desc"));
      output<<result.dump()<<std::endl;
    }
    return 0;
  }catch(const std::exception& e){std::cerr<<e.what()<<std::endl;return 1;}
}
