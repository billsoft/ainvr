#include "http_service.hpp"
#include "migration_coverage.hpp"
#include "migration_sample.hpp"
#include "model_migration_authorization.hpp"
#include <openssl/crypto.h>
#include <regex>
#include <set>
#include <chrono>
#include <charconv>

namespace ainvr::search {
namespace {
using Json = nlohmann::json;
constexpr size_t kMetadataBytes = 256 * 1024;
void Keys(const Json& value, std::initializer_list<const char*> names) {
  if (!value.is_object() || value.size() != names.size()) throw std::invalid_argument("request_fields");
  for (const auto* name : names) if (!value.contains(name)) throw std::invalid_argument("request_fields");
}
int64_t Integer(const Json& value) {
  if (!value.is_number_integer() || (value.is_number_unsigned() && value.get<uint64_t>() > uint64_t(INT64_MAX)))
    throw std::invalid_argument("request_integer");
  return value.get<int64_t>();
}
std::string Text(const Json& value, size_t maximum = 256, bool query = false) {
  if (!value.is_string()) throw std::invalid_argument("request_text");
  auto text = value.get<std::string>();
  if (text.empty() || text.size() > maximum) throw std::invalid_argument("request_text");
  for (unsigned char c : text) if ((c < 32 && !(query && (c == 9 || c == 10 || c == 13))) || c == 127)
    throw std::invalid_argument("request_text");
  return text;
}
std::string Uuid(const Json& value) {
  auto id = Text(value, 36);
  static const std::regex pattern("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
  if (!std::regex_match(id, pattern)) throw std::invalid_argument("request_identity");
  return id;
}
Json Parse(const std::string& body) {
  if (body.empty() || body.size() > kMetadataBytes) throw std::invalid_argument("request_size");
  return Json::parse(body, [](int depth, Json::parse_event_t, Json&) {
    if (depth > 16) throw std::invalid_argument("request_depth");
    return true;
  });
}
Json Body(const httplib::Request& request) {
  const auto content = request.get_header_value("Content-Type");
  if (content != "application/json" && content != "application/json; charset=utf-8")
    throw std::invalid_argument("request_content_type");
  return Parse(request.body);
}
Scope ReadScope(const Json& value) {
  Keys(value, {"channel_ids", "from_ms", "to_ms", "limit"});
  Scope scope;
  const auto& channels = value.at("channel_ids");
  if (!channels.is_array() || channels.empty() || channels.size() > 100) throw std::invalid_argument("request_channels");
  for (const auto& channel : channels) if (!scope.channels.insert(Uuid(channel)).second) throw std::invalid_argument("request_channels");
  scope.from_ms = Integer(value.at("from_ms")); scope.to_ms = Integer(value.at("to_ms"));
  const auto limit = Integer(value.at("limit"));
  if (scope.from_ms < 0 || scope.to_ms <= scope.from_ms || scope.to_ms - scope.from_ms > 31LL * 86400000 || limit < 1 || limit > 60)
    throw std::invalid_argument("request_scope");
  scope.limit = size_t(limit);
  return scope;
}
Scope ReadMetadataScope(const Json& value) {
  Keys(value,{"channel_ids","from_ms","to_ms"});
  auto normalized=value;normalized["limit"]=60;
  return ReadScope(normalized);
}
int64_t Ordinal(const Json& value) {
  const auto text=Text(value,19);
  if((text.size()>1&&text.front()=='0')||!std::all_of(text.begin(),text.end(),[](char c){return c>='0'&&c<='9';}))
    throw std::invalid_argument("request_ordinal");
  int64_t number=0;const auto parsed=std::from_chars(text.data(),text.data()+text.size(),number);
  if(parsed.ec!=std::errc()||parsed.ptr!=text.data()+text.size())throw std::invalid_argument("request_ordinal");
  return number;
}
Json SampleMetadata(const Sample& sample) {
  const auto& r = sample.record;
  return {{"id", r.id}, {"channel_id", r.channel}, {"processor_id", r.processor},
    {"stream_session_id", r.session}, {"track_id", r.track}, {"model_version", r.model},
    {"captured_ms", r.captured_ms}, {"kind", r.scene ? "scene" : "object"},
    {"evidence", sample.evidence}, {"expires_ms", sample.expires_ms}, {"fingerprint", sample.fingerprint}};
}
Sample ReadSample(const Json& value, const std::string& jpeg, bool with_vector = true) {
  if (with_vector) Keys(value, {"id", "channel_id", "processor_id", "stream_session_id", "track_id", "model_version", "captured_ms", "kind", "evidence", "expires_ms", "vector"});
  else Keys(value, {"id", "channel_id", "processor_id", "stream_session_id", "track_id", "model_version", "captured_ms", "kind", "evidence", "expires_ms"});
  Sample sample; auto& r = sample.record;
  r.id = Uuid(value.at("id")); r.channel = Uuid(value.at("channel_id"));
  r.processor = value.at("processor_id").get<std::string>();
  r.session = Text(value.at("stream_session_id")); r.track = value.at("track_id").get<std::string>();
  r.model = Text(value.at("model_version"), 128); r.captured_ms = Integer(value.at("captured_ms"));
  auto kind = Text(value.at("kind"), 8);
  if (kind != "object" && kind != "scene") throw std::invalid_argument("request_kind");
  r.scene = kind == "scene";
  if (with_vector) {
    const auto& vector = value.at("vector");
    if (!vector.is_array() || vector.empty() || vector.size() > 4096) throw std::invalid_argument("vector_dimensions");
    r.vector = vector.get<std::vector<float>>();
  }
  sample.evidence = value.at("evidence"); sample.expires_ms = Integer(value.at("expires_ms"));
  sample.jpeg.assign(jpeg.begin(), jpeg.end());
  return sample;
}
std::pair<Json, std::string> Upload(const httplib::Request& request, size_t image_max_bytes) {
  if (!request.is_multipart_form_data() || !request.form.fields.empty() || request.form.files.size() != 2 ||
      request.form.get_file_count("metadata") != 1 || request.form.get_file_count("image") != 1)
    throw std::invalid_argument("request_parts");
  const auto metadata = request.form.get_file("metadata"), image = request.form.get_file("image");
  if (metadata.content_type != "application/json" || image.content_type != "image/jpeg" || image.content.size() > image_max_bytes)
    throw std::invalid_argument("request_content_type");
  return {Parse(metadata.content), image.content};
}
void Send(httplib::Response& response, const Json& body, int status = 200) {
  response.status = status; response.set_content(body.dump(), "application/json; charset=utf-8");
}
void Error(httplib::Response& response, const char* code, int status) {
  Send(response, {{"error", code}}, status);
}
Json ReceiptBody(const TrackSlotReceipt& receipt) {
  const char* status = "not_found";
  switch (receipt.state) {
    case TrackSlotReceiptState::Committed: status = "committed"; break;
    case TrackSlotReceiptState::Replaced: status = "replaced"; break;
    case TrackSlotReceiptState::Expired: status = "expired"; break;
    case TrackSlotReceiptState::Deleted: status = "deleted"; break;
    case TrackSlotReceiptState::ScopeMismatch: status = "scope_mismatch"; break;
    case TrackSlotReceiptState::WriteMismatch: status = "write_mismatch"; break;
    case TrackSlotReceiptState::NotFound: break;
  }
  return {{"status", status}, {"fingerprint", receipt.state == TrackSlotReceiptState::Committed ? Json(receipt.fingerprint) : Json(nullptr)}};
}
template<class Function> httplib::Server::Handler Handle(Function fn) {
  return [fn](const httplib::Request& request, httplib::Response& response) {
    try { fn(request, response); }
    catch (const QueryTextError& error) { Error(response, error.Code(), 400); }
    catch (const Json::exception&) { Error(response, "invalid_request", 400); }
    catch (const std::invalid_argument&) { Error(response, "invalid_request", 400); }
    catch (const std::exception& error) {
      const std::string code = error.what();
      if (code == "search_model_pending") Error(response, "model_pending", 503);
      else if (code == "source_ingestion_paused") { response.set_header("Retry-After", "1"); Error(response, "source_ingestion_paused", 503); }
      else if (code == "source_frame_before_resume") Error(response, "source_frame_before_resume", 409);
      else if (code == "search_busy") { response.set_header("Retry-After", "1"); Error(response, "busy", 429); }
      else if (code.rfind("search_slot_", 0) == 0 || code == "search_track_capacity" || code == "search_sample_conflict" || code == "coverage_identity_conflict") Error(response, "identity_conflict", 409);
      else if (code == "search_request_conflict" || code == "search_verification_stale") Error(response, "identity_conflict", 409);
      else if (code == "coverage_range_too_large") Error(response,"coverage_range_too_large",503);
      else if (code == "search_cancelled") Error(response, "search_cancelled", 410);
      else if (code == "search_sessions_capacity") Error(response, "search_capacity", 429);
      else if (code == "search_sample_deleted" || code == "coverage_range_deleted") Error(response, "deleted_evidence", 410);
      else if (code == "search_history_capacity" || code == "coverage_capacity" || code == "deletion_capacity") Error(response, "storage_capacity", 507);
      else Error(response, "service_unavailable", 503); // Never emit driver/URI/credential details.
    }
    catch (...) { Error(response, "service_unavailable", 503); }
  };
}
}  // namespace

MatchEngine::MatchEngine(HistoryMongo& history, TextEncoder& encoder, size_t capacity)
    : model_(encoder.ModelVersion()), dimensions_(encoder.Dimensions()), encoder_(encoder),
      projection_(history, model_, dimensions_, capacity), text_cache_(model_, dimensions_) {
  if (model_.empty() || model_.size() > 128) throw std::invalid_argument("invalid_search_model");
  // Validate dimensions/capacity before the first request arrives.
  VectorIndex validate(model_, dimensions_, capacity);
}
void MatchEngine::Start(const Scope& window) { projection_.Start(window); loaded_.store(true); }
size_t MatchEngine::Warm(const std::vector<Record>& records) { return projection_.Warm(records); }
void MatchEngine::Rebuild(const Scope& window) { projection_.Rebuild(window); loaded_.store(true); }
void MatchEngine::Put(const Sample& sample) { projection_.Put(sample); }
std::string MatchEngine::ReplaceTrackSlot(const Sample& sample, size_t slot, const std::string& expected,
                                         const std::string& token) {
  return projection_.ReplaceTrackSlot(sample, slot, expected, token);
}
Json MatchEngine::Match(const std::string& text, const Scope& scope) {
  std::unique_lock<std::mutex> lock(inference_, std::try_to_lock);
  if (!lock.owns_lock()) throw std::runtime_error("search_busy");
  if (!encoder_.Healthy()) throw std::runtime_error("search_encoding_failed");
  std::vector<float> vector;
  try {
    if (auto cached = text_cache_.Get(text)) vector = std::move(*cached);
    else {
      vector = encoder_.Encode(text);
      if (!encoder_.Healthy()) throw std::runtime_error("search_encoding_failed");
      vector = NormalizeVector(vector, dimensions_);
      text_cache_.PutNormalized(text, vector);
    }
  }
  catch (const QueryTextError&) { throw; }
  catch (...) { throw std::runtime_error("search_encoding_failed"); }
  auto matches = projection_.Query(vector, scope); Json items = Json::array();
  for (const auto& hit : matches.items) {
    auto item = SampleMetadata(hit.sample); item["similarity"] = hit.score;
    item["evidence_refs"]=Json::array();for(const auto& ref:hit.evidence_refs)item["evidence_refs"].push_back({{"sample_id",ref.id},{"fingerprint",ref.fingerprint}});
    items.push_back(std::move(item));
  }
  // The projection cannot certify coverage of unobserved scenes. The BFF
  // combines this limitation with persisted sampling coverage, never counts a
  // successful query alone as complete video coverage.
  return {{"model_version", model_}, {"partial", matches.partial}, {"items", items}};
}
HttpService::HttpService(HistoryMongo* history, HttpAccess access, MatchEngine* engine)
    : history_(history), access_(std::move(access)), engine_(engine) {
  std::set<std::string> keys;
  for (const auto& key : {access_.console_key, access_.producer_key, access_.management_key}) {
    if (key.empty()) continue;
    if (key.size() < 32 || key.size() > 512 || key.find_first_of("\r\n") != std::string::npos || !keys.insert(key).second)
      throw std::invalid_argument("invalid_search_service_token");
  }
  if (access_.workers < 1 || access_.workers > 8 || access_.queue < 1 || access_.queue > 32 ||
      access_.search_ttl_s < 60 || access_.search_ttl_s > 86400 || !access_.model_catalog || !access_.model_verification ||
      !access_.migration_authorization || !access_.admitted ||
      access_.image_max_bytes < 65536 || access_.image_max_bytes > 8 * 1024 * 1024 ||
      !std::regex_match(access_.revision, std::regex("[a-f0-9]{64}")))
    throw std::invalid_argument("invalid_search_transport_config");
  if (access_.enabled && (access_.console_key.empty() || access_.producer_key.empty()))
    throw std::invalid_argument("search_callers_required");
}
std::optional<SourceAdmission::Permit> HttpService::EnterSourceWrite() {
  if(!access_.source_admission)return std::nullopt;
  auto permit=access_.source_admission->TryEnter();
  if(!permit)throw std::runtime_error("source_ingestion_paused");
  return permit;
}
bool HttpService::AllowedSample(const Sample& sample) const {
  const auto source = access_.sources.find(sample.record.channel);
  const auto matches_path = [&](const std::string& expected, const char* name) {
    if (expected.empty()) return true; // Legacy in-process fixture, never a managed production binding.
    if (!sample.evidence.is_object()) return false;
    const auto actual = sample.evidence.find(name);
    return actual != sample.evidence.end() && actual->is_string() && actual->get_ref<const std::string&>() == expected;
  };
  return source != access_.sources.end() && sample.record.model == access_.ingestion_model &&
    (sample.record.scene ? source->second.scene : source->second.object) &&
    (!sample.record.processor.empty() && sample.record.processor == source->second.processor_id) &&
    sample.evidence.at("source_input_id") == source->second.input_stream_id &&
    sample.evidence.at("output_channel_id") == sample.record.channel &&
    sample.evidence.at("recording_channel_id") == source->second.recording_channel_id &&
    matches_path(source->second.input_path, "input_path") && matches_path(source->second.output_path, "output_path");
}
void HttpService::Register(httplib::Server& server) {
  server.new_task_queue = [this] { return new httplib::ThreadPool(access_.workers, 0, access_.queue); };
  server.set_payload_max_length(access_.image_max_bytes + kMetadataBytes + 8192);
  server.set_read_timeout(5); server.set_write_timeout(10); server.set_keep_alive_max_count(4);
  server.set_default_headers({{"Cache-Control", "no-store"}, {"X-Content-Type-Options", "nosniff"}});
  server.set_pre_routing_handler([this](const auto& request, auto& response) {
    // Liveness has no configuration, secrets or database/model dependency.
    if (request.path == "/health" && request.method == "GET") return httplib::Server::HandlerResponse::Unhandled;
    const auto token = request.get_header_value("x-service-token");
    const auto matches = [&](const std::string& expected) {
      return !expected.empty() && token.size() == expected.size() && CRYPTO_memcmp(token.data(), expected.data(), expected.size()) == 0;
    };
    if (request.get_header_value_count("x-service-token") != 1 ||
        (!matches(access_.console_key) && !matches(access_.producer_key) && !matches(access_.management_key))) {
      Error(response, "unauthorized", 401); return httplib::Server::HandlerResponse::Handled;
    }
    const bool producer = (request.method == "POST" && (request.path == "/v1/samples" || request.path == "/v1/samples/receipt" || request.path == "/v1/samples/slot" ||
      request.path == "/v1/samples/slot/receipt")) ||
      (request.method == "PUT" && request.path == "/v1/coverage/range");
    const bool catalog = (request.method == "GET" && (request.path == "/v1/models"||request.path=="/v1/capacity")) ||
      (request.method == "POST" && request.path == "/v1/models/verify");
    const bool migration_capabilities = request.method == "GET" && request.path == "/v1/model-migrations/capabilities";
    const bool migration=request.method=="POST"&&(request.path=="/v1/model-migrations/write-target"||
      request.path=="/v1/model-migrations/target-receipt"||request.path=="/v1/model-migrations/artifacts");
    if ((catalog||migration||migration_capabilities) ? !matches(access_.management_key) : producer ? !matches(access_.producer_key) : !matches(access_.console_key)) {
      Error(response, "forbidden", 403); return httplib::Server::HandlerResponse::Handled;
    }
    if (catalog || migration_capabilities || request.path == "/v1/status") return httplib::Server::HandlerResponse::Unhandled;
    if (!access_.admitted->load()) {
      Error(response, "config_pending", 503); return httplib::Server::HandlerResponse::Handled;
    }
    if (!access_.enabled || !access_.unavailable_reason.empty()) {
      Error(response, access_.enabled ? access_.unavailable_reason.c_str() : "disabled", 503);
      return httplib::Server::HandlerResponse::Handled;
    }
    if (!history_) { Error(response, "storage_unavailable", 503); return httplib::Server::HandlerResponse::Handled; }
    if (producer && access_.ingestion_model.empty()) {
      Error(response, "model_pending", 503); return httplib::Server::HandlerResponse::Handled;
    }
    if (producer && (request.get_header_value_count("x-search-config-revision") != 1 ||
        request.get_header_value("x-search-config-revision") != access_.revision)) {
      Error(response, "stale_configuration", 409); return httplib::Server::HandlerResponse::Handled;
    }
    return httplib::Server::HandlerResponse::Unhandled;
  });
  server.set_exception_handler([](const auto&, auto& response, const auto&) { Error(response, "service_unavailable", 503); });
  server.Get("/health", Handle([](const auto&, auto& response) { Send(response, {{"alive", true}}); }));
  server.Get("/v1/models", Handle([this](const auto&, auto& response) { Send(response, access_.model_catalog()); }));
  server.Get("/v1/capacity",Handle([this](const auto&,auto& response){
    if(!history_)throw std::runtime_error("search_model_pending");
    Send(response,history_->Capacity());
  }));
  // Protocol implementation metadata, independent of configuration admission or
  // model readiness. Advertise the source fence only when its owner is bound.
  server.Get("/v1/model-migrations/capabilities", Handle([this](const auto&, auto& response) {
    Send(response, {{"implemented", true}, {"source_ingestion_gate", bool(access_.source_admission)}, {"target_write", true}, {"artifacts", true}});
  }));
  server.Post("/v1/models/verify",Handle([this](const auto& request,auto& response){
    const auto body=Body(request);Keys(body,{"package_id"});const auto package=Text(body.at("package_id"),128);
    std::unique_lock<std::mutex> lock(model_verification_mutex_,std::try_to_lock);
    if(!lock.owns_lock())throw std::runtime_error("search_busy");
    Send(response,access_.model_verification(package));
  }));
  server.Get("/v1/status", Handle([this](const auto&, auto& response) {
    std::string reason = !access_.admitted->load() ? "config_pending" : access_.enabled ? access_.unavailable_reason : "disabled";
    if (reason.empty()) {
      try { if (!history_) throw std::runtime_error("storage_unavailable"); history_->Ping(); }
      catch (...) { reason = "storage_unavailable"; }
    }
    if (reason.empty() && engine_ && !engine_->Healthy()) reason = "service_unavailable";
    if (reason.empty() && !(engine_ && engine_->Ready())) reason = engine_ ? "config_pending" : "model_pending";
    Send(response, {{"ready", reason.empty()}, {"reason", reason.empty() ? Json(nullptr) : Json(reason)},
      {"model_version", engine_ ? Json(engine_->ModelVersion()) : Json(nullptr)}});
  }));
  server.Post("/v1/match", Handle([this](const auto& request, auto& response) {
    auto body = Body(request); Keys(body, {"query", "scope"});
    auto text = Text(body.at("query"), 1024, true); auto scope = ReadScope(body.at("scope"));
    if (!engine_) throw std::runtime_error("search_model_pending");
    if (!engine_->Ready()) throw std::runtime_error("search_index_not_loaded");
    Send(response, engine_->Match(text, scope));
  }));
  server.Post("/v1/samples", Handle([this](const auto& request, auto& response) {
    const auto source_write=EnterSourceWrite();
    const std::pair<Json, std::string> upload = Upload(request, access_.image_max_bytes);
    const Json& metadata = upload.first; const std::string& image = upload.second;
    auto sample = ReadSample(metadata, image);
    if (!AllowedSample(sample)) { Error(response, "source_not_authorized", 403); return; }
    const auto fingerprint = ComputeSampleContractDigest(sample).fingerprint;
    if (engine_) engine_->Put(sample); else history_->Put(sample);
    Send(response, {{"id", sample.record.id}, {"stored", true}, {"fingerprint", fingerprint}});
  }));
  server.Post("/v1/samples/slot", Handle([this](const auto& request, auto& response) {
    const auto source_write=EnterSourceWrite();
    const std::pair<Json, std::string> upload = Upload(request, access_.image_max_bytes);
    const Json& metadata = upload.first; const std::string& image = upload.second;
    Keys(metadata, {"sample", "slot", "expected_fingerprint", "replacement_token"});
    auto sample = ReadSample(metadata.at("sample"), image);
    if (!AllowedSample(sample)) { Error(response, "source_not_authorized", 403); return; }
    const auto slot = Integer(metadata.at("slot"));
    if (slot < 0 || slot > 7) throw std::invalid_argument("request_slot");
    auto expected = metadata.at("expected_fingerprint").get<std::string>();
    if (!expected.empty() && !std::regex_match(expected, std::regex("[a-f0-9]{64}"))) throw std::invalid_argument("request_generation");
    const auto token = Text(metadata.at("replacement_token"), 128);
    const auto fingerprint = engine_ ? engine_->ReplaceTrackSlot(sample, size_t(slot), expected, token) :
      history_->ReplaceTrackSlot(sample, size_t(slot), expected, token);
    Send(response, {{"id", sample.record.id}, {"stored", true}, {"fingerprint", fingerprint}});
  }));
  server.Post("/v1/samples/slot/receipt", Handle([this](const auto& request, auto& response) {
    if (request.body.size() > 16384) throw std::invalid_argument("request_size");
    const auto body = Body(request); Keys(body, {"sample", "slot", "replacement_token", "request_fingerprint"});
    const auto sample = ReadSample(body.at("sample"), "", false);
    if (sample.record.scene) throw std::invalid_argument("request_slot");
    if (!AllowedSample(sample)) { Error(response, "source_not_authorized", 403); return; }
    const auto slot = Integer(body.at("slot"));
    if (slot < 0 || slot > 7) throw std::invalid_argument("request_slot");
    const auto token = Text(body.at("replacement_token"), 128);
    const auto fingerprint = Text(body.at("request_fingerprint"), 64);
    const auto receipt = history_->ReadTrackSlotReceipt(sample, size_t(slot), token, fingerprint);
    Send(response, ReceiptBody(receipt));
  }));
  server.Post("/v1/samples/receipt", Handle([this](const auto& request, auto& response) {
    if (request.body.size() > 16384) throw std::invalid_argument("request_size");
    const auto body = Body(request); Keys(body, {"sample", "request_fingerprint"});
    const auto sample = ReadSample(body.at("sample"), "", false);
    if (!sample.record.scene) throw std::invalid_argument("request_scene");
    if (!AllowedSample(sample)) { Error(response, "source_not_authorized", 403); return; }
    const auto fingerprint = Text(body.at("request_fingerprint"), 64);
    Send(response, ReceiptBody(history_->ReadSceneReceipt(sample, fingerprint)));
  }));
  server.Get(R"(/v1/samples/([0-9a-fA-F-]{36})(/image)?)", Handle([this](const auto& request, auto& response) {
    if (request.params.size() != 2 || request.get_param_value_count("channel_id") != 1 || request.get_param_value_count("model_version") != 1)
      throw std::invalid_argument("request_scope");
    const auto channel = Uuid(request.get_param_value("channel_id")), model = Text(request.get_param_value("model_version"), 128);
    const bool image = request.matches[2].matched;
    auto sample = history_->Get(request.matches[1].str(), image);
    if (!sample || sample->record.channel != channel || sample->record.model != model) { Error(response, "not_found", 404); return; }
    if (image) response.set_content(reinterpret_cast<const char*>(sample->jpeg.data()), sample->jpeg.size(), "image/jpeg");
    else Send(response, SampleMetadata(*sample));
  }));
  server.Post("/v1/samples/watermark",Handle([this](const auto& request,auto& response){
    const auto body=Body(request);Keys(body,{"source_model","scope"});
    const auto model=Text(body.at("source_model"),128);const auto scope=ReadMetadataScope(body.at("scope"));
    Send(response,{{"source_model",model},{"high_watermark",std::to_string(history_->MetadataWatermark(model,scope))}});
  }));
  server.Post("/v1/samples/extent",Handle([this](const auto& request,auto& response){
    const auto body=Body(request);Keys(body,{"source_model","channel_ids"});
    const auto& ids=body.at("channel_ids");if(!ids.is_array()||ids.empty()||ids.size()>1024)throw std::invalid_argument("request_channels");
    std::set<std::string> channels;for(const auto& id:ids)if(!channels.insert(Uuid(id)).second)throw std::invalid_argument("request_channels");
    Send(response,history_->MetadataExtent(Text(body.at("source_model"),128),channels));
  }));
  server.Post("/v1/samples/scan",Handle([this](const auto& request,auto& response){
    const auto body=Body(request);Keys(body,{"source_model","scope","after","through","limit"});
    const auto model=Text(body.at("source_model"),128);const auto scope=ReadMetadataScope(body.at("scope"));
    const auto after=body.at("after").is_null()?0:Ordinal(body.at("after"));const auto through=Ordinal(body.at("through"));
    const auto limit=Integer(body.at("limit"));if(limit<1||limit>32)throw std::invalid_argument("request_limit");
    const auto page=history_->ScanMetadata(model,scope,after,through,size_t(limit));auto items=Json::array();
    for(const auto& row:page.items){auto metadata=SampleMetadata(row.sample);metadata["ordinal"]=std::to_string(row.ordinal);
      metadata["jpeg_sha256"]=row.jpeg_sha256;items.push_back(std::move(metadata));}
    Send(response,{{"source_model",model},{"through",std::to_string(through)},{"items",items},
      {"next_cursor",page.exhausted?Json(nullptr):Json(std::to_string(page.checkpoint))},{"exhausted",page.exhausted}});
  }));
  server.Post("/v1/samples/reencode-image",Handle([this](const auto& request,auto& response){
    const auto body=Body(request);Keys(body,{"sample_id","fingerprint","source_model","scope"});
    const auto sample=history_->ReencodeImage(Uuid(body.at("sample_id")),Text(body.at("fingerprint"),64),
      Text(body.at("source_model"),128),ReadMetadataScope(body.at("scope")));
    if(!sample){Error(response,"not_found",404);return;}
    response.set_content(reinterpret_cast<const char*>(sample->jpeg.data()),sample->jpeg.size(),"image/jpeg");
  }));
  const auto migration_handler=[this](const auto& request,auto& response,bool receipt){
    std::unique_lock<std::mutex> work(migration_write_mutex_,std::try_to_lock);
    if(!work.owns_lock())throw std::runtime_error("search_busy");
    if(request.body.size()>65536)throw std::invalid_argument("migration_request_too_large");
    const Json body=Body(request);Keys(body,{"job_id","worker","generation","actor","payload_fingerprint","source","target"});
    const auto proof=ReadMigrationWriteProof(body);
    const auto& source=body.at("source");Keys(source,{"sample_id","fingerprint","jpeg_sha256"});
    const auto id=Uuid(source.at("sample_id"));
    const auto fingerprint=migration_authorization::Hash(source.at("fingerprint"));
    const auto jpeg_sha=migration_authorization::Hash(source.at("jpeg_sha256"));
    const auto& target=body.at("target");
    if(receipt)Keys(target,{"package_id","package_sha256","model_version"});
    else Keys(target,{"package_id","package_sha256","model_version","vector"});
    const auto pin=migration_authorization::Pin({{"package_id",target.at("package_id")},
      {"package_sha256",target.at("package_sha256")},{"model_version",target.at("model_version")}});
    const auto& spec=FindPackageSpec(pin.package_id);
    std::vector<float> embedding;
    if(!receipt) {
      const auto& values=target.at("vector");
      if(!values.is_array()||values.size()!=spec.dimensions)throw std::invalid_argument("migration_vector_dimensions");
      embedding.reserve(values.size());
      for(const auto& value:values){if(!value.is_number())throw std::invalid_argument("migration_vector_invalid");embedding.push_back(value.get<float>());}
      (void)NormalizeVector(embedding,spec.dimensions);
    }
    const auto now=[] {return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();};
    const auto authorize=[&](const std::optional<MigrationSourceProof>& actual=std::nullopt){
      const auto query=MigrationAuthorizationRequest(proof,actual);
      try{return ReadMigrationWriteGrant(access_.migration_authorization(query),proof,now());}
      catch(...){throw std::runtime_error("migration_authority_unavailable");}
    };
    const auto first=authorize();
    if(!first){Error(response,"migration_authorization_required",409);return;}
    if(!MatchesRuntimeModelPin(pin,first->target)){Error(response,"migration_target_changed",409);return;}
    const auto absent=[&](const char* state){return Json{{"status",state},{"stored",false},{"sample_id",nullptr},
      {"model_version",pin.model_version},{"fingerprint",nullptr},{"ordinal",nullptr},{"jpeg_sha256",nullptr}};};
    const auto row=history_->ReadReencodeSource(id,fingerprint,first->source.model_version,first->scope,!receipt);
    if(!row){if(receipt)Send(response,absent("source_changed"));else Error(response,"not_found",404);return;}
    if(row->jpeg_sha256!=jpeg_sha||row->ordinal>first->source_high_watermark){Error(response,"migration_source_changed",409);return;}
    std::optional<Sample> sample;
    Json receipt_result=absent("not_found");
    if(!receipt)sample=MakeReencodedSample(row->sample,first->source,first->target,spec,embedding,fingerprint,jpeg_sha,now());
    else {
      const auto target_id=ReencodedSampleStorageUuid(row->sample,pin.model_version);
      const auto saved=history_->Get(target_id,true);
      if(saved) {
        receipt_result=absent("replaced");
        if(ReencodedMetadataMatches(row->sample,*saved,first->source,pin,spec,jpeg_sha,
            SampleSha256(saved->jpeg.data(),saved->jpeg.size()),saved->record.vector.size())) {
          try{(void)NormalizeVector(saved->record.vector,spec.dimensions);}catch(...){throw std::runtime_error("migration_target_invalid");}
          const auto current=history_->ReadReencodeSource(target_id,saved->fingerprint,pin.model_version,first->scope,false);
          if(current)receipt_result={{"status","committed"},{"stored",true},{"sample_id",target_id},{"model_version",pin.model_version},
            {"fingerprint",saved->fingerprint},{"ordinal",std::to_string(current->ordinal)},{"jpeg_sha256",jpeg_sha}};
        }
      }
    }
    const MigrationSourceProof actual{id,fingerprint,row->sample.record.channel,jpeg_sha,row->sample.record.captured_ms,row->ordinal};
    const auto last=authorize(actual);
    if(!last||!SameMigrationWriteAuthority(*first,*last)){Error(response,"migration_authorization_revoked",409);return;}
    if(receipt){Send(response,receipt_result);return;}
    try {
      const auto committed=history_->WriteReencodedSample(*sample,*row);
      const auto stored=history_->ReadReencodeSource(sample->record.id,committed,pin.model_version,last->scope,false);
      if(!stored)throw std::runtime_error("migration_target_not_visible");
      Send(response,{{"stored",true},{"sample_id",sample->record.id},{"model_version",pin.model_version},
        {"fingerprint",committed},{"ordinal",std::to_string(stored->ordinal)},{"jpeg_sha256",stored->jpeg_sha256}});
    }catch(const std::runtime_error& error){
      const std::string code=error.what();
      if(code=="search_history_capacity"){Error(response,"capacity_exceeded",507);return;}
      if(code=="migration_source_changed"||code=="search_slot_conflict"||code=="search_slot_token_conflict"||code=="search_sample_conflict"){
        Error(response,"migration_source_changed",409);return;
      }
      throw;
    }
  };
  server.Post("/v1/model-migrations/artifacts",Handle([this](const auto&request,auto&response){
    if(request.body.size()>2048)throw std::invalid_argument("migration_request_too_large");
    const auto body=Body(request);const auto action=body.at("action").template get<std::string>();
    const auto now=[](){return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();};
    if(action=="read"){
      Keys(body,{"action","job_id","generation","actor","payload_fingerprint","after","limit"});
      if(migration_authorization::Number(body.at("limit"),32)!=32)throw std::invalid_argument("migration_report_limit");
      const auto proof=ReadMigrationReportReadProof(body);const auto query=MigrationReportReadRequest(proof);
      const auto grant=ReadMigrationReportReadGrant(access_.migration_authorization(query),proof,now());
      if(!grant){Error(response,"migration_authorization_required",409);return;}
      std::optional<std::string> after;
      if(!body.at("after").is_null())after=Text(body.at("after"),47);
      const MigrationCoverageDefinition definition{proof.payload_fingerprint,grant->source,grant->target,grant->scope,
        grant->source_high_watermark,grant->target_checkpoint,grant->job_expires_ms};
      const auto page=history_->ReadMigrationCoverage(proof.job_id,proof.generation,proof.actor,definition,after);
      const auto last=ReadMigrationReportReadGrant(access_.migration_authorization(query),proof,now());
      if(!last||!MatchesRuntimeModelPin(last->source,grant->source)||!MatchesRuntimeModelPin(last->target,grant->target)||
          last->scope.channels!=grant->scope.channels||last->scope.from_ms!=grant->scope.from_ms||last->scope.to_ms!=grant->scope.to_ms||
          last->source_high_watermark!=grant->source_high_watermark||last->job_expires_ms!=grant->job_expires_ms){
        Error(response,"migration_authorization_revoked",409);return;}
      Send(response,page);return;
    }
    if(action!="start"&&action!="status")throw std::invalid_argument("migration_artifacts_action");
    Keys(body,{"action","job_id","worker","generation","actor","payload_fingerprint"});
    const auto proof=ReadMigrationWriteProof(body);auto query=MigrationAuthorizationRequest(proof);query["action"]="authorize_artifacts";
    const auto grant=ReadMigrationWriteGrant(access_.migration_authorization(query),proof,now());
    if(!grant){Error(response,"migration_authorization_required",409);return;}
    Send(response,migration_artifacts_(proof,*grant));
  }));
  server.Post("/v1/model-migrations/write-target",Handle([migration_handler](const auto& request,auto& response){migration_handler(request,response,false);}));
  server.Post("/v1/model-migrations/target-receipt",Handle([migration_handler](const auto& request,auto& response){migration_handler(request,response,true);}));
  server.Post("/v1/coverage", Handle([this](const auto& request, auto& response) {
    const auto body = Body(request); Keys(body, {"model_version", "scope"});
    auto model = Text(body.at("model_version"), 128); auto scope = ReadScope(body.at("scope"));
    Send(response, {{"model_version", model}, {"ranges", history_->Coverage(model, scope)}});
  }));
  server.Put("/v1/coverage/range", Handle([this](const auto& request, auto& response) {
    const auto source_write=EnterSourceWrite();
    const auto body = Body(request); Keys(body, {"id", "model_version", "channel_id", "from_ms", "to_ms", "kind", "state", "expires_ms"});
    const auto kind = Text(body.at("kind"), 8);
    const auto source = access_.sources.find(Uuid(body.at("channel_id")));
    if (source == access_.sources.end() || body.at("model_version") != access_.ingestion_model ||
        (kind == "scene" ? !source->second.scene : !source->second.object)) {
      Error(response, "source_not_authorized", 403); return;
    }
    if (kind != "scene" && kind != "object") throw std::invalid_argument("request_kind");
    history_->PutCoverage(Uuid(body.at("id")), Text(body.at("model_version"), 128), Uuid(body.at("channel_id")),
      Integer(body.at("from_ms")), Integer(body.at("to_ms")), kind == "scene", Text(body.at("state"), 8), Integer(body.at("expires_ms")));
    Send(response, {{"stored", true}});
  }));
  server.Delete("/v1/history/range", Handle([this](const auto& request, auto& response) {
    const auto source_write=EnterSourceWrite();
    const auto body = Body(request); Keys(body, {"channel_id", "from_ms", "to_ms"});
    history_->DeleteRange(Uuid(body.at("channel_id")), Integer(body.at("from_ms")), Integer(body.at("to_ms")));
    Send(response, {{"deleted", true}});
  }));
  server.Post("/v1/searches/begin", Handle([this](const auto& request, auto& response) {
    const Json body = Body(request);
    if(body.contains("min_similarity")) Keys(body, {"id", "actor", "query", "scope", "model_version", "verify", "expires_ms", "min_similarity"});
    else Keys(body, {"id", "actor", "query", "scope", "model_version", "verify", "expires_ms"});
    SearchSessionRequest input;
    input.id = Uuid(body.at("id")); input.actor = Text(body.at("actor"), 128); input.query = Text(body.at("query"), 1024, true);
    input.scope = ReadScope(body.at("scope")); input.model = Text(body.at("model_version"), 128);
    if(body.contains("min_similarity")) input.min_similarity = body.at("min_similarity").get<double>();
    input.verify = body.at("verify").get<bool>(); input.expires_ms = Integer(body.at("expires_ms"));
    const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
    if (input.expires_ms > now + access_.search_ttl_s * 1000) throw std::invalid_argument("request_retention");
    Send(response, {{"version", history_->BeginSearch(input)}});
  }));
  server.Post("/v1/searches/publish", Handle([this](const auto& request, auto& response) {
    const Json body = Body(request); Keys(body, {"id", "actor", "version", "coverage", "items"});
    const auto& items = body.at("items");
    if (!items.is_array() || items.size() > 60) throw std::invalid_argument("request_shortlist");
    std::vector<SearchSessionCandidate> candidates;
    for (const auto& item : items) {
      if(item.contains("evidence_refs"))Keys(item,{"sample_id","similarity","fingerprint","evidence_refs"});
      else if (item.contains("fingerprint")) Keys(item, {"sample_id", "similarity", "fingerprint"});
      else Keys(item, {"sample_id", "similarity"}); // Immutable legacy samples only; slots require a generation.
      SearchSessionCandidate candidate{Uuid(item.at("sample_id")), item.at("similarity").get<double>(), item.value("fingerprint", std::string{})};
      if(item.contains("evidence_refs")){
        const auto& refs=item.at("evidence_refs");if(!refs.is_array()||refs.empty()||refs.size()>3)throw std::invalid_argument("request_evidence_refs");
        for(const auto& ref:refs){Keys(ref,{"sample_id","fingerprint"});candidate.evidence_refs.push_back({Uuid(ref.at("sample_id")),Text(ref.at("fingerprint"),64)});}
      }
      candidates.push_back(std::move(candidate));
    }
    const bool published = history_->PublishSearch(Uuid(body.at("id")), Text(body.at("actor"), 128),
      Text(body.at("version"), 64), candidates, Text(body.at("coverage"), 8));
    Send(response, {{"published", published}});
  }));
  server.Post("/v1/searches/read", Handle([this](const auto& request, auto& response) {
    const Json body = Body(request); Keys(body, {"id", "actor", "offset", "limit"});
    const auto offset = Integer(body.at("offset")), limit = Integer(body.at("limit"));
    if (offset < 0 || offset > 60 || limit < 1 || limit > 60) throw std::invalid_argument("request_cursor");
    auto page = history_->ReadSearch(Uuid(body.at("id")), Text(body.at("actor"), 128), size_t(offset), size_t(limit));
    if (!page) { Error(response, "not_found", 404); return; }
    Json items = Json::array();
    for (const auto& hit : page->items) {
      auto item = SampleMetadata(hit.sample); item["similarity"] = hit.similarity;
      item["feedback"] = hit.relevant ? Json(*hit.relevant) : Json(nullptr);
      if (hit.verification) item["verification"] = *hit.verification;
      item["frames"]=hit.frames;item["started_ms"]=hit.started_ms;item["ended_ms"]=hit.ended_ms;
      items.push_back(std::move(item));
    }
    const auto& q = page->request;
    const std::vector<std::string> channels(q.scope.channels.begin(), q.scope.channels.end());
    Json result = {{"search_id", q.id}, {"version", page->version}, {"query", q.query}, {"model_version", q.model},
      {"verify", q.verify}, {"expires_ms", q.expires_ms}, {"published", page->published}, {"coverage", page->coverage},
      {"scope", {{"channel_ids", channels}, {"from_ms", q.scope.from_ms}, {"to_ms", q.scope.to_ms}, {"limit", 60}}},
      {"items", items}, {"next_offset", page->next_offset ? Json(*page->next_offset) : Json(nullptr)}};
    if(q.min_similarity) result["min_similarity"] = *q.min_similarity;
    Send(response, result);
  }));
  server.Post("/v1/searches/verification", Handle([this](const auto& request, auto& response) {
    Send(response, history_->SearchVerification(Body(request)));
  }));
  server.Post("/v1/searches/feedback", Handle([this](const auto& request, auto& response) {
    const Json body = Body(request); Keys(body, {"id", "actor", "sample_id", "relevant"});
    if (!history_->SearchFeedback(Uuid(body.at("id")), Text(body.at("actor"), 128), Uuid(body.at("sample_id")), body.at("relevant").get<bool>())) {
      Error(response, "not_found", 404); return;
    }
    Send(response, {{"stored", true}});
  }));
  server.Post("/v1/searches/image", Handle([this](const auto& request, auto& response) {
    const Json body = Body(request); Keys(body, {"id", "actor", "sample_id", "frame_id"});
    auto sample = history_->SearchImage(Uuid(body.at("id")), Text(body.at("actor"), 128), Uuid(body.at("sample_id")), Uuid(body.at("frame_id")));
    if (!sample) { Error(response, "not_found", 404); return; }
    response.set_content(reinterpret_cast<const char*>(sample->jpeg.data()), sample->jpeg.size(), "image/jpeg");
  }));
  server.Post("/v1/searches/cancel", Handle([this](const auto& request, auto& response) {
    const Json body = Body(request); Keys(body, {"id", "actor"});
    history_->CancelSearch(Uuid(body.at("id")), Text(body.at("actor"), 128));
    Send(response, {{"cancelled", true}});
  }));
}
}  // namespace ainvr::search
