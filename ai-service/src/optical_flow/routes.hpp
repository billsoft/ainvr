// Copyright AINVR. Existing native control listener; no public camera route.
#pragma once
#include "runtime.hpp"
#include <httplib.h>
namespace ainvr::flow {
inline void Register(httplib::Server& server,std::shared_ptr<Runtime> runtime){
  auto handler=[runtime](const httplib::Request& req,httplib::Response& res){
    res.set_header("Cache-Control","no-store");
    auto fail=[&](int status,const char* code){res.status=status;
      res.set_content(Json{{"error",{{"code",code}}}}.dump(),"application/json");};
    try{
      Peer peer{req.remote_addr,req.get_header_value("x-service-token")};
      runtime->RequireAccess(peer);
      auto type=req.get_header_value("Content-Type");
      if(type!="application/json"&&type!="application/json; charset=utf-8")throw Error(422,"flow_content_type");
      res.set_content(runtime->Call(req.body,peer,req.path=="/internal/ptz/scene-match").dump(),"application/json");
    }catch(const Error& e){if(e.status==429)res.set_header("Retry-After","1");fail(e.status,e.what());}
    catch(...){fail(503,"flow_unavailable");}
  };
  server.Post("/internal/ptz/flow",handler);
  server.Post("/internal/ptz/scene-match",handler);
}
}
