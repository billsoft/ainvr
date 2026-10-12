// Copyright AINVR.
#include "output/archive_result_codec.hpp"
#include <iostream>
#include <limits>
void Require(bool value){if(!value)throw std::runtime_error("Archive codec assertion failed");}
int main(){try{
 ai_service::FrameResult r;
 r.channel_id="channel";r.stream_url="http://127.0.0.1/live/xm.flv";
 r.stream_protocol="http-flv";r.timestamp=1791720794.1234567;
 r.frame_pts_ns=9007199254740993LL;r.frame_index=9007199254740995LL;
 r.frame_width=7680;r.frame_height=3840;r.model_name="model";
 r.model_format="onnx";r.model_provider="cpu";r.model_input_size={640,640};
 r.model_end2end=true;r.model_version="custom";r.task_type="face_detection";
 r.time_decode_ms=0.123456789;r.time_preprocess_ms=1.987654321;
 r.time_inference_ms=8.12345678;r.time_postprocess_ms=2.3456789;
 r.model_extra={{"integer",9007199254740993LL},{"nested",{{"value",0.123456789}}}};
 ai_service::Detection d;d.class_id=7;d.class_name="person";
 d.confidence=0.987654321234567;d.bbox={0.123456789,3.987654321,67.123456789,81.987654321};
 d.label_id="label";d.query_description="query";d.confidence_known=false;
 d.model_extra={{"score",0.123456789012345}};
 r.detections.push_back(d);
 d.landmarks=std::vector<std::array<double,2>>{};r.detections.push_back(d);
 d.landmarks=std::vector<std::array<double,2>>{{1.123456789,2.987654321}};r.detections.push_back(d);
 auto encoded=ainvr::EncodeArchiveResult(r);
 auto recovered=ainvr::DecodeArchiveResult(nlohmann::json::parse(encoded.dump()));
 Require(ainvr::EncodeArchiveResult(recovered)==encoded);
 Require(recovered.frame_pts_ns==r.frame_pts_ns&&recovered.frame_index==r.frame_index);
 Require(recovered.detections[0].confidence==d.confidence);
 Require(!recovered.detections[0].landmarks&&recovered.detections[1].landmarks->empty());
 Require(recovered.detections[2].landmarks==d.landmarks);
 bool rejected=false;auto invalid=encoded;invalid["journal_result_version"]=2;
 try{ainvr::DecodeArchiveResult(invalid);}catch(...){rejected=true;}Require(rejected);
 rejected=false;invalid=encoded;invalid.erase("frame_pts_ns");
 try{ainvr::DecodeArchiveResult(invalid);}catch(...){rejected=true;}Require(rejected);
 rejected=false;r.detections[0].confidence=std::numeric_limits<double>::infinity();
 try{ainvr::EncodeArchiveResult(r);}catch(...){rejected=true;}Require(rejected);
 std::cout<<"PASS lossless result journal, 64-bit integers, subpixel geometry, optional landmarks, invalid input rejection\n";
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
