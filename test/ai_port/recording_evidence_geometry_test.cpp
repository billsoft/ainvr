#include "../../ai-service/src/stream/evidence_geometry.hpp"
#include <iostream>
#include <stdexcept>
int main(){
  int checks=0;const auto check=[&](bool ok){++checks;if(!ok)throw std::runtime_error("geometry proof");};
  using ai_service::sei::RecordingEvidenceGeometry;
  const auto proof=RecordingEvidenceGeometry(7680,4320,1920,1080,42);
  check(proof.at("observation_size")==nlohmann::json::array({7680,4320}));
  check(proof.at("encoded_size")==nlohmann::json::array({1920,1080}));
  check(proof.at("source_frame_index")=="42");
  check(proof.at("method")=="full_frame_axis_scale");
  check(!RecordingEvidenceGeometry(1920,1080,1920,1080,0).is_null());
  check(RecordingEvidenceGeometry(7680,4320,1920,1000,42).is_null());
  check(RecordingEvidenceGeometry(1920,1080,7680,4320,42).is_null());
  check(RecordingEvidenceGeometry(7680,4320,1920,1080,-1).is_null());
  check(RecordingEvidenceGeometry(10000,5000,1920,960,1).is_null());
  std::cout<<checks<<" recording geometry checks passed; no hardware executed\n";
}
