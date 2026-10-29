// Real isolated Mongo and HTTP. The lease callback is a named software
// authority oracle; PG authorization itself has separate real-PG coverage.
#pragma once
#include "migration_sample.hpp"
#include "model_migration_authorization.hpp"
inline void RunMigrationWriteCases(const std::string& uri,const std::string& database) {
  auto mongo=mongoc_client_new(uri.c_str());auto db=mongoc_client_get_database(mongo,database.c_str());
  const auto cleanup=[&]{bson_error_t error{};const bool ok=mongoc_database_drop(db,&error);
    mongoc_database_destroy(db);mongoc_client_destroy(mongo);Check(ok,"migration fixture cleanup");};
  try {
    HistoryBudget budget;budget.max_samples=2;HistoryMongo history(uri,database,budget);history.Initialize();
    auto access=Access();const auto at=Now()-2000;
    const RuntimeModelPin old{"siglip-so400m-i18n-full-int8",std::string(64,'b'),"search-v1-"+std::string(64,'b')};
    const RuntimeModelPin target{"siglip2-base-full-int8",std::string(64,'c'),"search-v1-"+std::string(64,'c')};
    const auto pin=[](const RuntimeModelPin& value){return Json{{"package_id",value.package_id},{"package_sha256",value.package_sha256},{"model_version",value.model_version}};};
    const auto create=[&](int id,int64_t captured,bool slot){
      Sample sample;sample.record={Id(id),channel,"fixture-processor","fixture-session","fixture-track",old.model_version,captured,false,{1,0}};
      sample.evidence=SampleJson(captured).at("evidence");sample.evidence["source_pts_ns"]=std::to_string(captured*1000000);
      sample.evidence["source_frame_index"]=std::to_string(id);sample.expires_ms=Now()+60000;sample.jpeg={0xff,0xd8,0xff,0xd9};
      if(slot){sample.track_slot=0;history.ReplaceTrackSlot(sample,0,"","source-first");}else history.Put(sample);
      return history.Get(sample.record.id,true).value();
    };
    auto source=create(800,at,true);const auto other=create(801,at+100,false);
    const auto source_sha=SampleSha256(source.jpeg.data(),source.jpeg.size());
    Json body{{"job_id",Id(900)},{"worker",Id(901)},{"generation",2},{"actor","fixture-actor"},{"payload_fingerprint",std::string(64,'a')},
      {"source",{{"sample_id",source.record.id},{"fingerprint",source.fingerprint},{"jpeg_sha256",source_sha}}},
      {"target",pin(target)}};
    std::vector<float> vector(768,0);vector[0]=1;body["target"]["vector"]=vector;
    int authorizations=0;bool revoke=false,delete_before_commit=false,replace_before_commit=false,wrong_grant=false,low_watermark=false;
    int64_t active_time=at;
    access.migration_authorization=[&](const Json& request)->Json {
      ++authorizations;
      Check(request.at("action")=="authorize_write"&&request.at("job_id")==Id(900)&&request.at("worker")==Id(901),"migration fixed worker action");
      if(request.at("actor")!="fixture-actor"||request.at("generation")!=2||request.at("payload_fingerprint")!=std::string(64,'a'))return {{"grant",nullptr}};
      if(request.contains("source")){
        const auto& actual=request.at("source");
        Check(actual.at("channel_id")==channel&&actual.at("ordinal").is_string()&&actual.at("captured_ms")==active_time,
          "migration did not authorize actual Mongo metadata");
        if(revoke)return {{"grant",nullptr}};
        if(delete_before_commit)history.DeleteRange(channel,active_time,active_time+1);
        if(replace_before_commit){
          auto replacement=history.Get(actual.at("sample_id").get<std::string>(),true).value();
          const auto expected=replacement.fingerprint;++replacement.record.captured_ms;
          replacement.evidence["frame_id"]=Id(899);
          replacement.evidence["source_pts_ns"]=std::to_string(std::stoll(replacement.evidence.at("source_pts_ns").get<std::string>())+1000000);
          replacement.evidence["source_frame_index"]=std::to_string(std::stoll(replacement.evidence.at("source_frame_index").get<std::string>())+1);
          history.ReplaceTrackSlot(replacement,0,expected,"source-late-replacement");
        }
      }
      auto selected=target;if(wrong_grant)selected.package_id="siglip-so400m-i18n-full-int8";
      return {{"grant",{{"job_id",Id(900)},{"worker",Id(901)},{"generation",2},{"payload_fingerprint",std::string(64,'a')},
        {"source",pin(old)},{"target",pin(selected)},{"scope",{{"channel_ids",{channel}},{"from_ms",at-1},{"to_ms",at+5000}}},
        {"source_high_watermark",low_watermark?"0":"9223372036854775807"},{"lease_until_ms",Now()+10000},
        {"job_expires_ms",Now()+60000},{"target_checkpoint","0"}}}};
    };
    HttpService service(&history,access);RunningServer server(service);httplib::Client client("127.0.0.1",server.port);client.set_read_timeout(10);
    const httplib::Headers management{{"x-service-token",std::string(48,'m')}};
    const auto post=[&](const Json& value,int status){return Expect(client.Post("/v1/model-migrations/write-target",management,value.dump(),"application/json"),status);};
    const auto receipt=[&](int status=200){auto request=body;request["target"].erase("vector");
      return Expect(client.Post("/v1/model-migrations/target-receipt",management,request.dump(),"application/json"),status);};
    Expect(client.Post("/v1/model-migrations/write-target",{},body.dump(),"application/json"),401);
    Expect(client.Post("/v1/model-migrations/write-target",auth,body.dump(),"application/json"),403);
    Expect(client.Post("/v1/model-migrations/write-target",producer,body.dump(),"application/json"),403);
    auto lookup=body;lookup["target"].erase("vector");
    Expect(client.Post("/v1/model-migrations/target-receipt",auth,lookup.dump(),"application/json"),403);
    Expect(client.Post("/v1/model-migrations/target-receipt",producer,lookup.dump(),"application/json"),403);
    Check(receipt().at("status")=="not_found","receipt invented a committed target");
    auto bad=body;bad["source"]["scope"]={};post(bad,400);
    bad=body;bad["target"]["vector"]=std::vector<float>(767,0);post(bad,400);
    bad=body;bad["target"]["vector"]=std::vector<float>(768,0);post(bad,400);
    bad=body;bad["actor"]="different-actor";post(bad,409);
    bad=body;bad["source"]["jpeg_sha256"]=std::string(64,'0');post(bad,409);
    wrong_grant=true;post(body,409);wrong_grant=false;
    low_watermark=true;post(body,409);low_watermark=false;
    // Full quota must never evict either source or unrelated unexpired history.
    Check(post(body,507).at("error")=="capacity_exceeded","migration quota misreported");
    Check(history.Get(source.record.id)&&history.Get(other.record.id)&&history.Usage().at("samples")==2,"migration evicted old history");
    history.DeleteRange(channel,at+100,at+101);
    // Corrupt only the old vector; the verified original image remains useful.
    {
      auto collection=mongoc_client_get_collection(mongo,database.c_str(),"search_samples");bson_error_t error{};
      const auto filter_text=Json{{"_id",source.record.id}}.dump();
      const auto set_text=Json{{"$set",{{"vector",{{"$binary",{{"base64","AA=="},{"subType","00"}}}}}}}}.dump();
      auto filter=bson_new_from_json(reinterpret_cast<const uint8_t*>(filter_text.data()),-1,&error);
      auto set=bson_new_from_json(reinterpret_cast<const uint8_t*>(set_text.data()),-1,&error);
      const bool ok=filter&&set&&mongoc_collection_update_one(collection,filter,set,nullptr,nullptr,&error);
      bson_destroy(filter);bson_destroy(set);mongoc_collection_destroy(collection);Check(ok,"migration corrupt vector fixture");
    }
    bool corrupt=false;try{history.Get(source.record.id);}catch(...){corrupt=true;}Check(corrupt,"old vector not corrupt");
    const auto before_calls=authorizations;const auto ack=post(body,200);Check(authorizations==before_calls+2,"migration skipped double authorization");
    const auto target_id=ack.at("sample_id").get<std::string>();
    auto saved=history.Get(target_id,true);Check(saved&&saved->track_slot==source.track_slot&&saved->jpeg==source.jpeg&&saved->expires_ms==source.expires_ms,
      "migration lost slot/image/original expiry");
    Check(saved->record.model==target.model_version&&saved->fingerprint==ack.at("fingerprint")&&ack.at("ordinal").is_string(),"migration ACK identity mismatch");
    Check(post(body,200)==ack,"unknown write ACK retry changed identity or ordinal");
    const auto confirmed=receipt();Check(confirmed.at("status")=="committed"&&confirmed.at("fingerprint")==ack.at("fingerprint")&&
      confirmed.at("ordinal")==ack.at("ordinal")&&history.Usage().at("samples")==2,"receipt changed data or lost exact commit");
    bad=body;bad["target"]["vector"][0]=0;bad["target"]["vector"][1]=1;
    Check(post(bad,200)==ack,"same-lineage first write did not win across a different re-encode");
    Check(history.Get(target_id)->fingerprint==saved->fingerprint,"different retry overwrote acknowledged target");
    auto ordinary=*saved;ordinary.record.vector[0]=0;ordinary.record.vector[1]=1;bool strict=false;
    try{history.ReplaceTrackSlot(ordinary,0,saved->fingerprint,source.fingerprint);}catch(const std::runtime_error& error){strict=std::string(error.what())=="search_slot_token_conflict";}
    Check(strict,"ordinary producer was loosened by migration first-wins");
    auto future=*saved;const auto expected=future.fingerprint;++future.record.captured_ms;
    future.evidence["frame_id"]=Id(898);future.evidence.erase("reencoded_from");
    future.evidence["source_pts_ns"]=std::to_string(std::stoll(future.evidence.at("source_pts_ns").get<std::string>())+1000000);
    future.evidence["source_frame_index"]=std::to_string(std::stoll(future.evidence.at("source_frame_index").get<std::string>())+1);
    history.ReplaceTrackSlot(future,0,expected,"future-producer");
    const auto replaced=receipt();Check(replaced.at("status")=="replaced"&&replaced.at("fingerprint").is_null()&&
      replaced.at("sample_id").is_null(),"receipt exposed or relabelled newer target slot");
    post(body,400);
    // Fresh source with a final lease revoke must never be written.
    history.DeleteRange(channel,at,at+2);active_time=at+1000;source=create(802,active_time,true);
    body["source"]["sample_id"]=source.record.id;body["source"]["fingerprint"]=source.fingerprint;
    revoke=true;post(body,409);revoke=false;
    Check(history.Usage().at("samples")==1,"revoked migration wrote target");
    // Even a grant issued just before a real Mongo deletion cannot bypass the
    // source guard in the same existing writer lock.
    delete_before_commit=true;post(body,409);delete_before_commit=false;
    Check(history.Usage().at("samples")==0,"deleted source was re-created as target");
    Check(receipt().at("status")=="source_changed","deleted source receipt resurrected old identity");
    active_time=at+2000;source=create(803,active_time,true);
    body["source"]["sample_id"]=source.record.id;body["source"]["fingerprint"]=source.fingerprint;
    const auto before_late=post(body,200);
    replace_before_commit=true;post(body,409);replace_before_commit=false;
    Check(history.Usage().at("samples")==2&&history.Get(source.record.id)->fingerprint!=source.fingerprint&&
      history.Get(before_late.at("sample_id").get<std::string>())->fingerprint==before_late.at("fingerprint"),
      "late slot replacement was lost or old generation committed");
    const auto old_body=body;
    const auto updated_source=history.Get(source.record.id,true).value();
    active_time=updated_source.record.captured_ms;body["source"]["fingerprint"]=updated_source.fingerprint;
    Check(receipt().at("status")=="replaced","changed source falsely adopted old target lineage");
    const auto caught_up=post(body,200);
    Check(caught_up.at("sample_id")==before_late.at("sample_id")&&caught_up.at("fingerprint")!=before_late.at("fingerprint")&&
      std::stoll(caught_up.at("ordinal").template get<std::string>())>std::stoll(before_late.at("ordinal").template get<std::string>()),
      "legitimate new source slot could not update its target slot");
    post(old_body,404);
    Check(history.Get(caught_up.at("sample_id").template get<std::string>())->fingerprint==caught_up.at("fingerprint"),
      "late old source overwrote the caught-up target slot");
    history.DeleteRange(channel,at,at+5000);
    // A shorter new retention setting cannot discard or block the unchanged
    // expiry of still-live old history. Ordinary producers keep the new limit.
    auto old_budget=budget;old_budget.retention_ms=365LL*86400000;
    HistoryMongo old_retention(uri,database,old_budget);old_retention.Initialize();
    Sample retained;retained.record={Id(804),channel,"fixture-processor","fixture-session","retained-track",old.model_version,
      Now()-100LL*86400000,false,{1,0}};
    retained.evidence=SampleJson(retained.record.captured_ms).at("evidence");retained.jpeg={255,216,255,217};
    retained.expires_ms=Now()+86400000;old_retention.Put(retained);
    retained=history.Get(retained.record.id,true).value();
    const Scope retained_scope{{channel},retained.record.captured_ms-1,retained.record.captured_ms+1,20};
    const auto retained_row=history.ReadReencodeSource(retained.record.id,retained.fingerprint,old.model_version,retained_scope).value();
    const auto derivative=MakeReencodedSample(retained,old,target,FindPackageSpec(target.package_id),vector,retained.fingerprint,
      retained_row.jpeg_sha256,Now());
    history.WriteReencodedSample(derivative,retained_row);
    Check(history.Get(derivative.record.id)->expires_ms==retained.expires_ms,"migration changed retained original expiry");
    retained.record.id=Id(805);bool retention_rejected=false;
    try{history.Put(retained);}catch(const std::invalid_argument&){retention_rejected=true;}
    Check(retention_rejected,"ordinary producer bypassed current retention through migration exception");
    cleanup();
  }catch(...){cleanup();throw;}
}
