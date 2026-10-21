#include "../../ai-service/src/output/observation_evidence.hpp"
#include <cassert>
#include <iostream>
#include <cstdlib>
using namespace ai_service::output;
int main(int argc,char**argv){try{
 assert(argc==2);const std::string name=argv[1];assert(name.rfind("ainvr_evidence_test_",0)==0);
 mongoc_init();auto* client=mongoc_client_new("mongodb://127.0.0.1:27028/?serverSelectionTimeoutMS=3000");assert(client);
 auto* collection=mongoc_client_get_collection(client,"ainvr_alarm_test_evidence",name.c_str());
 ai_service::FrameResult frame;frame.channel_id="channel";frame.frame_pts_ns=9007199254740993LL;frame.frame_index=9007199254740995LL;frame.frame_width=3840;frame.frame_height=2160;
 ai_service::Detection target;target.track_id="opaque-track-id";target.label_id="person";frame.detections.push_back(target);
 frame.model_extra["analytics"]={{"status","active"},{"stream_session_id","session"}};
 const auto targets=BindObservationEvidence(frame);assert(!frame.detections[0].model_extra.contains("observation_source"));
 assert(targets[0].model_extra.at("observation_source").at("source_frame_index")=="9007199254740995");
 ObservationEvidenceQuery q{"session","9007199254740993","9007199254740995","opaque-track-id"};
 assert(FindObservationEvidence(collection,"channel",q).at("state")=="unavailable");
 auto document=nlohmann::json{{"channel_id","channel"},{"image_id","image-exact"},{"track_id","opaque-track-id"},{"label_id","person"},{"frame_pts_ns",frame.frame_pts_ns},
  {"model_extra",targets[0].model_extra},{"image",{{"width",320},{"height",240},{"data",{{"$binary",{{"base64","/9j/2Q=="},{"subType","00"}}}}}}},{"original_image",{{"width",640},{"height",480}}}};
 auto insert=[&](const nlohmann::json& value){const auto text=value.dump();auto* bson=bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()),text.size(),nullptr);assert(bson);bson_error_t error{};assert(mongoc_collection_insert_one(collection,bson,nullptr,nullptr,&error));bson_destroy(bson);};
 insert(document);const auto found=FindObservationEvidence(collection,"channel",q);
 assert(found.at("state")=="available");assert(found.at("evidence").at("source_pts_ns")==q.pts_ns);assert(found.at("evidence").at("variants").size()==2);
 auto wrong=q;wrong.session_id="different";assert(FindObservationEvidence(collection,"channel",wrong).at("state")=="unavailable");
 wrong=q;wrong.frame_index="9007199254740994";assert(FindObservationEvidence(collection,"channel",wrong).at("state")=="unavailable");
 wrong=q;wrong.pts_ns="9007199254740992";assert(FindObservationEvidence(collection,"channel",wrong).at("state")=="unavailable");
 wrong=q;wrong.track_id="other";assert(FindObservationEvidence(collection,"channel",wrong).at("state")=="unavailable");
 assert(FindObservationEvidence(collection,"other-channel",q).at("state")=="unavailable");
 auto legacy=document;legacy["image_id"]="legacy";legacy["model_extra"]=nlohmann::json::object();insert(legacy);
 assert(FindObservationEvidence(collection,"channel",q).at("state")=="available");
 document["image_id"]="duplicate";insert(document);assert(FindObservationEvidence(collection,"channel",q).at("reason")=="ambiguous_frame");
 bool invalid=false;try{EvidenceInteger("9007199254740993.0");}catch(...){invalid=true;}assert(invalid);
 invalid=false;try{EvidenceIdentity(std::string(1,char(0xff)));}catch(...){invalid=true;}assert(invalid);
 bson_error_t error{};assert(mongoc_collection_drop(collection,&error));mongoc_collection_destroy(collection);mongoc_client_destroy(client);mongoc_cleanup();
 std::cout<<"PASS exact Mongo evidence binding, lossless source integers, wrong frame/session/target rejection, ambiguous archive rejection\n";
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
