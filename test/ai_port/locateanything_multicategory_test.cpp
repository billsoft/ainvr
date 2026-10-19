// Copyright AINVR. LocateAnything multi-category prompt/label routing;zero neural calls.
#include <fstream>
#include <iostream>
#include "adapters/model_family_adapters.hpp"
using nlohmann::json;
namespace la=ai_service::adapters;
static void require(bool value,const char* what){if(!value)throw std::runtime_error(std::string("multi-category: ")+what);}
template<class F> static bool throws(F&& f){try{f();}catch(const std::exception&){return true;}return false;}
// Token ids of the original vocabulary (config.json / added_tokens.json).
constexpr int REF=151672,REF_END=151673,BOX=151668,BOX_END=151669,C0=151677,NONE_ID=4064,END=151645;
static std::vector<int> box(int x1,int y1,int x2,int y2){return {BOX,C0+x1,C0+y1,C0+x2,C0+y2,BOX_END};}
// Ref text tokens are opaque here;the decoded response text carries the category names.
static json response(const std::vector<std::vector<int>>& parts,const std::string& text){
  json ids=json::array(),logs=json::array();
  for(const auto& part:parts)for(int id:part){ids.push_back(id);logs.push_back(-.05);}
  return {{"generated_ids",ids},{"token_logprobs",logs},{"terminal",true},{"response",text}};
}
static std::vector<std::vector<float>> outputs(const json& r,const std::vector<int>& refs){
  std::vector<std::vector<float>> out(5);
  for(size_t i=0;i<r["generated_ids"].size();++i){
    out[0].push_back(r["generated_ids"][i].get<float>());out[1].push_back(r["token_logprobs"][i].get<float>());out[2].push_back(1);
  }
  out[3]={1};for(int v:refs)out[4].push_back(float(v));return out;
}
int main(int argc,char** argv){
  ai_service::config::ModelConfig cfg;cfg.name="locateanything-3b";cfg.adapter="locateanything_bpu";
  cfg.provider="bpu";cfg.input_size={224,448};
  cfg.prompts={{"person","person","人"},{"car","vehicle-car","汽车"},{"dog","dog","狗"}};
  cfg.description="person";cfg.label_id="person";cfg.label_name="人";
  // 1. The query is the official README detect() form, in slot order.
  require(la::LocateAnythingQuery(cfg)=="person</c>car</c>dog","query joins slots with </c>");
  auto single=cfg;single.prompts.clear();single.description="helmet";
  require(la::LocateAnythingQuery(single)=="helmet","single description unchanged");

  // 2. Ref texts in generation order map to slots;unknown names stay unmatched (-1).
  const auto r=response({{REF,8987,REF_END},box(100,100,200,300),{REF,1803,REF_END},box(500,500,700,600),box(10,10,20,20),
      {REF,5562,REF_END},{BOX,NONE_ID,BOX_END},{END}},"<ref>person</ref><box>..</box><ref>car</ref><box>..</box><box>..</box><ref>dog</ref><box><none></box><|im_end|>");
  require(la::LocateAnythingRefSlots(r,cfg.prompts)==std::vector<int>({0,1,2}),"refs map to slots");
  const auto cased=response({{REF,1,REF_END},{END}},"<ref> Car </ref><|im_end|>");
  require(la::LocateAnythingRefSlots(cased,cfg.prompts)==std::vector<int>({1}),"case/space-insensitive match");
  // Observed BPU echoes (v326):leading article dropped, plural/singular, extra spaces.
  auto tolerant=cfg;tolerant.prompts={{"a person riding a bicycle","rider","骑车人"},{"cars","car","汽车"},{"the  red   truck","truck","红色卡车"}};
  const auto echoed=response({{REF,1,REF_END},{REF,2,REF_END},{REF,3,REF_END},{END}},
      "<ref>person riding a bicycle</ref><ref>Car</ref><ref>red truck.</ref><|im_end|>");
  require(la::LocateAnythingRefSlots(echoed,tolerant.prompts)==std::vector<int>({0,1,2}),"article/plural/space/period tolerant");
  auto chinese=cfg;chinese.prompts={{"人","person","人"},{"汽车","car","汽车"}};
  require(la::LocateAnythingRefSlots(response({{REF,1,REF_END},{END}},"<ref>Person</ref><|im_end|>"),chinese.prompts)==std::vector<int>({-1}),
      "translated echo is not guessed");
  const auto unknown=response({{REF,1,REF_END},{END}},"<ref>cat</ref><|im_end|>");
  require(la::LocateAnythingRefSlots(unknown,cfg.prompts)==std::vector<int>({-1}),"unknown ref is -1");
  // Text/token disagreement is a protocol error,never a guess.
  require(throws([&]{la::LocateAnythingRefSlots(response({{REF,1,REF_END},{REF,2,REF_END},{END}},"<ref>person</ref><|im_end|>"),cfg.prompts);}),"ref count mismatch rejected");
  require(throws([&]{la::LocateAnythingRefSlots(json{{"generated_ids",r["generated_ids"]}},cfg.prompts);}),"missing response text rejected");

  // 3. Adapter labels every box with its own slot.
  auto owned=la::CreateBpuRuntimeAdapter(cfg);auto& adapter=*owned;
  ai_service::pipeline::ScaleInfo scale;scale.orig_w=1000;scale.orig_h=1000;
  const auto d=adapter.PostprocessMulti(outputs(r,{0,1,2}),scale,.25,.45,300);
  require(d.size()==3,"three boxes");
  require(d[0].label_id=="person" && d[0].class_name=="人" && d[0].query_description=="person" && d[0].class_id==0,"person slot");
  require(d[1].label_id=="vehicle-car" && d[1].class_name=="汽车" && d[1].query_description=="car" && d[1].class_id==1,"car slot");
  require(d[2].label_id=="vehicle-car" && d[2].class_id==1,"second car box keeps its group");
  require(std::abs(d[1].bbox[0]-500)<1e-9 && std::abs(d[1].bbox[2]-200)<1e-9,"geometry unchanged");
  auto meta=adapter.ResultMetadata()["grounding"];
  require(meta["complete"].get<bool>() && meta["unmatched_category_boxes"]==0,"complete metadata");
  require(meta["queried_categories"]==3,"queried category count reported");

  // 4. Boxes under an unmatched name are excluded and counted,not mislabeled.
  const auto d2=adapter.PostprocessMulti(outputs(r,{0,-1,2}),scale,.25,.45,300);
  require(d2.size()==1 && d2[0].label_id=="person","unmatched group dropped");
  require(adapter.ResultMetadata()["grounding"]["unmatched_category_boxes"]==2,"unmatched counted");

  // 5. Multi-category outputs must carry exactly one slot per ref;boxes before any ref are invalid.
  require(throws([&]{adapter.PostprocessMulti(outputs(r,{0,1}),scale,.25,.45,300);}),"slot/ref count mismatch rejected");
  require(throws([&]{adapter.PostprocessMulti(outputs(r,{0,1,3}),scale,.25,.45,300);}),"slot out of range rejected");
  require(throws([&]{auto o=outputs(r,{0,1,2});o.pop_back();adapter.PostprocessMulti(o,scale,.25,.45,300);}),"missing slot vector rejected");
  const auto orphan=response({box(1,1,5,5),{REF,8987,REF_END},box(1,1,5,5),{END}},"<box></box><ref>person</ref><box></box><|im_end|>");
  require(throws([&]{adapter.PostprocessMulti(outputs(orphan,{0}),scale,.25,.45,300);}),"box before any category rejected");
  require(!adapter.ResultMetadata()["grounding"]["complete"].get<bool>(),"failed output not complete");

  // 6. One slot is the single-description path (no ref-name matching):every box gets that row.
  auto one=cfg;one.prompts={{"person wearing a helmet","helmet-person","戴头盔的人"}};
  require(la::LocateAnythingQuery(one)=="person wearing a helmet","single slot query is its description");
  auto single_owned=la::CreateBpuRuntimeAdapter(one);
  auto four=outputs(response({{REF,1,REF_END},box(1,1,9,9),{END}},"<ref>helmeted person</ref><box></box><|im_end|>"),{});four.pop_back();
  const auto s=single_owned->PostprocessMulti(four,scale,.25,.45,300);
  require(s.size()==1 && s[0].label_id=="helmet-person" && s[0].class_name=="戴头盔的人" &&
          s[0].query_description=="person wearing a helmet","single slot labels by its row, not the echoed name");
  require(throws([&]{single_owned->PostprocessMulti(outputs(r,{0,1,2}),scale,.25,.45,300);}),"single slot rejects slot vector");
  // 7. Stopped at the token limit (status 2):keep every finished box, report incomplete.
  //    Any other non-terminal generation (status 0) still fails the frame.
  const auto cut=response({{REF,8987,REF_END},box(100,100,200,300),{REF,1803,REF_END},box(500,500,700,600),{BOX,C0+1,C0+2}},
      "<ref>person</ref><box>..</box><ref>car</ref><box>..</box><box><1><2>");
  require(la::LocateAnythingRefSlots(cut,cfg.prompts,true)==std::vector<int>({0,1}),"truncated refs map");
  auto cut_out=outputs(cut,{0,1});cut_out[3]={2};
  const auto partial=adapter.PostprocessMulti(cut_out,scale,.25,.45,300);
  require(partial.size()==2 && partial[1].label_id=="vehicle-car","finished boxes kept");
  meta=adapter.ResultMetadata()["grounding"];
  require(!meta["complete"].get<bool>() && meta["stopped_at_token_limit"].get<bool>(),"truncation reported");
  const auto cut_name=response({{REF,8987,REF_END},box(1,1,9,9),{REF,1803}},"<ref>person</ref><box>..</box><ref>ca");
  require(la::LocateAnythingRefSlots(cut_name,cfg.prompts,true)==std::vector<int>({0,-1}),"cut category name is unmatched");
  require(throws([&]{la::LocateAnythingRefSlots(cut_name,cfg.prompts,false);}),"cut name rejected unless truncated");
  cut_out[3]={0};
  require(throws([&]{adapter.PostprocessMulti(cut_out,scale,.25,.45,300);}),"other non-terminal still fails");
  auto single_cut=four;single_cut[0].pop_back();single_cut[1].pop_back();single_cut[2].pop_back();single_cut[3]={2};
  require(single_owned->PostprocessMulti(single_cut,scale,.25,.45,300).size()==1,"single path keeps finished box at the limit");
  require(!single_owned->ResultMetadata()["grounding"]["complete"].get<bool>(),"single truncation incomplete");

  // 8. Configuration limits:at most 8 slots,unique descriptions.
  auto many=cfg;many.prompts.clear();
  for(int i=0;i<9;++i)many.prompts.push_back({"thing"+std::to_string(i),"t"+std::to_string(i),"物"+std::to_string(i)});
  require(throws([&]{la::LocateAnythingQuery(many);}),"more than 8 slots rejected");
  // 9. Recorded BPU answers (v326 probe):C++ grouping equals the probe's own parse per category.
  size_t recorded=0,recorded_boxes=0,recorded_truncated=0;
  if(argc==2){
    std::ifstream f(argv[1]);json fixture;f>>fixture;
    for(const auto& c:fixture.at("cases")){
      if(!c.at("ok").get<bool>())continue;
      auto rec=cfg;rec.prompts.clear();int n=0;
      for(const auto& name:c.at("categories"))rec.prompts.push_back({name.get<std::string>(),"slot"+std::to_string(n++),name.get<std::string>()});
      const auto& a=c.at("answer");const bool limit=a.value("stopped_at_token_limit",false);
      require(a.at("terminal").get<bool>() || limit,"recorded answer finished or stopped at the limit");
      std::vector<std::vector<float>> out(4);
      for(size_t i=0;i<a["generated_ids"].size();++i){
        out[0].push_back(a["generated_ids"][i].get<float>());
        out[1].push_back(a["token_logprobs"][i].is_null()?0.0f:a["token_logprobs"][i].get<float>());
        out[2].push_back(a["token_logprobs"][i].is_null()?0.0f:1.0f);
      }
      out[3]={a["terminal"].get<bool>()?1.0f:2.0f};out.emplace_back();
      for(int slot:la::LocateAnythingRefSlots(a,rec.prompts,limit))out[4].push_back(float(slot));
      auto owned=la::CreateBpuRuntimeAdapter(rec);
      const auto got=owned->PostprocessMulti(out,scale,.25,.45,300);
      const auto g=owned->ResultMetadata()["grounding"];
      // The probe parse matched names exactly;tolerant matching may only move boxes
      // from "unknown" into a configured slot, never lose or invent any.
      size_t exact=0;
      for(const auto& [name,count]:c.at("expected_boxes").items()){
        size_t mine=0;for(const auto& d:got)mine+=d.query_description==name;
        require(mine>=count.get<size_t>(),"recorded per-category box count");exact+=count.get<size_t>();
      }
      require(got.size()+g["unmatched_category_boxes"].get<size_t>()==exact+c.at("unknown_ref_boxes").get<size_t>(),
          "recorded boxes conserved");
      require(g["complete"].get<bool>()==!limit && g["stopped_at_token_limit"].get<bool>()==limit,"recorded completeness");
      ++recorded;recorded_boxes+=got.size();recorded_truncated+=limit;
    }
    require(recorded>=30 && recorded_truncated>=1,"fixture covers cases and a token-limit stop");
  }
  std::cout<<json({{"status","completed"},{"neural_calls",0},{"recorded_answers",recorded},
      {"recorded_boxes",recorded_boxes},{"recorded_token_limit_answers",recorded_truncated},
      {"scope","LocateAnything multi-category query/slot routing only;not BPU/SEI/archive acceptance"}}).dump()<<"\n";
}
