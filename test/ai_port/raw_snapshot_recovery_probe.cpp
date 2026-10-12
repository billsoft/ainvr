// Copyright AINVR. Real renderer recovery across two abrupt process exits.
#include "output/raw_snapshot_task.hpp"
#include <sys/wait.h>
#include <unistd.h>
#include <fstream>
#include <iostream>
void Require(bool value){if(!value)throw std::runtime_error("Raw snapshot recovery assertion failed");}
void Wait(pid_t child,int expected){int status=0;Require(child>0&&waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==expected);}
int main(int argc,char**argv){try{
 if(argc!=3)throw std::runtime_error("Private output directory and projection required");
 std::filesystem::path out=argv[1];auto rawpath=(out/"raw").string(),preparedpath=(out/"prepared").string();
 ainvr::Nv12Frame frame;frame.width=3840;frame.height=1920;frame.pts=9007199254740993ULL;
 frame.pixels.resize(size_t(frame.width)*frame.height*3/2,128);
 for(int y=0;y<frame.height;++y)for(int x=0;x<frame.width;++x)frame.pixels[size_t(y)*frame.width+x]=32+(x/16+y/16)%190;
 ai_service::FrameResult result;result.channel_id="recovery-test";result.frame_width=frame.width;result.frame_height=frame.height;
 result.timestamp=1791720794.1234567;result.frame_pts_ns=9007199254740993LL;result.frame_index=9;
 ai_service::Detection d;d.class_name="person";d.confidence=0.876543210987;d.bbox={1300.25,500.5,600.75,600.25};result.detections.push_back(d);
 d.bbox={1900.75,400.25,500.5,700.75};result.detections.push_back(d);
 ai_service::config::SnapshotConfig config;config.enabled=true;config.projection_mode=argv[2];
 auto task=ainvr::MakeRawSnapshotTask(std::move(frame),result,config,"AINVR recovery",3,true,false);
 auto ids=task.metadata.at("image_ids").get<std::vector<std::string>>();auto taskid=ainvr::NewArchiveId();
 auto child=fork();Require(child>=0);if(!child){try{ainvr::RawFrameSpool raw(rawpath,64*1024*1024);raw.Stage(taskid,task);std::_Exit(21);}catch(...){std::_Exit(1);}}Wait(child,21);
 child=fork();Require(child>=0);if(!child){try{
  ainvr::RawFrameSpool raw(rawpath,64*1024*1024);ainvr::ArchiveSpool prepared(preparedpath,32*1024*1024,100);
  ainvr::SnapshotRenderer renderer;ainvr::PrepareRawSnapshots(raw,prepared,renderer,[](const auto&){std::_Exit(22);});std::_Exit(1);
 }catch(...){std::_Exit(2);}}Wait(child,22);
 ainvr::RawFrameSpool raw(rawpath,64*1024*1024);ainvr::ArchiveSpool prepared(preparedpath,32*1024*1024,100);
 Require(raw.Pending().size()==1&&prepared.Pending()==std::vector<std::string>{ids[0]});
 ainvr::SnapshotRenderer renderer;Require(ainvr::PrepareRawSnapshots(raw,prepared,renderer)==1);
 Require(raw.Pending().empty()&&prepared.Pending().size()==2);
 Require(ainvr::PrepareRawSnapshots(raw,prepared,renderer)==0);
 for(size_t i=0;i<ids.size();++i)prepared.Deliver(ids[i],[&](const auto& bytes){
  bson_t doc;Require(bson_init_static(&doc,bytes.data(),bytes.size()));bson_iter_t root,image;
  bson_iter_init(&root,&doc);Require(bson_iter_find_descendant(&root,"image.data",&image)&&BSON_ITER_HOLDS_BINARY(&image));
  bson_subtype_t type;uint32_t count;const uint8_t* data;bson_iter_binary(&image,&type,&count,&data);
  std::ofstream file(out/("recovered-"+std::to_string(i)+".jpg"),std::ios::binary);file.write(reinterpret_cast<const char*>(data),count);Require(bool(file));
 });
 Require(prepared.Pending().empty());
 std::cout<<"PASS raw crash + partial JPEG crash recovery; stable two image IDs, no duplicate preparation; projection="<<argv[2]<<'\n';
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
