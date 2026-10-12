// Copyright AINVR. Serialized channel archive owner with real renderer and Mongo.
#include "output/channel_archive.hpp"
#include <cstdlib>
#include <iostream>
#include <thread>
void Require(bool b){if(!b)throw std::runtime_error("Channel archive owner assertion failed");}
int main(int argc,char**argv){try{
 const auto* uri=getenv("AINVR_TEST_MONGO_URI");Require(argc==3&&uri);std::string channel=argv[2];Require(channel.rfind("test_owner_",0)==0);
 ai_service::config::SnapshotConfig config;config.enabled=true;config.max_count=3;
 auto owner=std::make_shared<ainvr::ChannelArchive>(argv[1],uri,"ainvr_snapshots",channel);
 Require(owner->Mongo().Count()==0);auto sink=owner->MakeSink(config,"AINVR owner test");
 ai_service::output::ArchiveAdmission admission;
 ainvr::Nv12Frame frame;frame.width=640;frame.height=480;frame.pixels.resize(640*480*3/2,128);
 ai_service::FrameResult result;result.channel_id=channel;result.frame_width=640;result.frame_height=480;result.timestamp=100;
 ai_service::Detection detection;detection.class_name="person";detection.confidence=.8;detection.bbox={100,100,200,200};result.detections={detection,detection};
 ainvr::FrameContext context;context.channel_id=channel;
 auto stage=[&]{auto ticket=admission.Acquire(frame.pixels.size(),[]{return true;});Require(bool(ticket));sink->Stage(frame,context,result,std::move(*ticket));};
 stage();Require(owner->Mongo().Count()==2);
 auto id=owner->Mongo().ListPage({},1)["items"][0]["image_id"].get<std::string>();
 Require(owner->Delete({{"image_id",id}})==1&&!owner->Mongo().Get(id));
 stage();Require(owner->Mongo().Count()==3&&!owner->Mongo().Get(id));
 std::exception_ptr deletion_error;
 std::thread remover([&]{try{owner->Delete(nlohmann::json::object());}catch(...){deletion_error=std::current_exception();}});
 stage();remover.join();if(deletion_error)std::rethrow_exception(deletion_error);
 owner->Delete(nlohmann::json::object());stage();Require(owner->Mongo().Count()==2);
 auto before=owner->Mongo().ListPage({},100);
 auto stats=owner->Stats();Require(stats["frames"]==4&&stats["raw_pending"]==0&&stats["prepared_pending"]==0&&stats["delivery_failures"]==0);
 sink.reset();owner.reset();
 owner=std::make_shared<ainvr::ChannelArchive>(argv[1],uri,"ainvr_snapshots",channel);sink=owner->MakeSink(config,"AINVR owner test");
 Require(owner->Mongo().ListPage({},100)==before);
 Require(owner->Stats()["archive_epoch"].get<uint64_t>()>=3);
 auto unsupported=config;unsupported.brightness_enabled=true;bool rejected=false;
 try{owner->MakeSink(unsupported,"invalid");}catch(const std::invalid_argument&){rejected=true;}Require(rejected);
 std::cout<<"PASS channel owner write/delete serialization, bounded retention, durable generation reload, no replay resurrection\n";
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
