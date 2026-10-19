// Copyright AINVR. Real asynchronous evidence -> JPU/GLES -> BPU review.
#include "analytics/locate_review.hpp"
#include <mongoc/mongoc.h>
#include <fstream>
#include <iostream>
int main(int argc,char**argv){try {
 if(argc!=3||std::filesystem::exists(argv[2]))throw std::runtime_error("fixture directory and new report required");
 std::string uri;std::getline(std::cin,uri);if(uri.empty())throw std::runtime_error("Missing database connection");
 auto store=std::make_shared<ai_service::analytics::EventStore>(uri,"ainvr_snapshots","test_analytics_events");
 const auto channel="test-neural-review-"+std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
 auto* client=mongoc_client_new(uri.c_str());if(!client)throw std::runtime_error("Database client failed");
 auto* collection=mongoc_client_get_collection(client,"ainvr_snapshots",("snapshots_"+channel).c_str());
 struct Cleanup {mongoc_client_t* client;mongoc_collection_t* collection;~Cleanup(){bson_error_t e{};mongoc_collection_drop(collection,&e);mongoc_collection_destroy(collection);mongoc_client_destroy(client);}} cleanup{client,collection};
 ai_service::config::ModelConfig cfg;cfg.name="locateanything-3b";cfg.adapter="locateanything_bpu";
 cfg.path="/home/sunrise/ainvr/ai-service/models/derived/s100p/locateanything-3b.hbm";
 cfg.description="a person";cfg.input_size={224,448};cfg.max_new_tokens=64;
 ai_service::analytics::LocateReview handler(store,cfg);
 auto report=nlohmann::json::array();
 for(const std::string name:{"review-empty","review-person"}) {
  auto id=channel+"-"+name;
  std::ifstream file(std::filesystem::path(argv[1])/(name+".jpg"),std::ios::binary);
  std::vector<uint8_t> jpeg((std::istreambuf_iterator<char>(file)),{});
  auto [width,height]=ai_service::analytics::JpegDimensions(jpeg);
  auto event=nlohmann::json{{"event_id",id},{"channel_id",channel},{"track_id",name},{"stream_session_id","test"},
    {"frame_pts_ns","42"},{"rule_id","test-rule"},{"type","region_enter"},
    {"timestamp",std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count()},
    {"review_status","not_requested"},{"notification_status","not_requested"}};
  const auto text=nlohmann::json({{"image_id",id},{"channel_id",channel},{"track_id",name},{"frame_pts_ns",42},
    {"model_extra",{{"analytics_event_ids",{id}},{"tracking_session_id","test"}}}}).dump();
  auto* doc=bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()),text.size(),nullptr);
  if(!doc)throw std::runtime_error("Evidence document invalid");
  bson_t original;BSON_APPEND_DOCUMENT_BEGIN(doc,"original_image",&original);
  BSON_APPEND_UTF8(&original,"format","jpg");BSON_APPEND_INT32(&original,"width",width);BSON_APPEND_INT32(&original,"height",height);
  bson_append_binary(&original,"data",-1,BSON_SUBTYPE_BINARY,jpeg.data(),jpeg.size());bson_append_document_end(doc,&original);
  bson_error_t error{};bool ok=mongoc_collection_insert_one(collection,doc,nullptr,nullptr,&error);bson_destroy(doc);
  if(!ok)throw std::runtime_error("Test evidence insertion failed");
  store->Put(event);if(!store->QueueJob(id,"review"))throw std::runtime_error("Review enqueue failed");
  {
   ai_service::analytics::EventWorker worker(store,channel,"review",[&](const auto& e,const auto& c){try{return handler(e,c);}catch(const std::exception& error){std::cerr<<"Review diagnostic: "<<error.what()<<'\n';throw;}},35);
   const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(38);
   while(!worker.Completed()&&std::chrono::steady_clock::now()<deadline)std::this_thread::sleep_for(std::chrono::milliseconds(100));
   if(worker.Completed()!=1)throw std::runtime_error("Review worker did not complete");
  }
  const auto records=store->List(channel);nlohmann::json saved;
  for(const auto& record:records)if(record.at("event_id")==id)saved=record;
  if(saved.is_null())throw std::runtime_error("No durable review result");
  report.push_back({{"fixture",name},{"expected",name=="review-empty"?"rejected":"approved"},
    {"actual",saved.at("review_status")},{"job",saved.at("review_job")}});
 }
 bool passed=true;for(const auto& c:report)passed=passed&&(c.at("expected")==c.at("actual"));
 std::ofstream out(argv[2]);out<<nlohmann::json({{"passed",passed},{"cases",report},{"scope","two real JPEG presence cases; synthetic isolated event records, no notifications"}}).dump(2)<<'\n';
 if(!out)throw std::runtime_error("Cannot save report");
 std::cout<<"Real review cases completed; passed="<<passed<<'\n';return passed?0:2;
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
