#include "history_mongo.hpp"
#include <mongoc/mongoc.h>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <functional>
#include <iostream>
#include <thread>
using namespace ainvr::search;
using Json = nlohmann::json;
int64_t Now() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
void Check(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
void Reject(const std::function<void()>& call) { bool rejected = false; try { call(); } catch (...) { rejected = true; } Check(rejected, "expected rejection"); }
std::string Id(int n) { return "00000000-0000-4000-8000-" + std::to_string(100000000000LL + n); }
const auto channel = Id(1);
Sample Make(int n, int64_t at) {
  return {{Id(n), channel, "processor", "session", "track" + std::to_string(n), "pair-v1", at, false, {1, 0}},
    {{"role", "match"}, {"source_input_id", channel}, {"output_channel_id", channel}, {"recording_channel_id", channel},
     {"schema_version", "1.0"}, {"stream_session_id", "session"}, {"source_pts_ns", std::to_string(at * 1000000LL)},
     {"source_frame_index", std::to_string(n)}, {"frame_id", Id(n)}, {"frame_width", 1920}, {"frame_height", 1080}},
    {255, 216, 255, 217}, at + 60000};
}
void Command(mongoc_client_t* client, const std::string& db, const nlohmann::ordered_json& command) {
  const auto text = command.dump(); bson_error_t error{}; bson_t reply;
  bson_t* input = bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()), text.size(), &error);
  Check(input != nullptr, "invalid fixture command");
  bool ok = mongoc_client_command_simple(client, db.c_str(), input, nullptr, &reply, &error);
  bson_destroy(input); bson_destroy(&reply); Check(ok, "fixture command failed");
}
Json StoredShortlist(mongoc_client_t* client,const std::string& database,const std::string& version){
  auto* collection=mongoc_client_get_collection(client,database.c_str(),"search_sessions");bson_t filter=BSON_INITIALIZER;
  BSON_APPEND_UTF8(&filter,"version",version.c_str());auto* cursor=mongoc_collection_find_with_opts(collection,&filter,nullptr,nullptr);
  const bson_t* doc=nullptr;Check(mongoc_cursor_next(cursor,&doc),"stored shortlist missing");
  char* text=bson_as_relaxed_extended_json(doc,nullptr);const auto row=Json::parse(text);bson_free(text);
  mongoc_cursor_destroy(cursor);bson_destroy(&filter);mongoc_collection_destroy(collection);return row.at("shortlist");
}
int main() {
  if (!std::getenv("AINVR_SEARCH_TEST_MONGO")) { std::cout << "SKIP: isolated Mongo fixture not requested\n"; return 77; }
  const std::string uri = "mongodb://127.0.0.1:25440/?serverSelectionTimeoutMS=2000";
  const auto database = "ainvr_search_session_test_" + std::to_string(Now());
  mongoc_init();
  std::unique_ptr<mongoc_client_t, decltype(&mongoc_client_destroy)> client(mongoc_client_new(uri.c_str()), mongoc_client_destroy);
  const auto cleanup = [&] { for (const auto& db : {database, database + "_quota"}) Command(client.get(), db, {{"dropDatabase", 1}}); };
  try {
    const auto at = Now() - 1000;
    auto history = std::make_unique<HistoryMongo>(uri, database); history->Initialize();
    for (int n = 10; n < 16; ++n) history->Put(Make(n, at + n));
    SearchSessionRequest request{Id(40), "operator", "背黑色双肩包的人", "pair-v1", {{channel}, at, at + 100, 60}, true, Now() + 3600000};
    auto threshold = request; threshold.id = Id(400); threshold.min_similarity = 0.8;
    const auto threshold_version = history->BeginSearch(threshold);
    auto changed_threshold = threshold; changed_threshold.min_similarity = 0.7;
    Reject([&] { history->BeginSearch(changed_threshold); });
    Reject([&] { history->PublishSearch(threshold.id, threshold.actor, threshold_version, {{Id(10), 0.79}}, "sampled"); });
    history->PublishSearch(threshold.id, threshold.actor, threshold_version, {{Id(10), 0.8}}, "sampled");
    auto reopened = std::make_unique<HistoryMongo>(uri, database);
    auto threshold_page = reopened->ReadSearch(threshold.id, threshold.actor);
    Check(threshold_page && threshold_page->request.min_similarity == 0.8 && threshold_page->items.size() == 1, "minimum lost after reopen");
    const auto version = history->BeginSearch(request);
    Check(history->BeginSearch(request) == version, "duplicate query changed generation");
    auto changed = request; changed.query = "different"; Reject([&] { history->BeginSearch(changed); });
    auto pending = history->ReadSearch(request.id, request.actor);
    Check(pending && !pending->published && pending->items.empty(), "pending snapshot falsely published");
    Check(!history->ReadSearch(request.id, "other-operator"), "owner boundary failed");
    Reject([&] { history->PublishSearch(request.id, request.actor, std::string(64, '0'), {}, "unknown"); });
    Reject([&] { history->PublishSearch(request.id, request.actor, version, {{Id(10), 0.9}, {Id(10), 0.8}}, "sampled"); });
    auto outside = Make(20, at + 200); history->Put(outside);
    Reject([&] { history->PublishSearch(request.id, request.actor, version, {{Id(20), 0.9}}, "sampled"); });
    std::vector<SearchSessionCandidate> order{{Id(15), .99}, {Id(10), .95}, {Id(14), .9}, {Id(11), .8}, {Id(13), .7}, {Id(12), .6}};
    Check(history->PublishSearch(request.id, request.actor, version, order, "sampled"), "shortlist not published");
    std::reverse(order.begin(), order.end());
    Check(!history->PublishSearch(request.id, request.actor, version, order, "partial"), "published order overwritten");
    auto first = history->ReadSearch(request.id, request.actor, 0, 2);
    Check(first && first->published && first->items.size() == 2 && first->next_offset == 2 && first->items[0].sample.record.id == Id(15), "first page unstable");
    Check(history->SearchFeedback(request.id, request.actor, Id(15), false), "feedback not stored");
    Check(!history->SearchFeedback(request.id, "other-operator", Id(15), true), "feedback owner bypass");
    Check(!history->SearchFeedback(request.id, request.actor, Id(20), true), "feedback result bypass");
    history.reset(); history = std::make_unique<HistoryMongo>(uri, database); history->Initialize();
    auto restored = history->ReadSearch(request.id, request.actor, 0, 2);
    Check(restored && restored->items[0].relevant == false && restored->items[0].sample.jpeg.empty(), "snapshot/feedback not durable or copied images");
    Check(bool(history->SearchImage(request.id, request.actor, Id(15), Id(15))), "owned snapshot image missing");
    Check(!history->SearchImage(request.id, request.actor, Id(15), Id(14)), "wrong frame image leaked");
    // Remove the first page's first slot. The following page must still start
    // at original ordinal 2, rather than skipping or duplicating a live result.
    history->DeleteRange(channel, at + 15, at + 16);
    first = history->ReadSearch(request.id, request.actor, 0, 2);
    Check(first && first->coverage == "partial" && first->items.size() == 1 && first->next_offset == 2, "deleted evidence changed page offset");
    auto second = history->ReadSearch(request.id, request.actor, 2, 2);
    Check(second && second->coverage == "partial" && second->items[0].sample.record.id == Id(14) && second->next_offset == 4, "second page shifted or coverage overstated");
    history->CancelSearch(request.id, request.actor); history->CancelSearch(request.id, request.actor);
    Check(!history->ReadSearch(request.id, request.actor), "cancelled snapshot visible");
    Reject([&] { history->PublishSearch(request.id, request.actor, version, order, "sampled"); });
    history->CancelSearch(Id(50), request.actor);
    changed = request; changed.id = Id(50); Reject([&] { history->BeginSearch(changed); });
    changed = request; changed.id = Id(60); changed.actor = "another";
    const auto old_version = history->BeginSearch(changed);
    Command(client.get(), database, {{"update", "search_sessions"}, {"updates", Json::array({
      {{"q", {{"version", old_version}}}, {"u", {{"$set", {{"expires_at", {{"$date", {{"$numberLong", std::to_string(Now() - 1)}}}}}}}}}}
    })}});
    Check(!history->ReadSearch(changed.id, changed.actor), "expired session visible");
    const auto new_version = history->BeginSearch(changed); Check(new_version != old_version, "expired generation reused");
    Reject([&] { history->PublishSearch(changed.id, changed.actor, old_version, {}, "unknown"); });
    changed = request; changed.id = Id(90); const auto missing_version = history->BeginSearch(changed);
    history->PublishSearch(changed.id, changed.actor, missing_version, {{Id(91), .9}}, "sampled");
    history->Put(Make(91, at + 20));
    auto missing = history->ReadSearch(changed.id, changed.actor);
    Check(missing && missing->items.empty() && missing->coverage == "partial", "new record appeared in an old missing slot");
    Check(!history->SearchFeedback(changed.id, changed.actor, Id(91), true), "missing slot accepted feedback for new record");
    history->Put(Make(93, at + 30)); changed.id = Id(92); const auto reused_version = history->BeginSearch(changed);
    history->PublishSearch(changed.id, changed.actor, reused_version, {{Id(93), .9}}, "sampled");
    Command(client.get(), database, {{"delete", "search_samples"}, {"deletes", Json::array({{{"q", {{"_id", Id(93)}}}, {"limit", 1}}})}});
    auto replacement = Make(93, at + 30); replacement.jpeg = {255, 216, 0, 255, 217}; history->Put(replacement);
    auto reused = history->ReadSearch(changed.id, changed.actor);
    Check(reused && reused->items.empty() && reused->coverage == "partial", "reused ID changed an old snapshot image");
    Check(!history->SearchFeedback(changed.id, changed.actor, Id(93), true), "reused reference accepted old feedback");
    Check(!history->SearchImage(changed.id, changed.actor, Id(93), Id(93)), "reused ID image leaked from old snapshot");
    // One existing grouped hit freezes main/earliest/latest evidence only.
    auto early=Make(201,at+200),main=Make(202,at+300),late=Make(203,at+400);
    early.record.track=main.record.track=late.record.track="evidence-group";
    const auto early_fp=history->ReplaceTrackSlot(early,0,"","early-first");history->Put(main);history->Put(late);
    const auto main_fp=history->Get(Id(202),false)->fingerprint,late_fp=history->Get(Id(203),false)->fingerprint;
    changed=request;changed.id=Id(300);changed.scope.to_ms=at+1000;const auto multi_version=history->BeginSearch(changed);
    Check(history->PublishSearch(changed.id,changed.actor,multi_version,{{Id(202),.9,main_fp,{{Id(202),main_fp},{Id(201),early_fp},{Id(203),late_fp}}}},"sampled"),"multiframe publication");
    const auto multi=history->ReadSearch(changed.id,changed.actor);
    Check(multi&&multi->items.size()==1&&multi->items[0].frames.size()==3,"multiframe evidence missing");
    Check(multi->items[0].started_ms==at+200&&multi->items[0].ended_ms==at+400,"frozen evidence range");
    Check(multi->items[0].frames[0].at("role")=="match"&&multi->items[0].frames[1].at("role")=="before"&&multi->items[0].frames[2].at("role")=="after","frame roles");
    Check(bool(history->SearchImage(changed.id,changed.actor,Id(202),Id(201))),"owned related image denied");
    Check(!history->SearchImage(changed.id,"not-owner",Id(202),Id(201)),"related image crossed actor");
    Check(!history->SearchImage(changed.id,changed.actor,Id(202),Id(10)),"unfrozen image crossed target");
    auto cross=Make(204,at+500);cross.record.track="evidence-group";cross.evidence["recording_channel_id"]=Id(999);history->Put(cross);
    auto bad_request=changed;bad_request.id=Id(301);const auto bad_version=history->BeginSearch(bad_request);
    Reject([&]{history->PublishSearch(bad_request.id,bad_request.actor,bad_version,{{Id(202),.9,main_fp,{{Id(202),main_fp},{Id(204),history->Get(Id(204),false)->fingerprint}}}},"sampled");});
    bad_request.id=Id(302);const auto too_many_version=history->BeginSearch(bad_request);
    Reject([&]{history->PublishSearch(bad_request.id,bad_request.actor,too_many_version,{{Id(202),.9,main_fp,{{Id(202),main_fp},{Id(201),early_fp},{Id(203),late_fp},{Id(204),main_fp}}}},"sampled");});
    bad_request.id=Id(304);const auto wrong_main_version=history->BeginSearch(bad_request);
    Reject([&]{history->PublishSearch(bad_request.id,bad_request.actor,wrong_main_version,{{Id(202),.9,main_fp,{{Id(202),std::string(64,'e')}}}},"sampled");});
    auto newer_early=early;newer_early.record.captured_ms+=1;newer_early.evidence["frame_id"]=Id(211);
    newer_early.evidence["source_pts_ns"]=std::to_string(newer_early.record.captured_ms*1000000LL);newer_early.evidence["source_frame_index"]="211";
    history->ReplaceTrackSlot(newer_early,0,early_fp,"early-replaced");
    const auto reduced=history->ReadSearch(changed.id,changed.actor);
    Check(reduced&&reduced->coverage=="partial"&&reduced->items[0].frames.size()==2&&reduced->items[0].started_ms==at+200,"replaced related frame altered frozen range");
    Check(!history->SearchImage(changed.id,changed.actor,Id(202),Id(201))&&!history->SearchImage(changed.id,changed.actor,Id(202),Id(211)),"related slot replacement leaked new pixels");
    Check(history->ReadSearch(changed.id,changed.actor,1,20)->coverage=="partial","another page hid related evidence loss");
    history->DeleteRange(main.record.channel,at+300,at+301);
    Check(history->ReadSearch(changed.id,changed.actor)->items.empty(),"related evidence revived a deleted main candidate");
    Check(!history->SearchImage(changed.id,changed.actor,Id(202),Id(203)),"deleted main still authorized related image");
    auto scene=Make(205,at+600);scene.record.scene=true;scene.record.track="";history->Put(scene);
    auto scene_other=Make(206,at+700);scene_other.record.scene=true;scene_other.record.track="";history->Put(scene_other);
    bad_request.id=Id(303);const auto scene_version=history->BeginSearch(bad_request);const auto scene_fp=history->Get(Id(205),false)->fingerprint;
    Reject([&]{history->PublishSearch(bad_request.id,bad_request.actor,scene_version,{{Id(205),.8,scene_fp,{{Id(205),scene_fp},{Id(206),history->Get(Id(206),false)->fingerprint}}}},"sampled");});
    Check(history->PublishSearch(bad_request.id,bad_request.actor,scene_version,{{Id(205),.8,scene_fp,{{Id(205),scene_fp}}}},"sampled"),"scene singleton");
    Check(history->ReadSearch(bad_request.id,bad_request.actor)->items[0].frames.size()==1,"scene merged unrelated evidence");
    // Exercise the largest admitted wire shape: 60 distinct groups, three
    // frozen UUID/SHA256 refs each. Never truncate a slot or evidence reference.
    auto boundary=changed;boundary.id=Id(350);const auto boundary_version=history->BeginSearch(boundary);
    std::vector<SearchSessionCandidate> boundary_hits;
    for(int group=0;group<60;++group){
      std::vector<SearchSessionEvidenceRef> refs;
      for(int frame=0;frame<3;++frame){auto value=Make(1000+group*3+frame,at+100+frame);value.record.track="boundary-group-"+std::to_string(group);
        history->Put(value);refs.push_back({value.record.id,history->Get(value.record.id,false)->fingerprint});}
      boundary_hits.push_back({refs[1].sample_id,.12345678901234567,refs[1].fingerprint,{refs[1],refs[0],refs[2]}});
    }
    Check(history->PublishSearch(boundary.id,boundary.actor,boundary_version,boundary_hits,"sampled"),"60x3 publication rejected");
    const auto boundary_page=history->ReadSearch(boundary.id,boundary.actor,0,60);
    Check(boundary_page&&boundary_page->items.size()==60,"60x3 silently truncated candidates");
    for(const auto& item:boundary_page->items)Check(item.frames.size()==3,"60x3 silently truncated evidence");
    auto stored=StoredShortlist(client.get(),database,boundary_version);const auto stored_bytes=stored.dump().size();
    Check(stored_bytes>16384&&stored_bytes<=65536,"60x3 shortlist byte bound incorrect");
    std::cout<<"60x3 frozen shortlist bytes="<<stored_bytes<<" (limit65536)\n";
    auto excess_request=boundary;excess_request.id=Id(351);const auto excess_version=history->BeginSearch(excess_request);
    auto excess_hits=boundary_hits;excess_hits.push_back(boundary_hits.front());
    Reject([&]{history->PublishSearch(excess_request.id,excess_request.actor,excess_version,excess_hits,"sampled");});
    Check(!history->ReadSearch(excess_request.id,excess_request.actor)->published,"over-capacity publication partially committed");
    stored["untrusted_padding"]=std::string(65536,'x');const auto oversized=stored.dump();
    const auto oversized_sha=SampleSha256(reinterpret_cast<const uint8_t*>(oversized.data()),oversized.size());
    Command(client.get(),database,{{"update","search_sessions"},{"updates",Json::array({{{"q",{{"version",boundary_version}}},{"u",{{"$set",{{"shortlist",stored},{"shortlist_sha",oversized_sha}}}}}}})}});
    Reject([&]{history->ReadSearch(boundary.id,boundary.actor);});
    // Concurrent reopen is idempotent and cannot create more than one snapshot.
    changed = request; changed.id = Id(60); changed.actor = "another";
    std::atomic<bool> failed{false}; std::vector<std::thread> calls;
    for (int n = 0; n < 4; ++n) calls.emplace_back([&] { try { if (history->BeginSearch(changed) != new_version) failed = true; } catch (...) { failed = true; } });
    for (auto& call : calls) call.join();
    Check(!failed, "concurrent session admission");
    HistoryBudget budget; budget.max_searches = 1;
    HistoryMongo limited(uri, database + "_quota", budget); limited.Initialize(); limited.BeginSearch(request);
    changed = request; changed.id = Id(70); Reject([&] { limited.BeginSearch(changed); });
    Reject([&] { limited.CancelSearch(Id(80), request.actor); });
    Check(limited.BeginSearch(request).size() == 64, "idempotency failed at quota");
    cleanup(); std::cout << "search session: immutable order, durable feedback, ownership, cancellation, expiry, stale generation and bounds passed\n";
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; try { cleanup(); } catch (...) {} return 1; }
}
