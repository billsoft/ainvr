// Copyright AINVR. Reference-compatible snapshot paging on real Mongo.
#include "output/archive_mongo.hpp"
#include <bson/bson.h>
#include <cstdlib>
#include <iostream>
#include <limits>
void Require(bool b){if(!b)throw std::runtime_error("Archive query assertion failed");}
int main(int argc,char**argv){try{
 const auto* uri=getenv("AINVR_TEST_MONGO_URI");Require(argc==2&&uri);
 std::string name=argv[1];Require(name.rfind("test_overview_",0)==0);
 ainvr::ArchiveMongo mongo(uri,"ainvr_snapshots",name);Require(mongo.Count()==0);auto empty=mongo.Overview(100);Require(empty["connected"]==true&&empty["count"]==0&&empty["earliest_timestamp"].is_null()&&empty["latest_timestamp"].is_null());
 std::vector<std::string> ids={"507f1f77bcf86cd799439011","507f1f77bcf86cd799439012","507f1f77bcf86cd799439013","507f1f77bcf86cd799439014","507f1f77bcf86cd799439015"};
 const double base=1790168716.123456;
 for(int i=0;i<5;++i){
  bson_t doc,image;bson_init(&doc);bson_oid_t oid;bson_oid_init_from_string(&oid,ids[i].c_str());
  BSON_APPEND_OID(&doc,"_id",&oid);BSON_APPEND_UTF8(&doc,"image_id",ids[i].c_str());
  BSON_APPEND_UTF8(&doc,"channel_id","query-test");BSON_APPEND_DOUBLE(&doc,"timestamp",base+i*.01);
  BSON_APPEND_INT64(&doc,"frame_pts_ns",9007199254740993LL);
  if(i==2)BSON_APPEND_NULL(&doc,"confidence");else if(i!=3)BSON_APPEND_DOUBLE(&doc,"confidence",i==4?.9:.2);
  BSON_APPEND_DOCUMENT_BEGIN(&doc,"image",&image);BSON_APPEND_INT32(&image,"width",320);BSON_APPEND_INT32(&image,"height",240);
  const uint8_t bytes[]={255,216,255,217};BSON_APPEND_BINARY(&image,"data",BSON_SUBTYPE_BINARY,bytes,4);bson_append_document_end(&doc,&image);
  BSON_APPEND_UTF8(&doc,"embedding","private");BSON_APPEND_UTF8(&doc,"enhance_model","private");
  auto data=bson_get_data(&doc);mongo.Put(std::vector<uint8_t>(data,data+doc.len));bson_destroy(&doc);
 }
 auto page=mongo.ListPage({},2);Require(page["items"].size()==2&&page["items"][0]["image_id"]==ids[4]&&page["next_cursor"]==ids[3]);
 auto second=mongo.ListPage(page["next_cursor"].get<std::string>(),2);Require(second["items"][0]["image_id"]==ids[2]&&second["items"][1]["image_id"]==ids[1]);
 auto last=mongo.ListPage(second["next_cursor"].get<std::string>(),2);Require(last["items"].size()==1&&last["items"][0]["image_id"]==ids[0]&&last["next_cursor"].is_null());
 for(const auto& item:page["items"]){Require(item["image_width"]==320&&item["image_height"]==240&&item["frame_pts_ns"].get<int64_t>()==9007199254740993LL);Require(!item.contains("image")&&!item.contains("embedding")&&!item.contains("enhance_model"));}
 auto filtered=mongo.ListPage({},20,.8);Require(filtered["items"].size()==3);Require(filtered["items"][1]["confidence"].is_null()&&filtered["items"][2]["confidence"].is_null());
 auto precise=mongo.ListPage({},20,0,base+.02,base+.02);Require(precise["items"].size()==1&&precise["items"][0]["image_id"]==ids[2]);
 Require(mongo.ListPage("bad cursor",20)["items"].empty());Require(mongo.ListPage({},20,0,base+1,base)["items"].empty());
 bool rejected=false;try{mongo.ListPage({},20,std::numeric_limits<double>::quiet_NaN());}catch(const std::invalid_argument&){rejected=true;}Require(rejected);
 Require(mongo.ListPage({},0)["items"].size()==1);
 auto overview=mongo.Overview(100);
 Require(overview["connected"]==true&&overview["count"]==5&&overview["max_count"]==100);
 Require(overview["storage_bytes"].get<int64_t>()>0&&overview["earliest_timestamp"]==base&&overview["latest_timestamp"]==base+.04);
 ainvr::ArchiveMongo offline("mongodb://127.0.0.1:1","ainvr_snapshots",name);
 auto failure=offline.Overview(50);Require(failure["connected"]==false&&failure["count"]==0&&failure["max_count"]==50&&failure["last_error"]=="Archive database unavailable");
 std::cout<<"PASS overview empty/populated/unavailable, capacity and exact endpoint timestamps; reference paging, stable IDs, unknown confidence, subsecond timestamp range, 64-bit PTS, projected public fields\n";
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
