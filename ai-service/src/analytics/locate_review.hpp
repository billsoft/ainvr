// AINVR. Target-presence review, not temporal rule verification.
#pragma once
#include "event_worker.hpp"
#include "review_image.hpp"
#include "../adapters/locateanything_bpu_adapter.hpp"
namespace ai_service::analytics {
class LocateReview {
 public:
  LocateReview(std::shared_ptr<EventStore> store,config::ModelConfig model)
      :store_(std::move(store)),model_(std::move(model)) {
    if(!store_||model_.description.empty()||model_.description.size()>4096)
      throw std::invalid_argument("Review needs an explicit target description");
    // Validate family without loading a model or allocating a GLES context.
    adapters::LocateAnythingBpuAdapter validate(model_);
  }
  EventWorker::Outcome operator()(const nlohmann::json& event,const EventWorker::Context& context) const {
    if(context.Cancelled())return {"timeout",{{"code","deadline_exceeded"}}};
    auto evidence=store_->LoadEvidence(event);
    const auto evidence_deadline=std::min(context.deadline,std::chrono::steady_clock::now()+std::chrono::seconds(10));
    while(!evidence&&!context.Cancelled()&&std::chrono::steady_clock::now()<evidence_deadline) {
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      evidence=store_->LoadEvidence(event);
    }
    if(context.Cancelled())return {"timeout",{{"code","deadline_exceeded"}}};
    if(!evidence)return {"unavailable",{{"code","original_evidence_missing"}}};
    auto details=nlohmann::json{{"scope","target_presence"},{"image_id",evidence->image_id},
      {"description",model_.description},{"model",model_.name},{"temporal_rule_verified",false},
      {"neural_provider","bpu"},{"confidence",nullptr}};
    // All GPU resources are constructed and destroyed on this handler's thread.
    adapters::LocateAnythingBpuAdapter adapter(model_);
    adapter.SetCancellationProbe([&context]{return context.Cancelled();});
    try {adapter.Load(model_.path,model_.provider,model_.engine_cache);}
    catch(const std::runtime_error& error) {
      if(std::string(error.what())!=ainvr::LocateAnythingChannelLease::kBusy)throw;
      details["code"]="model_in_use";return {"unavailable",std::move(details)};
    }
    if(context.Cancelled())return {"timeout",{{"code","deadline_exceeded"}}};
    ReviewImage image;
    auto tensor=image.Prepare(evidence->jpeg,evidence->width,evidence->height,
      context.deadline,[&context]{return context.Cancelled();});
    auto output=adapter.RunPreparedRgb(tensor);
    pipeline::ScaleInfo scale{};scale.orig_w=evidence->width;scale.orig_h=evidence->height;
    const auto detections=adapter.PostprocessMulti(output.outputs,scale,0,0,300);
    const auto grounding=adapter.ResultMetadata().at("grounding");
    if(!grounding.at("complete").get<bool>())throw std::runtime_error("Incomplete review generation");
    details["box_count"]=detections.size();details["point_count"]=grounding.at("points").size();
    details["inference_ms"]=output.inference_ms;
    details["code"]=(detections.empty()&&grounding.at("points").empty())?"target_absent":"target_present";
    return {details["code"]=="target_present"?"approved":"rejected",std::move(details)};
  }
 private:
  std::shared_ptr<EventStore> store_;config::ModelConfig model_;
};
}
