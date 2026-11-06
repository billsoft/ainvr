#pragma once
#include "request.hpp"
#include "layout.hpp"
#include <algorithm>
namespace ainvr::llm {
inline constexpr const char* kFocusTemplate="target-review-abc-v1";
inline const std::string& FocusPrompt(){
 static const std::string value="你是监控图像审核员。蓝色线条表示布防区（出现类告警没有布防区）；绿色框如有则表示本次指定目标。只核对中央指定主体的类别，不判断进入或穿越行为，也不要用旁边其他人代替。\n请选择一个类别：\nA：指定主体是真实的人，可以辨认出人的身体或肢体结构，不要求头部完整。\nB：指定主体是非人的物品或背景，例如设备、布条、地面、海报或倒影。\nC：主体太暗、太小、模糊、遮挡或目标指向不明确，无法确定属于A还是B。\n只输出一个字母：A、B或C。";
 return value;
}
inline std::string FocusInput(const ModelShape& shape){
 std::string text="<|im_start|>user\n<|vision_start|>";
 for(int i=0;i<shape.image_tokens;++i)text+="<|image_pad|>";
 return text+"<|vision_end|>"+FocusPrompt()+"<|im_end|>\n<|im_start|>assistant\n";
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
