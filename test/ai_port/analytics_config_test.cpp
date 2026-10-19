// Copyright AINVR.
#include "../../ai-service/src/analytics/config.hpp"
#include <cassert>
#include <iostream>
using namespace ai_service::analytics;
int main() {
  using nlohmann::json;
  auto original=ToJson(Config{});
  assert(ToJson(FromJson(original))==original);
  for(const auto& bad:std::vector<json>{
      {{"enabled",1}},{{"maximum_tracks",1.5}},{{"extra",1}},
      {{"max_gap_seconds",0}},{{"association_distance",2}},
      {{"rules",json::array({{{"id","x"},{"type","bad"},{"points",json::array()}}})}}}) {
    bool rejected=false;
    try {FromJson(bad);} catch(const std::exception&) {rejected=true;}
    assert(rejected);
  }
  json valid={{"enabled",true},{"rules",json::array({
    {{"id","door"},{"type","line"},{"points",{{0.5,0.1},{0.5,0.9}}}}})}};
  auto cfg=FromJson(valid);
  assert(cfg.enabled&&cfg.options.rules.size()==1);
  assert(ToJson(FromJson(ToJson(cfg)))==ToJson(cfg));
  auto review=valid;review["review"]={{"enabled",true},{"model_path","/models/reviewer.hbm"},{"description","a person"},{"timeout_seconds",30}};
  assert(ToJson(FromJson(ToJson(FromJson(review))))==ToJson(FromJson(review)));
  for(auto bad:std::vector<json>{
      {{"enabled",true},{"model_path","../relative.hbm"},{"description","person"}},
      {{"enabled",true},{"model_path","/model.hbm"},{"description","  "}},
      {{"enabled",1}},{{"timeout_seconds",301}},{{"max_new_tokens",257}},{{"unknown",1}}}) {
    auto input=valid;input["review"]=bad;bool rejected=false;
    try{FromJson(input);}catch(const std::exception&){rejected=true;}assert(rejected);
  }
  review["review"]["model_path"]="models/reviewer.hbm";assert(FromJson(review).review.enabled);
  review["save_events"]=false;bool rejected=false;
  try{FromJson(review);}catch(const std::exception&){rejected=true;}assert(rejected);
  auto notification=valid;
  notification["notification"]={{"enabled",true},{"require_review",false},{"endpoint","http://127.0.0.1:9000/events"}};
  assert(ToJson(FromJson(ToJson(FromJson(notification))))==ToJson(FromJson(notification)));
  for(auto invalid:std::vector<json>{
    {{"enabled",true},{"require_review",true},{"endpoint","https://receiver/events"}},
    {{"enabled",true},{"endpoint","file:///tmp/x"}},{{"enabled",1}},{{"require_review",0}},{{"extra",true}}}) {
    auto input=valid;input["notification"]=invalid;bool rejected=false;
    try{FromJson(input);}catch(const std::exception&){rejected=true;}assert(rejected);
  }
  std::cout<<"analytics strict configuration and round trip: PASS\n";
}
