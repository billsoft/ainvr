// Metadata/state-machine tests only: no sockets, models, image work or services.
#include "output/search_sampling_policy.hpp"
#include <iomanip>
#include <iostream>
#include <sstream>
#include <functional>
using namespace ai_service;
using namespace ai_service::output;
using Policy = SearchSamplingPolicy;
size_t checks = 0;
void Check(bool value, const char* message) { ++checks; if (!value) throw std::runtime_error(message); }
void Reject(const std::function<void()>& call) { bool failed = false; try { call(); } catch (...) { failed = true; } Check(failed, "expected invalid configuration rejection"); }
std::string Fingerprint(Policy::Token token) { std::ostringstream out; out << std::hex << std::setw(64) << std::setfill('0') << token; return out.str(); }
SearchSamplingBinding Binding(const std::string& session = "processor:instance:1") { return {"source", "processor", session, 1920, 1080}; }
SearchSamplingFrame Frame(int64_t ms, int64_t index, const SearchSamplingBinding& binding = Binding(), const std::string& status = "active") {
  return {binding, ms * 1000000LL, index, 1790000000000LL + ms, status};
}
SearchSamplingObject Object(const SearchSamplingFrame& frame, const std::string& id = "track-1",
                            std::optional<double> quality = 0.2, std::optional<double> change = {}) {
  return {id, "confirmed", "detected", frame.source_pts_ns, true, true, quality, change,
    frame.binding.processor_id, frame.binding.stream_session_id, frame.source_frame_index};
}
Policy::Candidate Proposed(const Policy::Proposal& proposal) {
  Check(proposal.status == Policy::Status::Proposed && bool(proposal.candidate), "eligible candidate not proposed");
  return *proposal.candidate;
}
void Commit(Policy& policy, const Policy::Candidate& candidate) {
  Check(policy.Resolve(candidate.token, Policy::Outcome::Committed, Fingerprint(candidate.token)), "acknowledged sample not committed");
}
void ObjectTransactions() {
  Policy policy; Check(policy.BindSource(Binding()), "source bind failed");
  const auto zero = Frame(0, 0); auto first = Proposed(policy.ProposeObject(zero, Object(zero)));
  Check(first.slot == 0 && first.reason == Policy::Reason::First && first.expected_fingerprint.empty(), "first frame slot contract");
  auto snapshot = policy.Inspect(Binding(), "track-1");
  Check(snapshot && snapshot->Count() == 0 && !snapshot->best_quality && snapshot->last_committed_pts_ns == -1, "proposal consumed committed state");
  Check(!policy.Retry(first.token), "in-flight work offered for duplicate retry");
  Check(policy.Resolve(first.token, Policy::Outcome::Unknown), "unknown acknowledgement rejected");
  const auto retry = policy.Retry(first.token);
  Check(retry && retry->token == first.token && retry->frame.source_pts_ns == 0 && retry->frame.source_frame_index == 0, "unknown result changed candidate/frame");
  auto next_frame = Frame(1000, 10);
  Check(policy.ProposeObject(next_frame, Object(next_frame)).status == Policy::Status::Pending, "unknown pending admitted another frame");
  Check(!policy.Resolve(first.token, Policy::Outcome::Committed, "invalid"), "invalid fingerprint consumed pending slot");
  Check(policy.Resolve(first.token, Policy::Outcome::Failed), "known-not-committed failure rejected");
  Check(policy.Usage().tracks == 0 && policy.Usage().pending == 0, "failed initial capture leaked empty track/pending");
  first = Proposed(policy.ProposeObject(next_frame, Object(next_frame)));
  Check(first.slot == 0, "failed first capture consumed first slot or interval"); Commit(policy, first);
  snapshot = policy.Inspect(Binding(), "track-1");
  Check(snapshot->Count() == 1 && snapshot->best_quality == 0.2 && snapshot->last_committed_pts_ns == 1000000000LL, "first ack did not establish metadata");
  Check(!policy.Resolve(first.token, Policy::Outcome::Committed, Fingerprint(first.token)), "late duplicate ack mutated state");
  next_frame = Frame(2000, 20);
  auto best = Proposed(policy.ProposeObject(next_frame, Object(next_frame, "track-1", 0.3)));
  Check(best.slot == 1 && best.reason == Policy::Reason::Best, "best frame not separated from first");
  Check(policy.Resolve(best.token, Policy::Outcome::Failed), "encoding failure not released");
  Check(policy.Inspect(Binding(), "track-1")->best_quality == 0.2, "encoding failure improved best score");
  best = Proposed(policy.ProposeObject(next_frame, Object(next_frame, "track-1", 0.3))); Commit(policy, best);
  auto too_soon = Frame(2500, 25);
  Check(policy.ProposeObject(too_soon, Object(too_soon, "track-1", 0.9)).status == Policy::Status::NotDue, "object interval used attempted frame instead of committed frame");
  next_frame = Frame(3000, 30);
  auto better = Proposed(policy.ProposeObject(next_frame, Object(next_frame, "track-1", 0.5)));
  Check(better.slot == 1 && better.expected_fingerprint == Fingerprint(best.token), "best replacement missing CAS generation");
  Check(policy.Resolve(better.token, Policy::Outcome::Unknown), "unknown best result rejected");
  Check(policy.Inspect(Binding(), "track-1")->best_quality == 0.3, "unknown ack changed best score");
  Check(!policy.Resolve(better.token, Policy::Outcome::Committed, Fingerprint(best.token)), "unchanged generation accepted for new image");
  Commit(policy, better);
  const auto preserved_first = policy.Inspect(Binding(), "track-1")->slots[0]->fingerprint;
  const auto preserved_best = policy.Inspect(Binding(), "track-1")->slots[1]->fingerprint;
  for (int n = 0; n < 134; ++n) {
    auto frame = Frame(4000 + n * 1000, 40 + n * 10);
    auto change = Proposed(policy.ProposeObject(frame, Object(frame, "track-1", 0.4, 0.8)));
    Check(change.slot && *change.slot >= 2 && *change.slot < 8 && change.reason == Policy::Reason::Change, "change overwrote first/best slot");
    if (n == 6) {
      const auto before = policy.Inspect(Binding(), "track-1");
      Check(!change.expected_fingerprint.empty(), "full track changed UUID instead of replacing slot");
      Check(policy.Resolve(change.token, Policy::Outcome::Failed), "replacement encoding failure not released");
      Check(policy.Inspect(Binding(), "track-1")->slots[*change.slot]->fingerprint == before->slots[*change.slot]->fingerprint, "failed replacement erased previous evidence");
      change = Proposed(policy.ProposeObject(frame, Object(frame, "track-1", 0.4, 0.8)));
    }
    Commit(policy, change);
    snapshot = policy.Inspect(Binding(), "track-1");
    Check(snapshot->Count() <= 8 && snapshot->slots[0]->fingerprint == preserved_first && snapshot->slots[1]->fingerprint == preserved_best, "long track grew or lost first/best evidence");
  }
  Check(policy.Inspect(Binding(), "track-1")->Count() == 8, "change slots did not fill bounded track");
}
void BindingAndTimelineFences() {
  SearchSamplingConfig config; config.max_pending = 4; Policy policy(config); policy.BindSource(Binding());
  auto frame = Frame(1000, 10); const auto old = Proposed(policy.ProposeObject(frame, Object(frame)));
  policy.Resolve(old.token, Policy::Outcome::Unknown);
  Check(policy.BindSource(Binding()) && policy.Retry(old.token).has_value(), "idempotent binding cancelled valid work");
  const auto newer = Binding("processor:instance:2"); Check(policy.BindSource(newer), "new session bind failed");
  Check(policy.Usage().tracks == 0 && policy.Usage().pending == 0, "new session retained old sampler state");
  Check(!policy.Resolve(old.token, Policy::Outcome::Committed, Fingerprint(old.token)), "old session ack changed new session");
  Check(policy.ProposeObject(Frame(900000, 9000), Object(Frame(900000, 9000))).status == Policy::Status::Unbound, "late old session rolled binding back");
  frame = Frame(0, 0, newer); const auto current = Proposed(policy.ProposeObject(frame, Object(frame))); Commit(policy, current);
  auto resized = newer; resized.width = 1280; resized.height = 720;
  Check(policy.ProposeObject(Frame(1000, 10, resized), Object(Frame(1000, 10, resized))).status == Policy::Status::Unbound, "unexpected geometry silently rebound source");
  Check(policy.Inspect(newer, "track-1")->Count() == 1, "wrong geometry cleared valid source");
  frame = Frame(1000, 10, newer); const auto old_geometry = Proposed(policy.ProposeObject(frame, Object(frame, "track-1", 0.6)));
  policy.BindSource(resized);
  Check(!policy.Resolve(old_geometry.token, Policy::Outcome::Committed, Fingerprint(old_geometry.token)), "late old geometry ack accepted");
  frame = Frame(0, 0, resized); const auto resize_first = Proposed(policy.ProposeObject(frame, Object(frame))); Commit(policy, resize_first);
  policy.ResetSource(resized.source_input_id, resized.processor_id);
  Check(policy.Usage().sources == 0 && policy.Usage().tracks == 0, "source reset leaked state");
  Policy replacement_owner; replacement_owner.BindSource(Binding());
  const auto replacement_frame = Frame(0, 0);
  const auto replacement_candidate = Proposed(replacement_owner.ProposeObject(replacement_frame, Object(replacement_frame)));
  Check(replacement_candidate.token > old_geometry.token, "replacement owner reused an operation fence");
  Check(!replacement_owner.Resolve(old_geometry.token, Policy::Outcome::Committed, Fingerprint(old_geometry.token)), "old callback changed replacement owner candidate");
  Commit(replacement_owner, replacement_candidate);

  policy.BindSource(Binding()); frame = Frame(1000, 10);
  auto a = Proposed(policy.ProposeObject(frame, Object(frame, "a")));
  auto b = Proposed(policy.ProposeObject(frame, Object(frame, "b")));
  auto scene = Proposed(policy.ProposeScene(frame, {true, true, {}}));
  Check(a.token != b.token && b.token != scene.token, "same-frame entities shared one reservation");
  Commit(policy, a); Commit(policy, b); Commit(policy, scene);
  Check(policy.ProposeObject(Frame(900, 11), Object(Frame(900, 11), "a", 0.9)).status == Policy::Status::StaleFrame, "backward PTS accepted");
  Check(policy.ProposeObject(Frame(1100, 9), Object(Frame(1100, 9), "a", 0.9)).status == Policy::Status::StaleFrame, "backward frame index accepted");
  Check(policy.ProposeObject(Frame(1000, 11), Object(Frame(1000, 11), "a", 0.9)).status == Policy::Status::StaleFrame, "one PTS aliased to a different frame");
  Check(policy.Inspect(Binding(), "a")->Count() == 1 && policy.Inspect(Binding(), "b")->Count() == 1, "stale frame cleared healthy tracks");
  frame = Frame(2000, 20); auto recovery = Proposed(policy.ProposeObject(frame, Object(frame, "a", 0.9))); Commit(policy, recovery);
  Check(policy.Inspect(Binding(), "a")->Count() == 2, "healthy timeline could not continue after late frame");
}
void SceneAndCapacity() {
  Policy scene_policy; scene_policy.BindSource(Binding());
  auto frame = Frame(0, 0, Binding(), "detection_only");
  Check(scene_policy.ProposeObject(frame, Object(frame)).status == Policy::Status::NotEligible, "tracking-disabled object was indexed");
  auto candidate = Proposed(scene_policy.ProposeScene(frame, {true, false, {}}));
  Check(!candidate.slot && candidate.track_id.empty() && candidate.reason == Policy::Reason::SceneFirst, "scene invented a target identity");
  scene_policy.Resolve(candidate.token, Policy::Outcome::Failed);
  candidate = Proposed(scene_policy.ProposeScene(frame, {true, false, {}})); Commit(scene_policy, candidate);
  frame = Frame(2999, 29, Binding(), "detection_only");
  Check(scene_policy.ProposeScene(frame, {true, false, 1.0}).status == Policy::Status::NotDue, "scene change ignored minimum interval");
  frame = Frame(3000, 30, Binding(), "detection_only");
  candidate = Proposed(scene_policy.ProposeScene(frame, {true, false, 1.0}));
  Check(candidate.reason == Policy::Reason::SceneChange, "scene change reason missing");
  scene_policy.Resolve(candidate.token, Policy::Outcome::Unknown);
  frame = Frame(10000, 100, Binding(), "detection_only");
  Check(scene_policy.ProposeScene(frame, {true, true, {}}).status == Policy::Status::Pending, "unknown scene ack admitted another image");
  Check(scene_policy.Retry(candidate.token)->frame.source_pts_ns == 3000000000LL, "unknown scene replaced frozen frame");
  Commit(scene_policy, candidate);
  frame = Frame(62999, 629, Binding(), "detection_only");
  Check(scene_policy.ProposeScene(frame, {true, false, {}}).status == Policy::Status::NotDue, "static scene interval too short");
  frame = Frame(63000, 630, Binding(), "detection_only");
  candidate = Proposed(scene_policy.ProposeScene(frame, {true, false, {}})); Commit(scene_policy, candidate);
  frame = Frame(73000, 730, Binding(), "detection_only");
  candidate = Proposed(scene_policy.ProposeScene(frame, {true, true, {}}));
  Check(candidate.reason == Policy::Reason::SceneInterval, "active scene interval not independent"); Commit(scene_policy, candidate);
  Check(scene_policy.Usage().tracks == 0, "scene-only stream created object states");

  SearchSamplingConfig config; config.max_sources = 1; config.max_tracks = 1; config.max_pending = 1;
  Policy bounded(config); bounded.BindSource(Binding());
  auto other_binding = Binding(); other_binding.processor_id = "another-processor";
  Check(!bounded.BindSource(other_binding), "source state budget exceeded");
  frame = Frame(0, 0); auto first = Proposed(bounded.ProposeObject(frame, Object(frame, "one")));
  Check(bounded.ProposeObject(frame, Object(frame, "two")).status == Policy::Status::Capacity, "global pending budget exceeded");
  Check(bounded.ProposeScene(frame, {true, false, {}}).status == Policy::Status::Capacity, "scene bypassed shared pending budget");
  Check(bounded.Usage().tracks == 1 && bounded.Usage().pending == 1, "rejected admission leaked states");
  bounded.Resolve(first.token, Policy::Outcome::Failed);
  auto second = Proposed(bounded.ProposeObject(frame, Object(frame, "two"))); Commit(bounded, second);
  Check(bounded.ProposeObject(frame, Object(frame, "one")).status == Policy::Status::Capacity, "global track state budget exceeded");
  frame = Frame(1000, 10); auto pending = Proposed(bounded.ProposeObject(frame, Object(frame, "two", 0.9)));
  Check(bounded.RetireTrack(Binding(), "two"), "authoritative track retirement failed");
  Check(!bounded.Resolve(pending.token, Policy::Outcome::Committed, Fingerprint(pending.token)), "retired track accepted stale ack");
  Check(bounded.Usage().tracks == 0 && bounded.Usage().pending == 0, "track retirement leaked reservation");
}
void MetadataAndCadence() {
  FrameResult result; result.channel_id = "processor"; result.frame_width = 1920; result.frame_height = 1080;
  result.frame_pts_ns = 1000000000LL; result.frame_index = 10;
  Detection detection; detection.track_id = "session-track"; result.detections.push_back(detection);
  auto tracks = nlohmann::json::array({{{"track_id", "session-track"}, {"state", "confirmed"}, {"observation", "detected"}, {"last_observed_pts_ns", "1000000000"}}});
  result.model_extra["analytics"] = {{"stream_session_id", Binding().stream_session_id}, {"status", "active"}, {"tracks", tracks}};
  auto frame = Policy::FrameFromResult(result, "source", 1790000001000LL);
  auto object = Policy::ObjectFromResult(result, "session-track", true, 0.5);
  Check(frame && object && object->public_detection && frame->binding == Binding(), "shared analytics metadata adapter changed identity");
  Policy policy; policy.BindSource(Binding());
  const auto candidate = Proposed(policy.ProposeObject(*frame, *object)); policy.Resolve(candidate.token, Policy::Outcome::Failed);
  result.detections.clear(); object = Policy::ObjectFromResult(result, "session-track", true, 0.5);
  Check(object && policy.ProposeObject(*frame, *object).status == Policy::Status::NotEligible, "hidden low-confidence observation indexed as public evidence");
  result.detections.push_back(detection);
  result.model_extra["analytics"]["tracks"][0]["state"] = "tentative";
  object = Policy::ObjectFromResult(result, "session-track", true, 0.5);
  Check(policy.ProposeObject(*frame, *object).status == Policy::Status::NotEligible, "tentative track indexed");
  result.model_extra["analytics"]["tracks"][0]["state"] = "confirmed";
  result.model_extra["analytics"]["tracks"][0]["observation"] = "lost";
  result.model_extra["analytics"]["tracks"][0]["predicted_bbox"] = {{"x", 1}, {"y", 2}, {"w", 30}, {"h", 40}};
  object = Policy::ObjectFromResult(result, "session-track", true, 0.5);
  Check(policy.ProposeObject(*frame, *object).status == Policy::Status::NotEligible, "predicted frame indexed as real observation");
  result.model_extra["analytics"]["tracks"][0]["observation"] = "detected";
  result.model_extra["analytics"]["tracks"][0]["last_observed_pts_ns"] = "900000000";
  object = Policy::ObjectFromResult(result, "session-track", true, 0.5);
  Check(policy.ProposeObject(*frame, *object).status == Policy::Status::NotEligible, "stale observed geometry used for current frame");
  auto mismatched = Object(*frame); mismatched.stream_session_id = "other-session";
  Check(policy.ProposeObject(*frame, mismatched).status == Policy::Status::NotEligible, "object from another analytics session accepted");
  mismatched = Object(*frame); mismatched.processor_id = "other-processor";
  Check(policy.ProposeObject(*frame, mismatched).status == Policy::Status::NotEligible, "object from another processor accepted");
  mismatched = Object(*frame); ++mismatched.source_frame_index;
  Check(policy.ProposeObject(*frame, mismatched).status == Policy::Status::NotEligible, "same-PTS object from different frame accepted");
  mismatched = Object(*frame); mismatched.usable = false;
  Check(policy.ProposeObject(*frame, mismatched).status == Policy::Status::NotEligible, "unusable crop indexed");
  auto invalid = Object(*frame); invalid.quality = std::numeric_limits<double>::quiet_NaN();
  Check(policy.ProposeObject(*frame, invalid).status == Policy::Status::Invalid, "NaN quality accepted");
  invalid = Object(*frame); invalid.quality = -0.01;
  Check(policy.ProposeObject(*frame, invalid).status == Policy::Status::Invalid, "negative quality accepted");
  invalid = Object(*frame); invalid.quality = 1.01;
  Check(policy.ProposeObject(*frame, invalid).status == Policy::Status::Invalid, "unnormalized quality accepted");
  invalid = Object(*frame); invalid.change = std::numeric_limits<double>::infinity();
  Check(policy.ProposeObject(*frame, invalid).status == Policy::Status::Invalid, "infinite change accepted");
  Check(policy.ProposeScene(*frame, {true, true, std::numeric_limits<double>::quiet_NaN()}).status == Policy::Status::Invalid, "NaN scene change accepted");
  result.model_extra["analytics"]["tracks"][0]["last_observed_pts_ns"] = "18446744073709551615";
  Check(!Policy::ObjectFromResult(result, "session-track", true), "overflowing source PTS accepted");
  result.model_extra["analytics"].erase("stream_session_id");
  Check(!Policy::FrameFromResult(result, "source", 1790000001000LL), "missing session invented replacement identity");
  SearchSamplingConfig invalid_config; invalid_config.object_change_threshold = std::numeric_limits<double>::quiet_NaN();
  Reject([&] { Policy invalid_policy(invalid_config); });
  for (int fps : {3, 5, 10, 30}) {
    Policy timed; timed.BindSource(Binding());
    for (int n = 0; n <= fps * 3; ++n) {
      SearchSamplingFrame current{Binding(), n * 1000000000LL / fps, n, 1790000000000LL + n * 1000 / fps, "active"};
      const auto proposal = timed.ProposeObject(current, Object(current, "person", 0.1 + double(n) / (fps * 100)));
      if (proposal.candidate) Commit(timed, *proposal.candidate);
    }
    const auto state = timed.Inspect(Binding(), "person");
    Check(state && state->Count() == 2 && state->last_committed_pts_ns == 3000000000LL && state->slots[0]->source_pts_ns == 0,
      "frame rate changed time-based sampling semantics");
  }
}
int main() {
  try {
    ObjectTransactions(); BindingAndTimelineFences(); SceneAndCapacity(); MetadataAndCadence();
    std::cout << "search sampling policy: " << checks << " checks passed; ACK-only slots, bounded replacements, independent scenes, lifecycle fences and 3/5/10/30 FPS\n";
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
