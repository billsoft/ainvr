#include "output/search_scene_cadence.hpp"
#include "output/search_sampling_policy.hpp"
#include <cassert>
#include <iostream>
using namespace ai_service::output;

// Same source, same time: the scene decision must be identical with no detections and with a crowd of them.
static SearchSamplingPolicy::Proposal Propose(std::size_t detections, int64_t pts_ns, SearchSamplingPolicy& policy,
                                              const SearchSamplingBinding& binding) {
  SearchSamplingFrame frame;
  frame.binding = binding; frame.source_pts_ns = pts_ns; frame.source_frame_index = pts_ns / 33000000; frame.captured_ms = pts_ns / 1000000;
  frame.analytics_status = "active";
  SearchSamplingScene scene; scene.usable = true; scene.active = SearchSceneActive(detections);
  return policy.ProposeScene(frame, scene);
}

int main() {
  assert(SearchSceneActive(0) == SearchSceneActive(1) && SearchSceneActive(1) == SearchSceneActive(100000));
  const SearchSamplingBinding binding{"input-1", "proc-1", "session-1", 896, 448};
  auto run = [&](std::size_t detections) {
    SearchSamplingConfig config; config.scene_active_interval_ns = 10000000000LL; config.scene_static_interval_ns = 60000000000LL;
    SearchSamplingPolicy policy(config); assert(policy.BindSource(binding));
    auto first = Propose(detections, 1000000000LL, policy, binding);
    assert(first.status == SearchSamplingPolicy::Status::Proposed && first.candidate);
    assert(policy.Resolve(first.candidate->token, SearchSamplingPolicy::Outcome::Committed, std::string(64, 'a')));
    // 9 s later: not due (10 s cadence); 11 s later: due. Identical for 0 and for many detections.
    const auto early = Propose(detections, 10000000000LL, policy, binding).status;
    const auto due = Propose(detections, 12000000000LL, policy, binding).status;
    return std::make_pair(early, due);
  };
  const auto quiet = run(0), crowded = run(500);
  assert(quiet == crowded);
  assert(quiet.first == SearchSamplingPolicy::Status::NotDue && quiet.second == SearchSamplingPolicy::Status::Proposed);
  std::cout << "scene cadence is detector independent\n";
  return 0;
}
