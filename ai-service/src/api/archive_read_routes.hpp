// Copyright AINVR. Reference-compatible authenticated snapshot reads.
#pragma once
#include "output/archive_mongo.hpp"
#include <httplib.h>
#include <charconv>
#include <cmath>
namespace ainvr {
struct ArchiveHttpError:std::runtime_error {
 int status;std::string code;
 ArchiveHttpError(int s,std::string c,std::string message):std::runtime_error(message),status(s),code(std::move(c)){}
};
inline std::optional<double> ArchiveDouble(const httplib::Request& request,const char* key){
 if(!request.has_param(key))return {};
 const auto value=request.get_param_value(key);size_t used=0;double number;
 try{number=std::stod(value,&used);}catch(...){throw ArchiveHttpError(422,"invalid_parameter","Invalid numeric query parameter");}
 if(used!=value.size()||!std::isfinite(number))throw ArchiveHttpError(422,"invalid_parameter","Invalid numeric query parameter");
 return number;
}
// wrap supplies existing authentication. lookup validates channel existence first.
template<class Wrap,class Lookup,class Config>
void RegisterArchiveReadRoutes(httplib::Server& server,Wrap wrap,Lookup lookup,Config config){
 server.Get(R"(/api/v1/channels/([^/]+)/snapshots/overview)",wrap([lookup,config](const auto& q,auto& r){
  const std::string id=q.matches[1];auto options=config(id);auto store=lookup(id);
  auto overview=store->Overview(options.max_count);
  overview["enabled"]=options.enabled;overview["min_interval_ms"]=options.min_interval_ms;
  r.set_content(overview.dump(),"application/json");
 }));
 server.Get(R"(/api/v1/channels/([^/]+)/snapshots/heatmap)",wrap([lookup](const auto& q,auto& r){
  auto store=lookup(std::string(q.matches[1]));
  int bucket=300;
  if(q.has_param("bucket_s")){
   const auto text=q.get_param_value("bucket_s");auto parsed=std::from_chars(text.data(),text.data()+text.size(),bucket);
   if(parsed.ec!=std::errc{}||parsed.ptr!=text.data()+text.size())throw ArchiveHttpError(422,"invalid_parameter","Invalid bucket interval");
  }
  auto from=ArchiveDouble(q,"from_ts"),to=ArchiveDouble(q,"to_ts");
  nlohmann::json result;
  try{result=store->Heatmap(from,to,bucket);}
  catch(const std::exception&){throw ArchiveHttpError(503,"archive_unavailable","Archive access is not ready");}
  r.set_content(result.dump(),"application/json");
 }));
 server.Get(R"(/api/v1/channels/([^/]+)/snapshots)",wrap([lookup](const auto& q,auto& r){
  int limit=20;
  if(q.has_param("limit")){
   const auto text=q.get_param_value("limit");auto parsed=std::from_chars(text.data(),text.data()+text.size(),limit);
   if(parsed.ec!=std::errc{}||parsed.ptr!=text.data()+text.size())throw ArchiveHttpError(422,"invalid_parameter","Invalid page limit");
  }
  auto confidence=ArchiveDouble(q,"min_confidence"),from=ArchiveDouble(q,"from_ts"),to=ArchiveDouble(q,"to_ts");
  std::optional<std::string> cursor;if(q.has_param("cursor"))cursor=q.get_param_value("cursor");
  auto store=lookup(std::string(q.matches[1]));
  nlohmann::json page;
  try{page=store->ListPage(cursor,limit,confidence.value_or(0),from,to);}
  catch(const std::exception&){throw ArchiveHttpError(503,"archive_unavailable","Archive access is not ready");}
  r.set_content(page.dump(),"application/json");
 }));
 server.Get(R"(/api/v1/channels/([^/]+)/snapshots/([^/]+)/image)",wrap([lookup](const auto& q,auto& r){
  auto store=lookup(std::string(q.matches[1]));
  auto variant=q.has_param("variant")?q.get_param_value("variant"):"processed";
  if(variant!="processed"&&variant!="original")throw ArchiveHttpError(400,"invalid_parameter","variant must be processed or original");
  std::optional<std::vector<uint8_t>> bytes;
  try{bytes=store->GetImage(std::string(q.matches[2]),variant=="original");}
  catch(const std::exception&){throw ArchiveHttpError(503,"archive_unavailable","Archive access is not ready");}
  if(!bytes)throw ArchiveHttpError(404,"not_found","Image does not exist or has been removed");
  r.set_content(reinterpret_cast<const char*>(bytes->data()),bytes->size(),"image/jpeg");
 }));
}
}
