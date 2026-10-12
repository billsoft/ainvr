// Copyright AINVR. Verify real inference records after independent-process replay.
#include "output/archive_delivery.hpp"
#include <fstream>
#include <iostream>
#include <cstdlib>
int main(int argc,char**argv){try{
  auto* uri=getenv("AINVR_TEST_MONGO_URI");if(argc!=5||!uri)throw std::runtime_error("Expected report, images, spool, test collection and private URI");
  std::string collection=argv[4];if(collection.rfind("test_pipeline_",0)!=0)throw std::runtime_error("Test namespace required");
  std::ifstream source(argv[1]);nlohmann::json report;source>>report;
  ainvr::ArchiveSpool spool(argv[3],128*1024*1024,10000);ainvr::ArchiveMongo mongo(uri,"ainvr_snapshots",collection);
  if(mongo.Count())throw std::runtime_error("Test collection must be empty");
  size_t expected=0;for(const auto& f:report.at("frames"))expected+=f.at("snapshots").size();
  if(!expected||spool.Pending().size()!=expected)throw std::runtime_error("Missing staged detections");
  // This fresh probe run has no deletion requests; the production helper still
  // exercises the journal-aware path. Channel journaling is separate work.
  ai_service::output::HistoryDeletions journal;
  auto replay=ainvr::ReplayPreparedArchiveWithDeletions(spool,mongo,journal,10000);
  if(replay.committed!=expected||replay.deleted||mongo.Count()!=int64_t(expected)||!spool.Pending().empty())throw std::runtime_error("Archive count mismatch");
  for(const auto& frame:report.at("frames"))for(const auto& image:frame.at("snapshots")){
    auto bytes=mongo.Get(image.at("archive_id"));if(!bytes)throw std::runtime_error("Missing archived target");
    bson_t doc;bson_init_static(&doc,bytes->data(),bytes->size());
    auto field=[&](const char* name){bson_iter_t root,value;bson_iter_init(&root,&doc);if(!bson_iter_find_descendant(&root,name,&value))throw std::runtime_error(name);return value;};
    auto pts=field("frame_pts_ns"),timestamp=field("timestamp"),label=field("class_id");
    if(!BSON_ITER_HOLDS_INT64(&pts)||bson_iter_int64(&pts)!=frame.at("source_pts_ns").get<int64_t>()||std::abs(bson_iter_as_double(&timestamp)-frame.at("timestamp").get<double>())>.001)throw std::runtime_error("Archive timestamp mismatch");
    const auto& detection=frame.at("detections").at(image.at("detection_index").get<size_t>());
    if(bson_iter_as_int64(&label)!=detection.at("class_id").get<int>())throw std::runtime_error("Archive detection mismatch");
    std::ifstream file(std::filesystem::path(argv[2])/image.at("file").get<std::string>(),std::ios::binary);
    std::vector<uint8_t> jpeg((std::istreambuf_iterator<char>(file)),{});
    for(auto key:{"image.data","original_image.data"}){auto value=field(key);if(!BSON_ITER_HOLDS_BINARY(&value))throw std::runtime_error("Missing JPEG binary");bson_subtype_t type;uint32_t size;const uint8_t* data;bson_iter_binary(&value,&type,&size,&data);if(std::vector<uint8_t>(data,data+size)!=jpeg)throw std::runtime_error("Archived JPEG mismatch");}
  }
  auto again=ainvr::ReplayPreparedArchiveWithDeletions(spool,mongo,journal,10000);
  if(again.committed||again.deleted||mongo.Count()!=int64_t(expected))throw std::runtime_error("Repeated replay changed records");
  std::cout<<nlohmann::json({{"passed",true},{"documents",expected},{"pending",spool.Pending().size()},{"collection",collection}}).dump()<<"\n";
}catch(const std::exception& e){std::cerr<<e.what()<<"\n";return 1;}}
