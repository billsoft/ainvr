// Frozen metadata and synthetic packed-byte ownership only; no image processing.
#include "output/search_frame_admission.hpp"
#include <iostream>
using namespace ai_service;
using namespace ai_service::output;
using namespace ai_service::config;
size_t checks = 0;
void Check(bool good, const char* why) { ++checks; if (!good) throw std::runtime_error(why); }
int main() {
  try {
    using Json = nlohmann::json;
    const std::string input = "00000000-0000-4000-8000-000000000001", output = "00000000-0000-4000-8000-000000000002";
    Json document = {{"enabled", true}, {"reason", nullptr}, {"endpoint", "http://127.0.0.1:8400"}, {"api_token", std::string(64, 'b')},
      {"revision", std::string(64, 'a')}, {"model", {{"package_id", "candidate-package"}}}, {"valid_for_ms", 30000},
      {"limits", {{"producer_queue", 1}, {"producer_bytes", 134217728}, {"image_max_bytes", 8388608}, {"retention_days", 30}}},
      {"sampling", {{"mode", "all"}, {"channel_ids", Json::array()}, {"object", true}, {"scene", true}, {"object_interval_ms", 1000},
        {"scene_active_interval_ms", 10000}, {"scene_static_interval_ms", 60000}, {"scene_change_min_interval_ms", 3000}, {"track_slots", 8}}},
      {"sources", Json::array({{{"channel_id", output}, {"input_stream_id", input}, {"processor_id", "processor"},
        {"recording_channel_id", output}, {"input_path", "/live/intermediate"}, {"output_path", "/live/result"}, {"object", true}, {"scene", true}}})}};
    const auto clock = [] { return std::chrono::steady_clock::time_point{}; };
    auto authority = std::make_shared<SearchProducerGrantAuthority>(clock); authority->Start();
    authority->Install(ParseSearchProducerGrant(document), clock()); const auto lease = authority->Read(); Check(bool(lease), "fixture lease missing");
    auto storage = std::make_shared<ainvr::Nv12Frame>(); storage->width = 8; storage->height = 4; storage->pts = 42;
    storage->pixels.reserve(96); storage->pixels.resize(48);
    std::shared_ptr<const ainvr::Nv12Frame> raw = storage;
    Check(SearchFrameRetainedPixelBytes(*raw) == 96, "retained capacity undercounted");
    SearchFrameCapture capture; capture.mapped_pts_ns = 1000000000; capture.capture_sequence = 77; capture.captured_wall = 1.25;
    capture.worker_input_url = "rtmp://127.0.0.1:1935/live/intermediate"; capture.worker_output_url = "rtmp://localhost/live/result";
    capture.decoder_frame_index = 9; capture.original_source_pts_ns = -1000;
    auto& fence = capture.fence; fence.processor_id = "processor"; fence.stream_session_id = "processor:instance:1";
    fence.input_path = "/live/intermediate"; fence.output_path = "/live/result"; fence.source_epoch = 2;
    fence.stream_generation = 3; fence.view_reset_epoch = 5; fence.raw_width = 8; fence.raw_height = 4;
    fence.observation_width = 16; fence.observation_height = 8; fence.geometry = SearchFrameGeometryKind::FullFrameAxisScale; fence.owner_allowed = true;
    fence.projection = SearchSourceProjection::RawPlanar;
    FrameResult result; result.channel_id = "processor"; result.stream_url = capture.worker_input_url; result.frame_width = 16; result.frame_height = 8;
    result.frame_pts_ns = capture.mapped_pts_ns; result.frame_index = capture.capture_sequence;
    result.timestamp = std::numeric_limits<double>::quiet_NaN(); // Inference completion is deliberately not the capture time.
    Detection detection; detection.class_name = "person"; detection.label_id = "person"; detection.track_id = "processor:instance:1:7";
    detection.bbox = {4, 2, 4, 4}; detection.confidence = 0.9; result.detections.push_back(detection);
    result.model_extra["analytics"] = {{"status", "active"}, {"stream_session_id", fence.stream_session_id}, {"view_reset_epoch", 5},
      {"tracks", Json::array({{{"track_id", detection.track_id}, {"state", "confirmed"}, {"observation", "detected"}, {"last_observed_pts_ns", "1000000000"}}})}};
    SearchSamplingPolicy policy; const auto frame = SearchSamplingPolicy::FrameFromResult(result, input, 1250);
    Check(bool(frame) && policy.BindSource(frame->binding), "fixture policy bind failed");
    const auto object = SearchSamplingPolicy::ObjectFromResult(result, detection.track_id, true, 0.8);
    const auto proposal = policy.ProposeObject(*frame, *object); Check(bool(proposal.candidate), "fixture object not eligible");
    SearchWorkBudget budget; budget.Configure(1, 8388608);
    auto ticket = budget.TryAcquire(SearchFrameRetainedPixelBytes(*raw)); Check(bool(ticket), "fixture budget missing");
    auto accepted = FreezeSearchFrame(*lease, *proposal.candidate, result, capture, fence, raw, std::move(*ticket));
    Check(bool(accepted), "valid exact frame rejected"); Check(budget.Inspect().jobs == 1, "frozen pixels lost reservation");
    Check(accepted.frame->Selection().frame.captured_ms == 1250, "completion timestamp replaced captured wall");
    Check(accepted.frame->Source().channel_id == output && accepted.frame->Source().input_stream_id == input, "processor confused with channel UUID");
    Check(accepted.frame->Pixels().pixels.data() == raw->pixels.data(), "pixels were copied");
    Check(accepted.frame->RawProvenance().nv12_timestamp_token == 42 && accepted.frame->RawProvenance().decoder_frame_index == 9,
      "raw provenance substituted for mapped identity");
    Check(accepted.frame->RawTargetBox() == std::optional<std::array<double,4>>({2, 1, 2, 2}), "existing inverse rescale not applied");
    Check(accepted.frame->SourceDetection()->bbox == detection.bbox, "source box overwritten with raw coordinates");
    const auto& source = accepted.frame->SourceDetection()->model_extra.at("observation_source");
    Check(source.at("source_frame_index") == "77" && source.at("source_pts_ns") == "1000000000" && source.at("frame_width") == 16, "evidence identity mixed frame domains");
    Check(accepted.frame->IsCurrent(fence), "fresh fence rejected");
    for (int n = 0; n < 6; ++n) {
      auto changed = fence;
      if (n == 0) ++changed.source_epoch;
      if (n == 1) ++*changed.stream_generation;
      if (n == 2) ++changed.view_reset_epoch;
      if (n == 3) changed.stream_session_id = "other-session";
      if (n == 4) changed.raw_width = 10;
      if (n == 5) changed.owner_allowed = false;
      Check(!accepted.frame->IsCurrent(changed), "stale source/PTZ/geometry fence accepted");
    }
    auto invalid_ticket = FreezeSearchFrame(*lease, *proposal.candidate, result, capture, fence, raw, std::move(*ticket));
    Check(!invalid_ticket && invalid_ticket.error == SearchFrameAdmissionError::BudgetMissing, "moved-from reservation reused");
    Check(budget.Inspect().jobs == 1, "invalid ticket released another owner's reservation");
    accepted.frame.reset(); Check(budget.Inspect().jobs == 0, "frozen ownership leaked reservation");
    for(auto projection:{SearchSourceProjection::Unverified,SearchSourceProjection::ERP}){
      auto unverified=capture;unverified.fence.projection=projection;ticket=budget.TryAcquire(96);
      auto unsupported=FreezeSearchFrame(*lease,*proposal.candidate,result,unverified,unverified.fence,raw,std::move(*ticket));
      Check(!unsupported&&unsupported.error==SearchFrameAdmissionError::UnsupportedGeometry,"unverified panorama indexed as planar");
    }
    auto too_small = budget.TryAcquire(95); auto refused = FreezeSearchFrame(*lease, *proposal.candidate, result, capture, fence, raw, std::move(*too_small));
    Check(!refused && budget.Inspect().jobs == 0, "insufficient reservation retained pixels");
    auto stale = fence; ++stale.view_reset_epoch; ticket = budget.TryAcquire(96);
    refused = FreezeSearchFrame(*lease, *proposal.candidate, result, capture, stale, raw, std::move(*ticket));
    Check(!refused && budget.Inspect().jobs == 0, "race during inference retained stale frame");
    auto lost = result; lost.model_extra["analytics"]["tracks"][0]["observation"] = "lost"; ticket = budget.TryAcquire(96);
    refused = FreezeSearchFrame(*lease, *proposal.candidate, lost, capture, fence, raw, std::move(*ticket));
    Check(!refused && refused.error == SearchFrameAdmissionError::ObjectNotEligible, "predicted/lost target became evidence");
    {
      auto probe=*proposal.candidate;probe.reason=SearchSamplingPolicy::Reason::ObjectProbe;probe.slot=2;
      probe.probe_reference_fingerprint=std::string(64,'b');
      ticket=budget.TryAcquire(96);auto work=FreezeSearchFrame(*lease,probe,result,capture,fence,raw,std::move(*ticket));
      Check(bool(work)&&work.frame->Selection().probe_reference_fingerprint==probe.probe_reference_fingerprint,"object_probe_freeze_preserves_reference");work.frame.reset();
      for(int invalid=0;invalid<4;++invalid){auto bad=probe;
        if(invalid==0)bad.probe_reference_fingerprint.clear();
        if(invalid==1)bad.slot=0;
        if(invalid==2)bad.probe_threshold=std::numeric_limits<double>::quiet_NaN();
        if(invalid==3)bad.reason=SearchSamplingPolicy::Reason::First;
        ticket=budget.TryAcquire(96);work=FreezeSearchFrame(*lease,bad,result,capture,fence,raw,std::move(*ticket));
        Check(!work&&work.error==SearchFrameAdmissionError::InvalidMetadata,"invalid_probe_scope_or_reason_frozen");
      }
    }
    auto scene_result = result; scene_result.detections.clear(); scene_result.model_extra["analytics"]["status"] = "detection_only";
    scene_result.model_extra["analytics"]["tracks"] = Json::array();
    SearchSamplingPolicy scene_policy; auto scene_frame = SearchSamplingPolicy::FrameFromResult(scene_result, input, 1250); scene_policy.BindSource(scene_frame->binding);
    auto scene = scene_policy.ProposeScene(*scene_frame, {true, false, {}});
    {
      auto probe=*scene.candidate;probe.reason=SearchSamplingPolicy::Reason::SceneProbe;probe.probe_reference_fingerprint=std::string(64,'c');
      ticket=budget.TryAcquire(96);auto work=FreezeSearchFrame(*lease,probe,scene_result,capture,fence,raw,std::move(*ticket));
      Check(bool(work)&&!work.frame->Selection().slot,"scene_probe_tracking_disabled_freeze");work.frame.reset();
    }
    ticket = budget.TryAcquire(96);
    auto scene_work = FreezeSearchFrame(*lease, *scene.candidate, scene_result, capture, fence, raw, std::move(*ticket));
    Check(bool(scene_work) && !scene_work.frame->SourceDetection() && !scene_work.frame->RawTargetBox(), "tracking-disabled scene depends on target");
    authority->Invalidate(); Check(!scene_work.frame->IsCurrent(fence), "revoked grant retained authority");
    Check(budget.Inspect().jobs == 1, "revocation freed pixels still in use");
    scene_work.frame.reset(); Check(budget.Inspect().jobs == 0, "scene release leaked budget");
    std::cout << "search frame admission: " << checks << " software checks passed; no hardware hook or encoding\n";
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
