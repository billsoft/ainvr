// Copyright AINVR. Separate processes verify the remote-commit/local-delete gap.
#include "output/archive_delivery.hpp"
#include "output/archive_document.hpp"
#include <bson/bson.h>
#include <fstream>
#include <iostream>
#include <cstdlib>
namespace {
constexpr const char* id="507f1f77bcf86cd799439011";
nlohmann::json Canonical(const std::vector<uint8_t>& bytes){
  bson_t doc;if(!bson_init_static(&doc,bytes.data(),bytes.size()))throw std::runtime_error("Invalid returned BSON");
  std::unique_ptr<char,decltype(&bson_free)> text(bson_as_canonical_extended_json(&doc,nullptr),bson_free);
  if(!text)throw std::runtime_error("BSON conversion failed");return nlohmann::json::parse(text.get());
}
std::vector<uint8_t> Record(const char* path,int w,int h){
  std::ifstream file(path,std::ios::binary);std::vector<uint8_t> jpeg((std::istreambuf_iterator<char>(file)),{});
  ainvr::ArchiveDocumentInput input;input.image_id=id;input.channel_name="AINVR replay test";input.archive_epoch=7;
  input.frame.channel_id="replay-test";input.frame.timestamp=1790168716.123456;input.frame.frame_pts_ns=9007199254740993LL;
  input.frame.model_name="yolo26m";input.frame.task_type="object_detection";
  ai_service::Detection d;d.bbox={1,2,30,40};d.confidence=.8;d.class_name="test";input.frame.detections.push_back(d);
  input.image={w,h,jpeg};input.original_image=input.image;return ainvr::BuildArchiveDocument(input);
}
}
int main(int argc,char**argv){try{
  auto* uri=std::getenv("AINVR_TEST_MONGO_URI");
  if(argc!=7||!uri)throw std::runtime_error("Expected mode, collection, spool directory, JPEG, width, height and private URI");
  std::string mode=argv[1],collection=argv[2];if(collection.rfind("test_replay_",0)!=0)throw std::runtime_error("Test namespace required");
  auto expected=Record(argv[4],std::stoi(argv[5]),std::stoi(argv[6]));
  ainvr::ArchiveSpool spool(argv[3],1024*1024,8);ainvr::ArchiveMongo mongo(uri,"ainvr_snapshots",collection);
  if(mode=="stage_offline"){
    if(mongo.Count()!=0||!spool.Pending().empty())throw std::runtime_error("Test state must be empty");
    spool.Stage(id,expected);bool failed=false;
    try{ainvr::ArchiveMongo offline("mongodb://127.0.0.1:1","ainvr_snapshots",collection);ainvr::ReplayPreparedArchive(spool,offline,1);}catch(const std::runtime_error&){failed=true;}
    if(!failed||spool.Pending().size()!=1||mongo.Count()!=0)throw std::runtime_error("Unavailable delivery did not retain record");
  }else if(mode=="commit_exit"){
    if(spool.Pending().size()!=1)throw std::runtime_error("Pending record not recovered");
    spool.Deliver(id,[&](const auto& bytes){mongo.Put(bytes);std::_Exit(23);});
    throw std::runtime_error("Fault injection did not exit");
  }else if(mode=="replay"){
    if(mongo.Count()!=1||spool.Pending().size()!=1)throw std::runtime_error("Expected commit/delete gap");
    if(ainvr::ReplayPreparedArchive(spool,mongo,0)!=0||spool.Pending().size()!=1)throw std::runtime_error("Replay limit ignored");
    if(ainvr::ReplayPreparedArchive(spool,mongo,1)!=1||!spool.Pending().empty()||mongo.Count()!=1)throw std::runtime_error("Replay duplicated or lost record");
  }else if(mode!="verify_empty")throw std::invalid_argument("Unknown test mode");
  if(mode=="replay"||mode=="verify_empty"){
    auto got=mongo.Get(id);if(!got||Canonical(*got)!=Canonical(expected)||!spool.Pending().empty()||mongo.Count()!=1)throw std::runtime_error("Final persisted payload mismatch");
  }
  std::cout<<nlohmann::json({{"mode",mode},{"pending",spool.Pending().size()},{"documents",mongo.Count()},{"passed",true}}).dump()<<"\n";
}catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}}
