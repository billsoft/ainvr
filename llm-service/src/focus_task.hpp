#pragma once
#include "request.hpp"
#include "layout.hpp"
#include <algorithm>
#include <map>
namespace ainvr::llm {
inline constexpr const char* kFocusTemplate="target-review-abc-v1";
inline std::string FocusPrompt(const nlohmann::json& context=nullptr){
 static const std::string value="你是监控图像审核员。蓝色线条表示布防区；无区域规则不需要布防区；绿色框如有则表示本次指定目标。只核对中央指定主体的类别，不判断进入或穿越行为，也不要用旁边其他人代替。\n请选择一个类别：\nA：指定主体是真实的人，可以辨认出人的身体或肢体结构，不要求头部完整。\nB：指定主体是非人的物品或背景，例如设备、布条、地面、海报或倒影。\nC：主体太暗、太小、模糊、遮挡或目标指向不明确，无法确定属于A还是B。\n只输出一个字母：A、B或C。";
 if(context.is_null()){
   static const std::string legacy=[](){auto text=value;const std::string current="蓝色线条表示布防区；无区域规则不需要布防区；";text.replace(text.find(current),current.size(),"蓝色线条表示布防区（出现类告警没有布防区）；");return text;}();
   return legacy; // v1 callers retain the exact original prompt bytes.
 }
 const std::map<std::string,std::string> names={{"appearance","出现"},{"region_approach","接近布防区"},{"region_enter","从区域外进入布防区"},{"region_traverse","进入后离开布防区"}};
 std::string rules="先阅读告警规则，再执行本步骤。规则：人员"+names.at(context.at("behavior").get<std::string>())+"。";
 rules+=context.at("region_required").get<bool>()?"涉及布防区，蓝线标识区域；特写可能只包含区域内部，看不到蓝线不能认定没有区域。":"不涉及布防区，不要求目标处于某个区域。";
 rules+="判定点："+std::string(context.at("anchor")=="center"?"检测框中心。":"检测框底边中点。");
 rules+="持续要求："+context.at("duration_ms").dump()+"毫秒。当前关键帧角色："+context.at("roles").dump()+"。";
 if(context.contains("approach_px"))rules+="接近要求为区域外距离边界不超过"+context.at("approach_px").dump()+"原图像素。";
 if(context.value("scope",std::string())=="spatial_observation"){
   return rules+"本图为同一真实时刻包含完整布防区与相关目标的视野，蓝线是布防区，绿框指定目标，黄色点是实际判定点。现在只复核绿框目标与区域的空间关系，不推断完整进入/穿越过程。待核对主张：绿框的"+std::string(context.at("anchor")=="center"?"中心点":"底边中点")+(context.at("expected_inside").get<bool>()?"位于布防区内部。":"位于布防区外部。")+"该主张来自检测数据，可能错误，请独立看图。A：画面清楚支持所述关系；B：画面清楚与所述关系矛盾；C：边界、目标或判定点不清楚，无法确定。只输出一个字母A、B或C。";
 }
 return value; // Keep the versioned category task concise; full rules belong to spatial review.

}
inline std::string FocusInput(const ModelShape& shape,const nlohmann::json& context=nullptr){
 std::string text="<|im_start|>user\n<|vision_start|>";
 for(int i=0;i<shape.image_tokens;++i)text+="<|image_pad|>";
 return text+"<|vision_end|>"+FocusPrompt(context)+"<|im_end|>\n<|im_start|>assistant\n";
}
inline nlohmann::json FocusScores(const std::vector<float>& logits,const nlohmann::json& vocabulary){
 const auto words=vocabulary.at("words").get<std::vector<std::string>>();
 if(logits.size()!=words.size())throw std::runtime_error("focus decision vocabulary mismatch");
 std::array<double,3> values{};
 for(int i=0;i<3;++i){const std::string word(1,char('A'+i));const auto at=std::find(words.begin(),words.end(),word);
  if(at==words.end()||std::count(words.begin(),words.end(),word)!=1)throw std::runtime_error("focus decision token missing");
  values[i]=logits.at(at-words.begin());if(!std::isfinite(values[i]))throw std::runtime_error("invalid focus decision logit");}
 const double peak=*std::max_element(values.begin(),values.end());double total=0;
 for(auto& v:values){v=std::exp(v-peak);total+=v;}
 return {{"person",values[0]/total},{"non_person",values[1]/total},{"uncertain",values[2]/total}};
}
}
