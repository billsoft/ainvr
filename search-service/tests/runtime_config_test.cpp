#include "runtime_config.hpp"
#include "model_catalog.hpp"
#include "../../llm-service/src/config_center.hpp"
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <thread>
#include <sys/stat.h>
#include <unistd.h>
using namespace ainvr::search;
using Json = nlohmann::json;
void Check(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
template<class F> void Reject(F operation) { bool failed = false; try { operation(); } catch (...) { failed = true; } Check(failed, "invalid boundary accepted"); }
Json Runtime() {
  return {{"desired_version", 7}, {"revision", std::string(64, 'a')},
    {"settings", {{"schema_version", "1.0"}, {"enabled", false}, {"listen", {{"host", "127.0.0.1"}, {"port", 8400}}},
      {"history", {{"source", "ai-history"}}}, {"model", {{"package_id", nullptr}}}, {"sampling", {{"track_slots", 8}}}, {"callers", Json::array()},
      {"limits", {{"http_workers", 4}, {"http_queue", 4}, {"image_max_bytes", 8388608}, {"max_samples", 100000},
        {"max_bytes", 1073741824}, {"retention_days", 30}, {"max_coverage", 100000}, {"max_searches", 1000}, {"search_ttl_s", 3600}}}}},
    {"history_connection", {{"uri", nullptr}, {"database", nullptr}, {"source_version", nullptr}}},
    {"sources", Json::array()}, {"dependency_status", "history_unavailable"}};
}
int main() {
  const auto root = std::filesystem::temp_directory_path() / ("ainvr-search-runtime-test-" + std::to_string(getpid()));
  std::filesystem::create_directory(root);
  httplib::Server server; std::thread listener;
  try {
    const std::string token(48, 'm');
    auto config = ReadEffectiveRuntime(Runtime(), token);
    Check(!config.access.enabled && !config.history_ready && config.access.revision.size() == 64, "disabled config needs resources");
    auto selected = Runtime(); selected["settings"]["model"]["package_id"] = "siglip2-base-full-int8";
    Check(ReadEffectiveRuntime(selected, token).package_id == "siglip2-base-full-int8", "model selection lost");
    const Json pin{{"package_id","siglip2-base-full-int8"},{"package_sha256",std::string(64,'b')},
      {"model_version","search-v1-"+std::string(64,'b')}};
    auto pinned=selected;pinned["active_model_pin"]=pin;
    Check(ReadEffectiveRuntime(pinned,token).active_model_pin->model_version==pin.at("model_version"),"model pin lost");
    auto transition=Json{{"job_id","00000000-0000-4000-8000-000000000001"},{"generation",1},
      {"payload_fingerprint",std::string(64,'c')},{"source",pin},{"target",pin}};
    pinned["approved_model_transition"]=transition;
    Check(ReadEffectiveRuntime(pinned,token).approved_model_transition->generation==1,"approved transition lost");
    for(const auto& key:{"package_sha256","model_version","package_id"}){
      auto invalid=pinned;invalid["active_model_pin"][key]=std::string(key)=="package_id"?"../broken":"broken";
      Reject([&]{ReadEffectiveRuntime(invalid,token);});
    }
    for(const auto& field:{"job_id","payload_fingerprint"}){
      auto invalid=pinned;invalid["approved_model_transition"][field]="broken";Reject([&]{ReadEffectiveRuntime(invalid,token);});
    }
    for(const auto& invalid:Json::array({0,1.5,-1,9007199254740992ULL})){
      auto changed=pinned;changed["approved_model_transition"]["generation"]=invalid;Reject([&]{ReadEffectiveRuntime(changed,token);});
    }
    auto extra=pinned;extra["approved_model_transition"]["payload_fp"]=std::string(64,'d');Reject([&]{ReadEffectiveRuntime(extra,token);});
    pinned["active_model_pin"]=nullptr;pinned["approved_model_transition"]=nullptr;
    Check(!ReadEffectiveRuntime(pinned,token).active_model_pin&&!ReadEffectiveRuntime(pinned,token).approved_model_transition,"null authority needs model");
    for (const auto& invalid : {Json(""), Json("../model"), Json("/tmp/model"), Json(7), Json(true)}) {
      auto invalid_model = Runtime(); invalid_model["settings"]["model"]["package_id"] = invalid;
      Reject([&] { ReadEffectiveRuntime(invalid_model, token); });
    }
    auto bad = Runtime(); bad["revision"] = "draft"; Reject([&] { ReadEffectiveRuntime(bad, token); });
    bad = Runtime(); bad["settings"]["listen"]["host"] = "0.0.0.0"; Reject([&] { ReadEffectiveRuntime(bad, token); });
    bad = Runtime(); bad["settings"]["sampling"]["track_slots"] = 9; Reject([&] { ReadEffectiveRuntime(bad, token); });
    bad = Runtime(); bad["settings"]["limits"]["max_bytes"] = 0; Reject([&] { ReadEffectiveRuntime(bad, token); });
    bad = Runtime(); bad["settings"]["limits"]["max_samples"] = 100.5; Reject([&] { ReadEffectiveRuntime(bad, token); });
    bad = Runtime(); bad["settings"]["callers"] = {{{"name", "console"}, {"scope", "producer"}, {"key", std::string(48, 'p')}}};
    Reject([&] { ReadEffectiveRuntime(bad, token); });
    auto enabled = Runtime(); enabled["settings"]["enabled"] = true;
    Check(ReadEffectiveRuntime(enabled, token).access.unavailable_reason == "storage_unavailable", "missing history falsely ready");
    auto storage = Runtime(); storage["settings"]["enabled"] = true;
    storage["dependency_status"] = nullptr;
    storage["history_connection"] = {{"uri", "mongodb://127.0.0.1:1"}, {"database", "isolated"}, {"source_version", 1}};
    Check(ReadEffectiveRuntime(storage, token).access.unavailable_reason == "storage_unavailable", "missing SSD silently accepted");
    storage["settings"]["index_storage"] = {{"volume_id", "volume-uuid"}, {"relative_path", "ainvr/search-index"}};
    storage["index_directory"] = {{"volume_id", "volume-uuid"}, {"relative_path", "ainvr/search-index"},
      {"resolved_path", "/mnt/external/ainvr/search-index"}, {"ready", true}, {"generation", std::string(64, 'b')}};
    auto authorized = ReadEffectiveRuntime(storage, token);
    Check(authorized.index_storage && authorized.index_storage->volume_id == "volume-uuid" &&
      authorized.access.unavailable_reason.empty(), "SSD identity lost");
    for (const char* field : {"volume_id", "relative_path"}) {
      auto changed = storage; changed["index_directory"][field] = "other";
      Reject([&] { ReadEffectiveRuntime(changed, token); });
    }
    for (const char* field : {"generation", "resolved_path"}) {
      auto changed = storage; changed["index_directory"][field] = "";
      Reject([&] { ReadEffectiveRuntime(changed, token); });
    }
    storage["index_directory"]["ready"] = false;
    Check(!ReadEffectiveRuntime(storage, token).index_storage &&
      ReadEffectiveRuntime(storage, token).access.unavailable_reason == "storage_unavailable", "offline SSD falsely ready");
    auto sourced = Runtime();
    const auto channel = "00000000-0000-4000-8000-100000000001";
    sourced["sources"] = Json::array({{{"channel_id", channel}, {"input_stream_id", "00000000-0000-4000-8000-100000000002"},
      {"processor_id", "chained-processor"}, {"recording_channel_id", channel}, {"object", true}, {"scene", true},
      {"input_path", "/live/intermediate_ai"}, {"output_path", "/analysis/final-ai"}}});
    auto managed_source = ReadEffectiveRuntime(sourced, token);
    Check(managed_source.access.sources.at(channel).input_path == "/live/intermediate_ai" &&
      managed_source.access.sources.at(channel).output_path == "/analysis/final-ai", "actual source paths lost");
    Check(!managed_source.ingestion_gate,"absent gate invented");
    auto gated=sourced;gated["ingestion_gate"]=nullptr;
    Check(!ReadEffectiveRuntime(gated,token).ingestion_gate,"null gate invented");
    gated["settings"]["model"]["package_id"]=pin.at("package_id");gated["active_model_pin"]=pin;
    auto second=sourced["sources"][0];second["channel_id"]="00000000-0000-4000-8000-100000000003";
    second["recording_channel_id"]=second.at("channel_id");
    gated["sources"]=Json::array({second,sourced["sources"][0]});
    // Frozen output of the actual Node searchMigrationSourceIdsDigest helper
    // for these two UUIDs in reverse order, independently of Native hashing.
    const Json gate{{"paused",true},{"plan_id","00000000-0000-4000-8000-000000000010"},
      {"epoch","00000000-0000-4000-8000-000000000011"},{"generation",3},
      {"worker","00000000-0000-4000-8000-000000000012"},{"source",pin},
      {"source_ids_sha256","647fef2ed61a33e578009213b17d48cb60524d918eba97c72234837f222f67bd"},{"expires_ms",1}};
    gated["ingestion_gate"]=gate;
    const auto parsed_gate=ReadEffectiveRuntime(gated,token).ingestion_gate;
    Check(parsed_gate&&parsed_gate->plan_id==gate.at("plan_id")&&parsed_gate->epoch==gate.at("epoch")&&
      parsed_gate->worker==gate.at("worker")&&parsed_gate->generation==3&&parsed_gate->expires_ms==1&&
      RuntimeModelPinJson(parsed_gate->source)==pin&&parsed_gate->source_ids_sha256==gate.at("source_ids_sha256"),
      "expired gate or exact Node source digest lost");
    std::reverse(gated["sources"].begin(),gated["sources"].end());
    Check(ReadEffectiveRuntime(gated,token).ingestion_gate.has_value(),"source digest depended on catalog order");
    for(const char* field:{"paused","plan_id","epoch","generation","worker","source","source_ids_sha256","expires_ms"}){
      auto missing=gated;missing["ingestion_gate"].erase(field);Reject([&]{ReadEffectiveRuntime(missing,token);});
      auto wrong_type=gated;wrong_type["ingestion_gate"][field]=Json::array();Reject([&]{ReadEffectiveRuntime(wrong_type,token);});
    }
    for(const auto& malformed:Json::array({false,1,"paused",Json::array()})){
      auto changed=gated;changed["ingestion_gate"]=malformed;Reject([&]{ReadEffectiveRuntime(changed,token);});
    }
    auto changed_gate=gated;changed_gate["ingestion_gate"]["extra"]=true;Reject([&]{ReadEffectiveRuntime(changed_gate,token);});
    changed_gate=gated;changed_gate["ingestion_gate"]["paused"]=false;Reject([&]{ReadEffectiveRuntime(changed_gate,token);});
    for(const char* field:{"plan_id","epoch","worker","source_ids_sha256"}){
      auto changed=gated;changed["ingestion_gate"][field]="broken";Reject([&]{ReadEffectiveRuntime(changed,token);});
    }
    for(const auto& invalid:Json::array({0,-1,1.5,9007199254740992ULL,true,"3"})){
      auto changed=gated;changed["ingestion_gate"]["generation"]=invalid;Reject([&]{ReadEffectiveRuntime(changed,token);});
    }
    for(const auto& invalid:Json::array({-1,1.5,9007199254740992ULL,true,"1"})){
      auto changed=gated;changed["ingestion_gate"]["expires_ms"]=invalid;Reject([&]{ReadEffectiveRuntime(changed,token);});
    }
    changed_gate=gated;changed_gate["ingestion_gate"]["expires_ms"]=0;
    Check(ReadEffectiveRuntime(changed_gate,token).ingestion_gate->expires_ms==0,"expired epoch-zero gate removed");
    changed_gate=gated;changed_gate["ingestion_gate"]["generation"]=9007199254740991LL;
    changed_gate["ingestion_gate"]["expires_ms"]=9007199254740991LL;
    Check(ReadEffectiveRuntime(changed_gate,token).ingestion_gate->generation==9007199254740991LL,"valid Node safe-integer bound rejected");
    changed_gate=gated;changed_gate["ingestion_gate"]["source_ids_sha256"]=std::string(64,'A');Reject([&]{ReadEffectiveRuntime(changed_gate,token);});
    changed_gate=gated;changed_gate["ingestion_gate"]["source_ids_sha256"]=std::string(64,'a');Reject([&]{ReadEffectiveRuntime(changed_gate,token);});
    changed_gate=gated;changed_gate["sources"].erase(changed_gate["sources"].begin());Reject([&]{ReadEffectiveRuntime(changed_gate,token);});
    changed_gate=gated;changed_gate["sources"]=Json::array();Reject([&]{ReadEffectiveRuntime(changed_gate,token);});
    for(const auto& active:Json::array({nullptr,Json{{"package_id","another-model"},{"package_sha256",std::string(64,'c')},
      {"model_version","search-v1-"+std::string(64,'c')}}})){
      auto changed=gated;changed["active_model_pin"]=active;Reject([&]{ReadEffectiveRuntime(changed,token);});
    }
    changed_gate=gated;changed_gate.erase("active_model_pin");Reject([&]{ReadEffectiveRuntime(changed_gate,token);});
    changed_gate=gated;changed_gate["ingestion_gate"]["source"]["model_version"]="search-v1-"+std::string(64,'c');
    Reject([&]{ReadEffectiveRuntime(changed_gate,token);});
    changed_gate=gated;changed_gate["ingestion_gate"]["source"]["extra"]=true;Reject([&]{ReadEffectiveRuntime(changed_gate,token);});
    const Json target{{"package_id","target-model"},{"package_sha256",std::string(64,'c')},
      {"model_version","search-v1-"+std::string(64,'c')}};
    changed_gate=gated;changed_gate["ingestion_gate"]["source"]=target;Reject([&]{ReadEffectiveRuntime(changed_gate,token);});
    auto switching=gated;switching["settings"]["model"]["package_id"]=target.at("package_id");
    Reject([&]{ReadEffectiveRuntime(switching,token);});
    switching["approved_model_transition"]={{"job_id",gate.at("plan_id")},{"generation",gate.at("generation")},
      {"payload_fingerprint",std::string(64,'d')},{"source",pin},{"target",target}};
    Check(ReadEffectiveRuntime(switching,token).ingestion_gate.has_value(),"published target desired lost source gate before Ready ACK");
    for(const char* field:{"job_id","generation","source","target"}){
      auto changed=switching;
      if(std::string(field)=="job_id")changed["approved_model_transition"][field]=gate.at("worker");
      else if(std::string(field)=="generation")changed["approved_model_transition"][field]=4;
      else changed["approved_model_transition"][field]=std::string(field)=="source"?target:pin;
      Reject([&]{ReadEffectiveRuntime(changed,token);});
    }
    changed_gate=switching;changed_gate["active_model_pin"]=target;Reject([&]{ReadEffectiveRuntime(changed_gate,token);});
    switching["active_model_pin"]=target;switching["approved_model_transition"]=nullptr;switching["ingestion_gate"]=nullptr;
    Check(!ReadEffectiveRuntime(switching,token).ingestion_gate,"target Ready ACK did not clear null gate");
    for (const char* field : {"input_path", "output_path"}) {
      auto missing = sourced; missing["sources"][0].erase(field);
      Reject([&] { ReadEffectiveRuntime(missing, token); });
      for (const std::string& path : {std::string(""), std::string("rtmp://user:password@localhost/live/raw"),
           std::string("/live/raw?token=private"), std::string("/live/raw#fragment"), std::string("/live/../raw"),
           std::string("/live/raw\n"), std::string("/live/") + std::string(129, 'a'), std::string("/live/raw\\extra")}) {
        auto invalid_path = sourced; invalid_path["sources"][0][field] = path;
        Reject([&] { ReadEffectiveRuntime(invalid_path, token); });
      }
    }
    sourced["sources"][0]["input_path"] = "/" + std::string(128, 'a') + "/" + std::string(128, 'b');
    Check(ReadEffectiveRuntime(sourced, token).access.sources.size() == 1, "valid bounded SRS path rejected");
    // Real local HTTP transport: body size, response envelope and authentication.
    server.Get("/api/v1/config/fixture", [&](const auto& req, auto& res) {
      Check(req.get_header_value("x-service-token") == token, "missing management auth");
      res.set_content(Json{{"code", 0}, {"data", {{"version", 7}}}}.dump(), "application/json");
    });
    std::atomic<bool> first_pin_ack{false};
    server.Get("/api/internal/search/runtime-config", [&](const auto&, auto& res) {
      auto document=Runtime();
      if(first_pin_ack.load()){document["active_model_pin"]=pin;document["revision"]=std::string(64,'b');}
      res.set_content(document.dump(), "application/json");
    });
    server.Post("/api/internal/search/runtime-state", [&](const auto& req, auto& res) {
      const auto body=Json::parse(req.body);
      Check(body.at("revision") == std::string(64,first_pin_ack.load()?'b':'a'), "ACK revision changed");
      if(body.contains("active_model")){Check(ReadRuntimeModelPin(body.at("active_model"))==ReadRuntimeModelPin(pin),"ACK model drift");first_pin_ack.store(true);}
      res.set_content("{}", "application/json");
    });
    server.Get("/api/huge", [](const auto&, auto& res) { res.set_content(std::string(1024 * 1024 + 1, 'x'), "application/json"); });
    server.Get("/api/redirect", [](const auto&, auto& res) { res.set_redirect("http://192.0.2.1/credentials", 302); });
    const int port = server.bind_to_any_port("127.0.0.1"); Check(port > 0, "test bind failed");
    listener = std::thread([&] { server.listen_after_bind(); });
    for (int n = 0; n < 200 && !server.is_running(); ++n) std::this_thread::sleep_for(std::chrono::milliseconds(5));
    Check(server.is_running(), "test listener unavailable");
    const Json bootstrap{{"control_url", "http://127.0.0.1:" + std::to_string(port)}, {"service_token", token}};
    ainvr::config::ConfigTransport transport(bootstrap);
    Check(transport.Request("fixture").at("version") == 7, "shared envelope regression");
    Check(transport.RequestAt("/api/internal/search/runtime-config").at("desired_version") == 7, "effective runtime envelope");
    Json ack{{"revision", std::string(64, 'a')}}; transport.RequestAt("/api/internal/search/runtime-state", &ack);
    const auto before_pin=ReadEffectiveRuntime(transport.RequestAt("/api/internal/search/runtime-config"),token);
    ack["active_model"]=pin;transport.RequestAt("/api/internal/search/runtime-state",&ack);
    const auto after_pin=ReadEffectiveRuntime(transport.RequestAt("/api/internal/search/runtime-config"),token);
    Check(after_pin.revision!=before_pin.revision&&after_pin.active_model_pin.has_value(),"first pin did not revoke old revision");
    ack["revision"]=after_pin.revision;transport.RequestAt("/api/internal/search/runtime-state",&ack);
    Check(ReadEffectiveRuntime(transport.RequestAt("/api/internal/search/runtime-config"),token).revision==after_pin.revision,"second ACK not stable");
    Reject([&] { transport.RequestAt("/api/huge"); });
    Reject([&] { transport.RequestAt("/api/redirect"); });
    Reject([&] { transport.RequestAt("http://192.0.2.1/api/"); });
    auto wrong_bootstrap = bootstrap; wrong_bootstrap["control_url"] = "http://192.0.2.1:8000";
    Reject([&] { ainvr::config::ConfigTransport denied(wrong_bootstrap); });
    auto path = root / "private.json";
    { std::ofstream out(path); out << bootstrap.dump(); } chmod(path.c_str(), 0600);
    Check(ainvr::config::ReadPrivateJson(path.string()) == bootstrap, "private bootstrap read");
    chmod(path.c_str(), 0644); Reject([&] { ainvr::config::ReadPrivateJson(path.string()); });
    chmod(path.c_str(), 0600); std::filesystem::create_symlink(path, root / "link");
    Reject([&] { ainvr::config::ReadPrivateJson((root / "link").string()); });
    { std::ofstream out(path); out << std::string(65537, 'x'); }
    Reject([&] { ainvr::config::ReadPrivateJson(path.string()); });
    Check(ModelCatalog(root.string()).at("items").empty(), "missing package fabricated");
    // LLM continues to use the same normalization and the shared transport alias.
    Json llm{{"listen", {{"host", "127.0.0.1"}, {"port", 8300}}}, {"model", {{"package_id", "qwen3vl-4b-review-v3"}, {"load_policy", "resident"}}},
      {"admin_key", std::string(48, 'a')}, {"enabled", false}, {"api_keys", {{{"name", "alarm"}, {"scope", "inference"}, {"key", std::string(48, 'b')}}}},
      {"scheduling", {{"prefill_profile", "s256"}, {"queue_size", 2}, {"queue_timeout_s", 30}, {"exec_timeout_s", 30}, {"submit_time_share_cap_percent", 50}}},
      {"tasks", {{"alarm-review-zh-v1", {{"calibration_temperature", 1.0}, {"aspect_policy", "reject"}}}}}};
    Check(ainvr::llm::NormalizeSettings(llm, 3).at("config_version") == 3, "LLM normalization changed");
    server.stop(); listener.join(); std::filesystem::remove_all(root);
    std::cout << "runtime: private bootstrap, shared config transport, bounded responses, dependency identity, disabled ACK boundary passed\n";
  } catch (const std::exception& error) {
    server.stop(); if (listener.joinable()) listener.join(); std::filesystem::remove_all(root);
    std::cerr << error.what() << '\n'; return 1;
  }
}
