#include "target_crop.hpp"
#include "focus_task.hpp"
#include <cassert>
#include <limits>
int main(){
 static const std::string expected_legacy="你是监控图像审核员。蓝色线条表示布防区（出现类告警没有布防区）；绿色框如有则表示本次指定目标。只核对中央指定主体的类别，不判断进入或穿越行为，也不要用旁边其他人代替。\n请选择一个类别：\nA：指定主体是真实的人，可以辨认出人的身体或肢体结构，不要求头部完整。\nB：指定主体是非人的物品或背景，例如设备、布条、地面、海报或倒影。\nC：主体太暗、太小、模糊、遮挡或目标指向不明确，无法确定属于A还是B。\n只输出一个字母：A、B或C。";
 assert(ainvr::llm::FocusPrompt()==expected_legacy);
 const nlohmann::json vocab={{"words",{"是","A","B","C"}}};
 auto scores=ainvr::llm::FocusScores({99,10,0,-5},vocab);
 assert(scores["person"].get<double>()>.99);assert(scores["non_person"].get<double>()<.01);
 auto non=ainvr::llm::FocusScores({99,0,10,-5},vocab);assert(non["non_person"].get<double>()>.99);
 auto unknown=ainvr::llm::FocusScores({99,0,-5,10},vocab);assert(unknown["uncertain"].get<double>()>.99);
 bool rejected=false;try{ainvr::llm::FocusScores({0,1},vocab);}catch(...){rejected=true;}assert(rejected);
 const nlohmann::json context={{"behavior","appearance"},{"anchor","bottom_center"},{"duration_ms",1000},{"region_required",true},{"roles",{"首次有效检出"}}};
 assert(ainvr::llm::FocusPrompt(context)!=ainvr::llm::FocusPrompt());assert(ainvr::llm::FocusPrompt().find("出现类告警没有布防区")!=std::string::npos);assert(ainvr::llm::FocusPrompt(context).find("无区域规则不需要布防区")!=std::string::npos);auto spatial=context;spatial["scope"]="spatial_observation";spatial["expected_inside"]=true;const auto task=ainvr::llm::FocusPrompt(spatial);assert(task.find("先阅读告警规则")!=std::string::npos);assert(task.find("可能错误")!=std::string::npos);assert(task.find("不推断完整")!=std::string::npos);
 const std::array<float,4> b{.4f,0,.5f,.2f};
 const auto tight=ainvr::TargetCrop(b,1920,1080,true,1.15f);
 const auto wide=ainvr::TargetCrop(b,1920,1080,true,1.6f);
 const auto legacy=ainvr::TargetCrop(b,1920,1080,false);
 assert(std::abs(tight[2]/tight[3]-192.f/216)<1e-5);
 assert(tight[1]<0);
 const auto canvas=ainvr::TargetCanvas(b,1920,1080,1.15f);
 assert(std::abs(canvas[0]+canvas[2]-1)<1e-5);assert(std::abs(canvas[1]+canvas[3]-1)<1e-5);
 const auto visible=ainvr::VisibleCanvas(b,1920,1080,1.15f);
 assert(visible[0]>0&&visible[2]<1&&visible[1]>0);
 auto region=ainvr::RegionCanvas({{.1f,.1f},{.9f,.9f}},b,1920,1080,1.15f);
 assert(region[0][0]<0&&region[1][0]>1); // don't close a cropped polygon at a fake boundary
 assert(ainvr::RegionCanvas({},b,1920,1080,1.15f).empty());
 assert(canvas[0]>0&&canvas[1]>0&&canvas[2]<1&&canvas[3]<1);
 assert(std::abs(tight[0]+tight[2]/2-(wide[0]+wide[2]/2))<1e-4);
 assert(std::abs(tight[1]+tight[3]/2-(wide[1]+wide[3]/2))<1e-4);
 assert(std::abs(legacy[2]/legacy[3]-2)<1e-5);
 assert(tight[2]<legacy[2]);
 for(auto bad: {std::array<float,4>{0,0,0,.5},std::array<float,4>{0,-.1f,.2,.3},std::array<float,4>{0,0,1.1f,1}}){bool failed=false;try{ainvr::TargetCrop(bad,1280,720,true);}catch(...){failed=true;}assert(failed);}
 bool failed=false;try{ainvr::TargetCrop(b,1280,720,true,std::numeric_limits<float>::quiet_NaN());}catch(...){failed=true;}assert(failed);
}
