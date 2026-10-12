// Copyright AINVR. Real live stream -> VPU -> ONNX -> crop/JPEG -> Mongo.
#include "output/durable_snapshot_sink.hpp"
#include "utils/coco.hpp"
#include <fstream>
#include <iostream>
#include <cstdlib>
int main(int argc,char**argv){try{
 const char* uri=getenv("AINVR_TEST_MONGO_URI");
 if((argc!=5&&argc!=6)||!uri)throw std::runtime_error("model source private-output test-collection plus private URI required");
 std::string collection=argv[4];if(collection.rfind("test_live_archive_",0)!=0)throw std::runtime_error("Isolated collection required");
 std::filesystem::path out=argv[3];
 ainvr::RawFrameSpool raw((out/"raw").string(),256*1024*1024);
 ainvr::ArchiveSpool spool((out/"spool").string(),128*1024*1024,10000);
 ainvr::ArchiveMongo mongo(uri,"ainvr_snapshots",collection);if(mongo.Count()!=0)throw std::runtime_error("Collection not empty");
 ai_service::output::HistoryDeletions deletions;deletions.Load(out.string());
 ainvr::SnapshotSinkStats stats;ai_service::config::SnapshotConfig cfg;cfg.enabled=true;cfg.projection_mode=argc==6?argv[5]:"none";
 ainvr::ChannelWorkerOptions o;o.id="live-archive-test";o.url=argv[2];o.processor.model_path=argv[1];
 for(auto name:ai_service::utils::kCocoNames)o.processor.classes.emplace_back(name);
 o.archive_factory=[&]{return std::make_unique<ainvr::DurableSnapshotSink>(cfg,"AINVR live archive test",1,raw,spool,mongo,stats,&deletions);};
 ainvr::OnnxChannelWorker worker(o,[]{return true;});worker.Start();
 auto until=std::chrono::steady_clock::now()+std::chrono::seconds(45);
 while(std::chrono::steady_clock::now()<until){
  if(worker.Status()["state"]=="error"||(stats.frames>=2&&stats.records>=1))break;
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
 }
 worker.Stop();auto status=worker.Status();
 if(status["state"]=="error")throw std::runtime_error(status["last_error"].get<std::string>());
 if(stats.frames<2||stats.records<1||stats.delivery_failures||mongo.Count()!=int64_t(stats.records.load())||!spool.Pending().empty()||!raw.Pending().empty())
  throw std::runtime_error("Live archive did not durably drain to Mongo");
 size_t verified=0;
 for(const auto&id:stats.ids){
  auto bytes=mongo.Get(id);if(!bytes)throw std::runtime_error("Missing record");
  bson_t doc;bson_init_static(&doc,bytes->data(),bytes->size());bson_iter_t root,image,channel;
  bson_iter_init(&root,&doc);
  if(!bson_iter_find_descendant(&root,"image.data",&image)||!BSON_ITER_HOLDS_BINARY(&image))throw std::runtime_error("Missing JPEG");
  if(!bson_iter_init_find(&channel,&doc,"channel_id")||std::string(bson_iter_utf8(&channel,nullptr))!=o.id)throw std::runtime_error("Wrong archive channel");
  bson_subtype_t type;uint32_t length;const uint8_t* jpeg;bson_iter_binary(&image,&type,&length,&jpeg);
  if(length<4||jpeg[0]!=255||jpeg[1]!=216)throw std::runtime_error("Invalid JPEG signature");
  if(!verified){std::ofstream f(out/"sample.jpg",std::ios::binary);f.write(reinterpret_cast<const char*>(jpeg),length);if(!f)throw std::runtime_error("Sample write failed");}
  ++verified;
 }
 nlohmann::json report={{"passed",true},{"frames",stats.frames.load()},{"records",stats.records.load()},
  {"projection",cfg.projection_mode},{"verified",verified},{"status",status},{"render_backends",stats.render_backends},{"encoder_backends",stats.encoder_backends},
  {"scope","Real live pipeline, isolated Mongo; injected license policy; durable raw inputs enabled; production history API and retention pending"}};
 std::ofstream(out/"summary.json")<<report.dump(2);std::cout<<report.dump()<<'\n';
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
