// Copyright AINVR. Real Mongo retention behavior on isolated collections.
#include "output/archive_mongo.hpp"
#include <bson/bson.h>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
void Require(bool b){if(!b)throw std::runtime_error("Archive retention assertion failed");}
std::vector<uint8_t> Record(const std::string& id,double timestamp){
 bson_t doc;bson_init(&doc);bson_oid_t oid;bson_oid_init_from_string(&oid,id.c_str());
 BSON_APPEND_OID(&doc,"_id",&oid);BSON_APPEND_UTF8(&doc,"image_id",id.c_str());BSON_APPEND_DOUBLE(&doc,"timestamp",timestamp);
 auto data=bson_get_data(&doc);std::vector<uint8_t> result(data,data+doc.len);bson_destroy(&doc);return result;
}
int main(int argc,char**argv){try{
 const auto* uri=getenv("AINVR_TEST_MONGO_URI");Require(argc==2&&uri);
 std::string name=argv[1];Require(name.rfind("test_retention_",0)==0);
 ainvr::ArchiveMongo mongo(uri,"ainvr_snapshots",name),other(uri,"ainvr_snapshots",name+"_other");
 Require(mongo.Count()==0&&other.Count()==0);
 std::vector<std::string> ids={"507f1f77bcf86cd799439011","507f1f77bcf86cd799439012","507f1f77bcf86cd799439013","507f1f77bcf86cd799439014","507f1f77bcf86cd799439015"};
 for(int i=4;i>=0;--i)mongo.Put(Record(ids[i],100-i));
 other.Put(Record(ids[0],1));mongo.Put(Record(ids[2],98));Require(mongo.Count()==5);
 bool rejected=false;try{mongo.TrimHistory(-1);}catch(const std::invalid_argument&){rejected=true;}
 Require(rejected&&mongo.Count()==5);Require(mongo.TrimHistory(10)==0);
 Require(mongo.TrimHistory(2)==3&&mongo.Count()==2);
 for(int i=0;i<5;++i)Require(bool(mongo.Get(ids[i]))==(i>=3));
 Require(other.Count()==1&&other.Get(ids[0]).has_value());
 Require(mongo.TrimHistory(2)==0);Require(mongo.TrimHistory(1)==1&&mongo.Get(ids[4]).has_value());
 Require(mongo.TrimHistory(0)==1&&mongo.Count()==0&&mongo.TrimHistory(0)==0);
 std::cout<<"PASS indexed ObjectId retention, reverse insertion, idempotency, limit reduction, invalid limit, collection isolation\n";
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
