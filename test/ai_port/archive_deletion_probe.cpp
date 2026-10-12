// Copyright AINVR.
#include "output/archive_delivery.hpp"
#include <iostream>
#include <cstdlib>
#include <filesystem>
std::string Id(int n){return "507f1f77bcf86cd79943901"+std::to_string(n);}
std::vector<uint8_t> Record(int n,int64_t epoch,double timestamp){
  bson_t doc;bson_init(&doc);bson_oid_t oid;bson_oid_init_from_string(&oid,Id(n).c_str());
  BSON_APPEND_OID(&doc,"_id",&oid);BSON_APPEND_UTF8(&doc,"image_id",Id(n).c_str());if(epoch>=0)BSON_APPEND_INT64(&doc,"archive_epoch",epoch);BSON_APPEND_DOUBLE(&doc,"timestamp",timestamp);
  auto* p=bson_get_data(&doc);std::vector<uint8_t> result(p,p+doc.len);bson_destroy(&doc);return result;
}
int main(int argc,char**argv){try{
  auto* uri=getenv("AINVR_TEST_MONGO_URI");if(argc!=4||!uri)throw std::runtime_error("Expected mode, namespace, state directory");
  std::string mode=argv[1],name=argv[2];if(name.rfind("test_delete_",0)!=0)throw std::runtime_error("Test namespace required");
  std::filesystem::path root=argv[3];std::filesystem::create_directories(root/"journal");
  ainvr::ArchiveSpool spool((root/"spool").string(),1024*1024,10);ainvr::ArchiveMongo mongo(uri,"ainvr_snapshots",name);
  ai_service::output::HistoryDeletions journal;journal.Load((root/"journal").string());
  if(mode=="setup"){
    if(mongo.Count()||!spool.Pending().empty()||journal.Epoch())throw std::runtime_error("Test state not empty");
    for(int i=1;i<=3;++i){auto bytes=Record(i,i==2?-1:0,50+i*50);spool.Stage(Id(i),bytes);mongo.Put(bytes);}
    journal.Add({{"image_id",Id(1)}});journal.Add({{"timestamp",{{"$gte",140.0},{"$lte",160.0}}}});
    auto bytes=Record(4,journal.Epoch(),100);spool.Stage(Id(4),bytes);mongo.Put(bytes);
    auto invalid=journal.Rules();invalid.push_back({{"epoch",3},{"filter",{{"unsupported",true}}}});
    bool rejected=false;try{mongo.ApplyDeletionRules(invalid.dump());}catch(const std::invalid_argument&){rejected=true;}
    if(!rejected||mongo.Count()!=4)throw std::runtime_error("Invalid rules partially deleted data");
  }else if(mode=="replay"){
    auto r=ainvr::ReplayPreparedArchiveWithDeletions(spool,mongo,journal,10);
    if(r.deleted!=2||r.committed!=2||mongo.Count()!=2||mongo.Get(Id(1))||mongo.Get(Id(2))||!mongo.Get(Id(3))||!mongo.Get(Id(4)))throw std::runtime_error("ID/range replay resurrected or lost data");
  }else if(mode=="clear_intent"){
    journal.Add(nlohmann::json::object());
    // Old retry can arrive after intent was saved; retain until replay filters it.
    spool.Stage(Id(3),Record(3,0,200));spool.Stage(Id(4),Record(4,2,100));
    spool.Stage(Id(5),Record(5,journal.Epoch(),50));
  }else if(mode=="verify_clear"){
    auto r=ainvr::ReplayPreparedArchiveWithDeletions(spool,mongo,journal,10);
    if(r.deleted!=2||r.committed!=1||mongo.Count()!=1||!mongo.Get(Id(5))||mongo.Get(Id(3))||mongo.Get(Id(4)))throw std::runtime_error("Clear replay lost new generation or restored old one");
    auto again=ainvr::ReplayPreparedArchiveWithDeletions(spool,mongo,journal,10);
    if(again.deleted||again.committed||mongo.Count()!=1)throw std::runtime_error("Replay not idempotent");
  }else throw std::invalid_argument("Unknown mode");
  std::cout<<nlohmann::json({{"passed",true},{"mode",mode},{"epoch",journal.Epoch()},{"mongo_count",mongo.Count()},{"pending",spool.Pending().size()}}).dump()<<"\n";
}catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}}
