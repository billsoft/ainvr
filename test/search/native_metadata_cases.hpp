// Isolated Mongo/HTTP contract checks; no SDK, model or production calls.
#pragma once
inline void RunMetadataCases(const std::string& uri, const std::string& database) {
  auto mongo = mongoc_client_new(uri.c_str());
  auto db = mongoc_client_get_database(mongo, database.c_str());
  auto collection = mongoc_client_get_collection(mongo, database.c_str(), "search_samples");
  const auto cleanup = [&] {
    bson_error_t error{}; const bool ok = mongoc_database_drop(db, &error);
    mongoc_collection_destroy(collection); mongoc_database_destroy(db); mongoc_client_destroy(mongo);
    Check(ok, "metadata fixture cleanup");
  };
  try {
    HistoryBudget budget; budget.max_samples = 1000;
    HistoryMongo history(uri, database, budget); history.Initialize();
    auto access = Access();
    std::mutex profile_mutex; std::condition_variable profile_changed;
    bool profile_entered = false, profile_release = false;
    access.model_verification = [&](const std::string& id) -> Json {
      if (id == "unknown") throw std::invalid_argument("unknown_package");
      std::unique_lock<std::mutex> lock(profile_mutex); profile_entered = true; profile_changed.notify_all();
      profile_changed.wait(lock, [&] { return profile_release; });
      return {{"package_id", id}, {"runtime_ready", false}};
    };
    HttpService service(&history, access); RunningServer running(service);
    httplib::Client client("127.0.0.1", running.port); client.set_read_timeout(10);
    const httplib::Headers management{{"x-service-token", std::string(48, 'm')}};
    const auto post = [&](const char* path, const Json& body, int status=200) {
      return Expect(client.Post(path, auth, body.dump(), "application/json"), status);
    };
    const auto at = Now() - 2000;
    Json scope{{"channel_ids", {channel}}, {"from_ms", at - 1}, {"to_ms", at + 1000}};
    const auto put = [&](int id, const std::string& model, size_t padding=0) {
      Sample sample; sample.record = {Id(id), channel, "fixture-processor", "fixture-session", std::to_string(id), model, at + id % 1000, false, {1,0}};
      sample.expires_ms = Now() + 60000; sample.evidence = SampleJson(at).at("evidence");
      if (padding) sample.evidence["padding"] = std::string(padding, 'x');
      sample.jpeg = {0xff,0xd8,0xff,0xd9}; history.Put(sample);
      return history.Get(sample.record.id, false).value();
    };
    const auto update = [&](int id, const Json& values) {
      bson_error_t error{}; const auto filter_text=Json{{"_id",Id(id)}}.dump(); const auto text=Json{{"$set",values}}.dump();
      auto filter=bson_new_from_json(reinterpret_cast<const uint8_t*>(filter_text.data()),-1,&error);
      auto change=bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()),-1,&error);
      Check(filter&&change,"metadata BSON fixture");
      const bool ok=mongoc_collection_update_one(collection,filter,change,nullptr,nullptr,&error);
      bson_destroy(filter);bson_destroy(change);Check(ok,"metadata update fixture");
    };
    Check(history.ModelSpaceCompatible("new-model"),"empty history bootstrap");
    auto sample=put(101,"old-model");
    Check(history.ModelSpaceCompatible("old-model")&&!history.ModelSpaceCompatible("new-model"),"actual foreign history space ignored");
    const Json watermark{{"source_model","old-model"},{"scope",scope}};
    Expect(client.Post("/v1/samples/watermark",{},watermark.dump(),"application/json"),401);
    Expect(client.Post("/v1/samples/watermark",producer,watermark.dump(),"application/json"),403);
    Expect(client.Post("/v1/samples/watermark",management,watermark.dump(),"application/json"),403);
    const auto high=post("/v1/samples/watermark",watermark).at("high_watermark");
    Check(high.is_string()&&high!="0","metadata watermark");
    Json scan{{"source_model","old-model"},{"scope",scope},{"after",nullptr},{"through",high},{"limit",32}};
    auto page=post("/v1/samples/scan",scan);
    Check(page.at("exhausted")&&page.at("items").size()==1,"metadata page");
    Check(!page.at("items")[0].contains("vector")&&!page.at("items")[0].contains("jpeg"),"metadata payload disclosure");
    Json image{{"sample_id",Id(101)},{"fingerprint",sample.fingerprint},{"source_model","old-model"},{"scope",scope}};
    auto response=client.Post("/v1/samples/reencode-image",auth,image.dump(),"application/json");
    Check(response&&response->status==200&&response->body.size()==4&&response->get_header_value("Content-Type")=="image/jpeg","metadata image");
    auto wrong=image;wrong["fingerprint"]=std::string(64,'0');post("/v1/samples/reencode-image",wrong,404);
    wrong=image;wrong["source_model"]="wrong-model";post("/v1/samples/reencode-image",wrong,404);
    wrong=image;wrong["scope"]["channel_ids"]={Id(99)};post("/v1/samples/reencode-image",wrong,404);
    wrong=image;wrong["scope"]["from_ms"]=at+500;post("/v1/samples/reencode-image",wrong,404);
    // The old vector can be broken while the original evidence remains valid.
    update(101,{{"vector",Json{{"$binary",{{"base64","AA=="},{"subType","00"}}}}},{"unknown_payload",std::string(200000,'z')}});
    bool rejected=false;try{history.Get(Id(101));}catch(...){rejected=true;}Check(rejected,"corrupt legacy vector admitted");
    Check(client.Post("/v1/samples/reencode-image",auth,image.dump(),"application/json")->status==200,"old vector blocked original image");
    post("/v1/samples/scan",scan);
    for(const auto& invalid:Json::array({"00","-1","+1","1.0","9223372036854775808",1})){
      auto bad=scan;bad["after"]=invalid;post("/v1/samples/scan",bad,400);
    }
    auto bad=scan;bad["through"]="0";bad["after"]="1";post("/v1/samples/scan",bad,400);
    bad=scan;bad["limit"]=33;post("/v1/samples/scan",bad,400);
    bad=scan;bad["scope"]["channel_ids"].push_back(channel);post("/v1/samples/scan",bad,400);
    // The internal metadata budget must split pages, not truncate or claim complete.
    for(int i=200;i<236;++i)put(i,"wide-model",12000);
    auto wide=scan;wide["source_model"]="wide-model";
    auto wide_scope=watermark;wide_scope["source_model"]="wide-model";
    wide["through"]=post("/v1/samples/watermark",wide_scope).at("high_watermark");
    std::set<std::string> ids;int pages=0;
    do{
      auto part=post("/v1/samples/scan",wide);++pages;Check(part.dump().size()<256*1024,"metadata HTTP budget");
      for(const auto& row:part.at("items"))Check(ids.insert(row.at("id").get<std::string>()).second,"metadata page repeated row");
      if(part.at("exhausted"))break;
      Check(!part.at("next_cursor").is_null()&&part.at("next_cursor")!=wide.at("after"),"metadata page stalled");
      wide["after"]=part.at("next_cursor");Check(pages<10,"metadata page unbounded");
    }while(true);
    Check(ids.size()==36&&pages>1,"metadata byte pagination lost records");
    update(101,{{"jpeg",Json{{"$binary",{{"base64","AA=="},{"subType","00"}}}}}});
    post("/v1/samples/reencode-image",image,503);
    // Deletion intent denies reads before asynchronous physical removal.
    history.DeleteRange(channel,at+100,at+102);post("/v1/samples/reencode-image",image,404);
    auto expired=put(302,"expiry-model");update(302,{{"expires_at",Json{{"$date",{{"$numberLong",std::to_string(Now()-1)}}}}}});
    auto expired_image=image;expired_image["sample_id"]=Id(302);expired_image["fingerprint"]=expired.fingerprint;expired_image["source_model"]="expiry-model";
    post("/v1/samples/reencode-image",expired_image,404);
    auto corrupt=put(303,"ordinal-model");(void)corrupt;update(303,{{"ordinal",3.5}});
    auto ordinal_watermark=watermark;ordinal_watermark["source_model"]="ordinal-model";post("/v1/samples/watermark",ordinal_watermark,503);
    // All 1024 authorized sources are accepted by extent, unlike the query cap100.
    Json channels=Json::array();for(int i=0;i<1024;++i)channels.push_back(Id(1000+i));
    Check(post("/v1/samples/extent",{{"source_model","empty-model"},{"channel_ids",channels}}).at("high_watermark")=="0","extent source cap");
    channels.push_back(Id(3000));post("/v1/samples/extent",{{"source_model","empty-model"},{"channel_ids",channels}},400);
    // An interrupted deletion can leave a long hidden prefix; extent must not
    // declare empty when its bounded visibility work has not reached the tail.
    for(int i=400;i<658;++i)put(i,"hidden-model");
    {
      const auto command=Json{{"_id","fixture-hidden"},{"channel",channel},{"from",at+400},{"to",at+657},
        {"expires_at",{{"$date",{{"$numberLong",std::to_string(Now()+60000)}}}}}}.dump();
      bson_error_t error{};auto body=bson_new_from_json(reinterpret_cast<const uint8_t*>(command.data()),-1,&error);
      auto deletions=mongoc_client_get_collection(mongo,database.c_str(),"search_deletions");
      const bool inserted=body&&mongoc_collection_insert_one(deletions,body,nullptr,nullptr,&error);
      mongoc_collection_destroy(deletions);if(body)bson_destroy(body);Check(inserted,"hidden metadata fixture");
    }
    post("/v1/samples/extent",{{"source_model","hidden-model"},{"channel_ids",{channel}}},503);
    // Actual endpoint role and single concurrent verifier are independent of inference.
    const Json verify{{"package_id","fixture-package"}};
    Expect(client.Post("/v1/models/verify",auth,verify.dump(),"application/json"),403);
    Expect(client.Post("/v1/models/verify",producer,verify.dump(),"application/json"),403);
    Expect(client.Post("/v1/models/verify",management,"{\"package_id\":\"unknown\"}","application/json"),400);
    auto task=std::async(std::launch::async,[&]{httplib::Client other("127.0.0.1",running.port);return other.Post("/v1/models/verify",management,verify.dump(),"application/json");});
    {std::unique_lock<std::mutex> lock(profile_mutex);Check(profile_changed.wait_for(lock,2s,[&]{return profile_entered;}),"model verifier did not enter");}
    const auto busy=client.Post("/v1/models/verify",management,verify.dump(),"application/json");
    {std::lock_guard<std::mutex> lock(profile_mutex);profile_release=true;profile_changed.notify_all();}
    Expect(busy,429);Check(busy->get_header_value("Retry-After")=="1","model verifier busy hint");
    Check(Expect(task.get(),200).at("runtime_ready")==false,"metadata verification fabricated inference");
    cleanup();
  } catch(...) {cleanup();throw;}
}
