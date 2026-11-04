// AINVR. Frame-layer cadence policy. Pure; no detector, image or storage dependency.
#pragma once
#include <cstddef>
namespace ai_service::output {
// Whole-frame search sampling must not depend on what the channel's detector reports: the model, its class set
// (80 classes, faces, ...) and its box style differ per channel, and a customer may search for something that has
// no box at all. The scene interval is therefore the same for every frame. `detection_count` is accepted only so
// that callers cannot quietly reintroduce the coupling without a test noticing.
// true  -> scene_active_interval applies (the cadence setting); the static interval is not used by the producer.
inline bool SearchSceneActive(std::size_t detection_count) noexcept {
  (void)detection_count;
  return true;
}
}  // namespace ai_service::output
