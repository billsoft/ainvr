// Copyright AINVR. Register in the EXISTING loopback control server only.
// No library/history/search/database endpoints live in this native module.
#pragma once
#include "runtime.hpp"
#include <httplib.h>

namespace ainvr::face {
using ConfigureHandler=std::function<Json(const Json&,const Peer&)>;
using StatusHandler=std::function<Json(const Peer&)>;
inline void RegisterExtractorRoutes(httplib::Server& server,std::shared_ptr<Runtime> runtime,
    ConfigureHandler configure={},StatusHandler status={}) {
  if(!runtime)throw std::invalid_argument("face_runtime_missing");
  auto handler=[runtime,configure,status](const std::string& action){
    return [runtime,configure,status,action](const httplib::Request& req,httplib::Response& res){
      res.set_header("Cache-Control","no-store");
      try{
        const Peer peer{req.remote_addr,req.get_header_value("x-service-token")};
        runtime->RequireAccess(peer); // BEFORE parsing, including missing token.
        Json meta;
        if(action=="extract"){
          if(req.body.size()>8ULL*1024*1024)throw Error(413,"face_image_size");
          if(req.get_header_value("Content-Type")!="image/jpeg")throw Error(422,"invalid_face_content_type");
          const auto text=req.get_header_value("x-ainvr-face");
          if(text.empty()||text.size()>4096)throw Error(422,"invalid_face_metadata");
          meta=Json::parse(text);
        }else if(action=="configure"){
          if(req.body.size()>4096)throw Error(413,"face_metadata_large");
          if(req.get_header_value("Content-Type")!="application/json")throw Error(422,"invalid_face_content_type");
          meta=Json::parse(req.body);
        }else{
          if(!req.body.empty())throw Error(422,"invalid_face_request");
          meta=Json::object();
        }
        if(!meta.is_object()||meta.contains("action"))throw Error(422,"invalid_face_request");
        Json result;
        if(action=="configure"&&configure)result=configure(meta,peer);
        else if(action=="status"&&status)result=status(peer);
        else {meta["action"]=action;result=runtime->Call(meta,action=="extract"?req.body:"",peer);}
        res.status=200;res.set_content(result.dump(),"application/json");
      }catch(const Error& error){res.status=error.status;res.set_content(Json{{"error",{{"code",error.what()}}}}.dump(),"application/json");}
      catch(const Json::exception&){res.status=422;res.set_content("{\"error\":{\"code\":\"invalid_face_request\"}}","application/json");}
      catch(...){res.status=503;res.set_content("{\"error\":{\"code\":\"face_extraction_unavailable\"}}","application/json");}
    };
  };
  server.Get("/v1/faces/extractor/status",handler("status"));
  server.Post("/v1/faces/extractor/configure",handler("configure"));
  server.Post("/v1/faces/extract",handler("extract"));
}
} // namespace ainvr::face
