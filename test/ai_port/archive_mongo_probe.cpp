// Copyright AINVR. Real Mongo round-trip on an isolated test collection.
#include "output/archive_mongo.hpp"
#include "output/archive_document.hpp"
#include <bson/bson.h>
#include <fstream>
#include <iostream>
#include <cstdlib>
#include <chrono>
nlohmann::json Canonical(const std::vector<uint8_t>& bytes){
  bson_t doc;if(!bson_init_static(&doc,bytes.data(),bytes.size()))throw std::runtime_error("Invalid returned BSON");
  char* text=bson_as_canonical_extended_json(&doc,nullptr);if(!text)throw std::runtime_error("BSON conversion failed");
  std::unique_ptr<char,decltype(&bson_free)> owned(text,bson_free);return nlohmann::json::parse(text);
}
int main(int argc,char**argv){try{
  const char* uri=std::getenv("AINVR_TEST_MONGO_URI");
  if(argc!=5||!uri)throw std::runtime_error("Expected test collection, JPEG, width and height plus private URI environment");
  std::string collection=argv[1];if(collection.rfind("test_archive_",0)!=0)throw std::runtime_error("Test collection prefix required");
  std::ifstream file(argv[2],std::ios::binary);std::vector<uint8_t> jpeg((std::istreambuf_iterator<char>(file)),{});if(jpeg.empty())throw std::runtime_error("Missing JPEG");
  ainvr::ArchiveDocumentInput record;record.image_id="507f1f77bcf86cd799439011";record.channel_name="AINVR test";record.archive_epoch=12;
  record.frame.channel_id="mongo-probe";record.frame.frame_pts_ns=9007199254740993LL;record.frame.timestamp=1790168716.123456;
  record.frame.model_name="test";record.frame.task_type="object_detection";
  ai_service::Detection d;d.bbox={1,2,30,40};d.confidence=.8;d.class_name="test";record.frame.detections.push_back(d);
  record.image={std::stoi(argv[3]),std::stoi(argv[4]),jpeg};record.original_image=record.image;
  auto expected=ainvr::BuildArchiveDocument(record);
  ainvr::ArchiveMongo mongo(uri,"ainvr_snapshots",collection);
  if(mongo.Count()!=0)throw std::runtime_error("Test collection already contains data");
  mongo.Put(expected);mongo.Put(expected);
  if(mongo.Count()!=1)throw std::runtime_error("Retry produced duplicate records");
  auto read=mongo.Get(record.image_id);if(!read||Canonical(*read)!=Canonical(expected))throw std::runtime_error("Archive round-trip mismatch");
  if(mongo.Get("507f1f77bcf86cd799439099"))throw std::runtime_error("Missing ID unexpectedly found");
  bool invalid=false;try{mongo.Put({1,2,3});}catch(const std::invalid_argument&){invalid=true;}
  if(!invalid)throw std::runtime_error("Malformed BSON accepted");
  auto start=std::chrono::steady_clock::now();bool failed=false;
  try{ainvr::ArchiveMongo offline("mongodb://127.0.0.1:1","ainvr_snapshots",collection);offline.Put(expected);}catch(const std::runtime_error&){failed=true;}
  if(!failed)throw std::runtime_error("Unavailable server write was accepted");
  double elapsed=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
  if(elapsed>20)throw std::runtime_error("Failure was not bounded");
  // Simulate caller retry after a failed delivery; retain the exact ID/payload.
  mongo.Put(expected);if(mongo.Count()!=1)throw std::runtime_error("Retry after failure duplicated record");
  std::cout<<nlohmann::json({{"passed",true},{"collection",collection},{"documents",mongo.Count()},{"unavailable_seconds",elapsed},{"jpeg_bytes",jpeg.size()}}).dump()<<"\n";
}catch(const std::exception&e){std::cerr<<e.what()<<"\n";return 1;}}
