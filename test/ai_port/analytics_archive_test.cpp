#include "../../ai-service/src/output/archive_result_codec.hpp"
#include "../../ai-service/src/output/archive_list_item.hpp"
#include <cassert>
#include <iostream>
int main() {
  ai_service::FrameResult result;
  ai_service::Detection detection;
  detection.track_id="channel:session:17";result.detections.push_back(detection);
  auto encoded=ainvr::EncodeArchiveResult(result);
  assert(ainvr::DecodeArchiveResult(encoded).detections[0].track_id==detection.track_id);
  encoded["detections"][0].erase("track_id");
  assert(ainvr::DecodeArchiveResult(encoded).detections[0].track_id.empty());
  std::cout<<"analytics archive replay and legacy compatibility: PASS\n";
}
