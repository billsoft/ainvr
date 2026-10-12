// Copyright AINVR. Original and processed JPEG retrieval from actual Mongo.
#include "output/archive_mongo.hpp"
#include <bson/bson.h>
#include <fstream>
#include <cstdlib>
#include <iostream>
void Require(bool b){if(!b)throw std::runtime_error("Archive image assertion failed");}
std::vector<uint8_t> Read(const char* path){std::ifstream f(path,std::ios::binary);return {(std::istreambuf_iterator<char>(f)),{}};}
int main(int argc,char**argv){try{
 auto uri=getenv("AINVR_TEST_MONGO_URI");Require(argc==4&&uri);std::string collection=argv[1];Require(collection.rfind("test_image_",0)==0);
 auto processed=Read(argv[2]),original=Read(argv[3]);Require(processed.size()>4&&original.size()>4&&processed!=original);
 ainvr::ArchiveMongo mongo(uri,"ainvr_snapshots",collection);Require(mongo.Count()==0);
 const std::string id="507f1f77bcf86cd799439011";bson_oid_t oid;bson_oid_init_from_string(&oid,id.c_str());
 bson_t doc,child;bson_init(&doc);BSON_APPEND_OID(&doc,"_id",&oid);BSON_APPEND_UTF8(&doc,"image_id",id.c_str());
 BSON_APPEND_DOCUMENT_BEGIN(&doc,"image",&child);BSON_APPEND_BINARY(&child,"data",BSON_SUBTYPE_BINARY,processed.data(),processed.size());bson_append_document_end(&doc,&child);
 BSON_APPEND_DOCUMENT_BEGIN(&doc,"original_image",&child);BSON_APPEND_BINARY(&child,"data",BSON_SUBTYPE_BINARY,original.data(),original.size());bson_append_document_end(&doc,&child);
 auto data=bson_get_data(&doc);mongo.Put(std::vector<uint8_t>(data,data+doc.len));bson_destroy(&doc);
 Require(mongo.GetImage(id,false)==processed&&mongo.GetImage(id,true)==original);
 Require(!mongo.GetImage("507f1f77bcf86cd799439099")&&!mongo.GetImage("invalid"));
 // Legacy records missing an original must not silently return processed pixels.
 bson_init(&doc);BSON_APPEND_OID(&doc,"_id",&oid);BSON_APPEND_UTF8(&doc,"image_id",id.c_str());
 BSON_APPEND_DOCUMENT_BEGIN(&doc,"image",&child);BSON_APPEND_BINARY(&child,"data",BSON_SUBTYPE_BINARY,processed.data(),processed.size());bson_append_document_end(&doc,&child);
 data=bson_get_data(&doc);mongo.Put(std::vector<uint8_t>(data,data+doc.len));bson_destroy(&doc);
 Require(mongo.GetImage(id,false)==processed&&!mongo.GetImage(id,true));
 mongo.TrimHistory(0);Require(!mongo.GetImage(id,false));
 std::cout<<"PASS distinct processed/original JPEG byte equality, missing original, invalid ID, trimmed image not-found\n";
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
