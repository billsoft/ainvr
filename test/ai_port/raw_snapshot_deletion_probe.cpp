// Copyright AINVR. Persisted deletion versus raw/prepared recovery and Mongo.
#include "output/raw_snapshot_task.hpp"
#include "output/archive_delivery.hpp"
#include <iostream>
#include <cstdlib>
void Require(bool b){if(!b)throw std::runtime_error("Raw snapshot deletion assertion failed");}
int main(int argc,char**argv){try{
 const auto* uri=getenv("AINVR_TEST_MONGO_URI");Require(argc==3&&uri);
 std::filesystem::path out=argv[1];std::string collection=argv[2];Require(collection.rfind("test_raw_delete_",0)==0);
 ainvr::ArchiveMongo mongo(uri,"ainvr_snapshots",collection);Require(mongo.Count()==0);
 ainvr::RawFrameSpool raw((out/"raw").string(),16*1024*1024);
 ainvr::ArchiveSpool prepared((out/"prepared").string(),16*1024*1024,100);
 ainvr::SnapshotRenderer renderer;
 ai_service::FrameResult result;result.channel_id="raw-delete-test";result.timestamp=100;result.frame_width=640;result.frame_height=480;
 ai_service::Detection d;d.class_name="person";d.confidence=.8;d.bbox={100,100,200,200};result.detections={d,d};
 ainvr::Nv12Frame frame;frame.width=640;frame.height=480;frame.pixels.resize(640*480*3/2,128);
 ai_service::config::SnapshotConfig config;config.enabled=true;
 auto task=ainvr::MakeRawSnapshotTask(frame,result,config,"AINVR delete test",0,true,false);
 auto ids=task.metadata.at("image_ids").get<std::vector<std::string>>();raw.Stage(ainvr::NewArchiveId(),task);
 bool interrupted=false;try{ainvr::PrepareRawSnapshots(raw,prepared,renderer,[](const auto&){throw std::runtime_error("Simulated interruption after first JPEG");});}catch(const std::runtime_error&){interrupted=true;}
 Require(interrupted&&raw.Pending().size()==1&&prepared.Pending().size()==1);
 {ai_service::output::HistoryDeletions journal;journal.Load(out.string());journal.Add({{"image_id",ids[0]}});}
 ai_service::output::HistoryDeletions journal;journal.Load(out.string());Require(journal.Epoch()==1);
 Require(ainvr::PrepareRawSnapshots(raw,prepared,renderer,{},&journal)==1);
 auto replay=ainvr::ReplayPreparedArchiveWithDeletions(prepared,mongo,journal,100);
 Require(replay.deleted==1&&replay.committed==1&&mongo.Count()==1&&!mongo.Get(ids[0])&&mongo.Get(ids[1]));
 Require(raw.Pending().empty()&&prepared.Pending().empty());
 // A clear must cancel old raw work, while frames accepted afterwards survive.
 auto oldtask=ainvr::MakeRawSnapshotTask(frame,result,config,"AINVR delete test",journal.Epoch(),true,false);
 raw.Stage(ainvr::NewArchiveId(),oldtask);journal.Add(nlohmann::json::object());
 auto newtask=ainvr::MakeRawSnapshotTask(frame,result,config,"AINVR delete test",journal.Epoch(),true,false);
 auto newids=newtask.metadata.at("image_ids").get<std::vector<std::string>>();raw.Stage(ainvr::NewArchiveId(),newtask);
 Require(ainvr::PrepareRawSnapshots(raw,prepared,renderer,{},&journal)==2);
 replay=ainvr::ReplayPreparedArchiveWithDeletions(prepared,mongo,journal,100);
 Require(replay.committed==2&&mongo.Count()==2&&!mongo.Get(ids[1]));
 for(const auto&id:newids)Require(mongo.Get(id).has_value());
 // A later persisted inclusive time range cancels only older-generation work.
 auto timed=ainvr::MakeRawSnapshotTask(frame,result,config,"AINVR delete test",journal.Epoch(),true,false);
 raw.Stage(ainvr::NewArchiveId(),timed);journal.Add({{"timestamp",{{"$gte",100},{"$lte",100}}}});
 Require(ainvr::PrepareRawSnapshots(raw,prepared,renderer,{},&journal)==0);
 ainvr::ReplayPreparedArchiveWithDeletions(prepared,mongo,journal,100);
 Require(mongo.Count()==0&&raw.Pending().empty()&&prepared.Pending().empty());
 std::cout<<"PASS durable ID deletion, partial-JPEG recovery, clear generation boundary, inclusive time range, Mongo no resurrection\n";
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
