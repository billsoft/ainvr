#include "history_mongo.hpp"
#include "display_bbox.hpp"
#include "migration_coverage.hpp"
#include "migration_sample.hpp"
#include "model_migration_authorization.hpp"
#include "observation_evidence.hpp"
#include <mongoc/mongoc.h>
#include <openssl/rand.h>
#include <chrono>
#include <algorithm>
#include <cstring>
#include <functional>
#include <mutex>
#include <regex>
namespace ainvr::search {
namespace {
using Json = nlohmann::json;
int64_t Now() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
Json Date(int64_t ms) { return {{"$date", {{"$numberLong", std::to_string(ms)}}}}; }
void Fail(const bson_error_t& error) { throw std::runtime_error("search_history_error_" + std::to_string(error.domain) + "_" + std::to_string(error.code)); }
struct Bson {
  bson_t* value;
  explicit Bson(const Json& json) {
    bson_error_t error{}; const auto text = json.dump();
    value = bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()), text.size(), &error);
    if (!value) throw std::invalid_argument("invalid_history_document");
  }
  ~Bson() { bson_destroy(value); }
  Bson(const Bson&) = delete;
  Bson& operator=(const Bson&) = delete;
  operator const bson_t*() const { return value; }
};
// bson_t is an aligned C type. Keep it out of STL template type arguments;
// GCC warns that those arguments discard libbson's alignment attributes.
struct Doc {
  bson_t* value = nullptr;
  explicit Doc(bson_t* p = nullptr): value(p) {}
  ~Doc() { if (value) bson_destroy(value); }
  Doc(const Doc&) = delete;
  Doc& operator=(const Doc&) = delete;
  Doc(Doc&& other) noexcept: value(other.value) { other.value = nullptr; }
  bson_t* get() const { return value; }
  void reset(bson_t* p) { if (value) bson_destroy(value); value = p; }
  explicit operator bool() const { return value != nullptr; }
};
using Coll = std::unique_ptr<mongoc_collection_t, decltype(&mongoc_collection_destroy)>;
using Cursor = std::unique_ptr<mongoc_cursor_t, decltype(&mongoc_cursor_destroy)>;
Json ToJson(const bson_t* doc) {
  char* text = bson_as_relaxed_extended_json(doc, nullptr);
  if (!text) throw std::runtime_error("history_json_failed");
  std::unique_ptr<char, decltype(&bson_free)> owned(text, bson_free);
  return Json::parse(text);
}
void Uuid(const std::string& id) {
  static const std::regex pattern("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");
  if (!std::regex_match(id, pattern)) throw std::invalid_argument("invalid_history_identity");
}
std::string Sha(const uint8_t* data, size_t size) {
  return SampleSha256(data, size);
}
std::string Sha(const std::string& text) { return Sha(reinterpret_cast<const uint8_t*>(text.data()), text.size()); }
std::vector<uint8_t> Binary(const bson_t* doc, const char* name) {
  bson_iter_t it; bson_subtype_t subtype; uint32_t size = 0; const uint8_t* data = nullptr;
  if (!bson_iter_init_find(&it, doc, name) || !BSON_ITER_HOLDS_BINARY(&it)) throw std::runtime_error("history_binary_missing");
  bson_iter_binary(&it, &subtype, &size, &data);
  if (subtype != BSON_SUBTYPE_BINARY) throw std::runtime_error("history_binary_type");
  return {data, data + size};
}
std::string Text(const bson_t* doc, const char* name) {
  bson_iter_t it;
  if (!bson_iter_init_find(&it, doc, name) || !BSON_ITER_HOLDS_UTF8(&it)) throw std::runtime_error("history_text_missing");
  return bson_iter_utf8(&it, nullptr);
}
int64_t Number(const bson_t* doc, const char* name) {
  bson_iter_t it;
  if (!bson_iter_init_find(&it, doc, name) || !BSON_ITER_HOLDS_NUMBER(&it)) throw std::runtime_error("history_number_missing");
  return bson_iter_as_int64(&it);
}
int64_t ExactInteger(const bson_t* doc,const char* name) {
  bson_iter_t it;
  if(!bson_iter_init_find(&it,doc,name)||(!BSON_ITER_HOLDS_INT32(&it)&&!BSON_ITER_HOLDS_INT64(&it)))
    throw std::runtime_error("history_metadata_integrity");
  return bson_iter_as_int64(&it);
}
Json MetadataProjection(bool image=false) {
  Json out;
  for(const auto* field:{"_id","channel","model","captured_ms","expires_at","ordinal","metadata","metadata_sha","fingerprint","vector_sha","jpeg_sha","track_slot"})out[field]=1;
  if(image)out["jpeg"]=1;
  return out;
}
int64_t DateValue(const bson_t* doc, const char* name) {
  bson_iter_t it;
  if (!bson_iter_init_find(&it, doc, name) || !BSON_ITER_HOLDS_DATE_TIME(&it)) throw std::runtime_error("history_date_missing");
  return bson_iter_date_time(&it);
}
Json ReadMetadata(const bson_t* doc) {
  bson_iter_t it; const uint8_t* data; uint32_t size;
  if (!bson_iter_init_find(&it, doc, "metadata") || !BSON_ITER_HOLDS_DOCUMENT(&it)) throw std::runtime_error("history_metadata_missing");
  bson_iter_document(&it, &size, &data); bson_t view;
  if (!bson_init_static(&view, data, size)) throw std::runtime_error("history_metadata_invalid");
  return ToJson(&view);
}
Json CheckedMetadata(const bson_t* doc) {
  auto meta = ReadMetadata(doc);
  if (Text(doc, "metadata_sha") != Sha(meta.dump()) ||
      Text(doc, "fingerprint") != Sha(Text(doc, "metadata_sha") + Text(doc, "vector_sha") + Text(doc, "jpeg_sha")) ||
      meta.at("id") != Text(doc, "_id") || meta.at("channel") != Text(doc, "channel") ||
      meta.at("model") != Text(doc, "model") || meta.at("captured_ms") != ExactInteger(doc, "captured_ms") ||
      meta.at("expires_ms") != DateValue(doc, "expires_at"))
    throw std::runtime_error("history_metadata_integrity");
  return meta;
}
Sample DecodeMetadata(const bson_t* doc,const Json& meta) {
  Sample s; s.fingerprint = Text(doc, "fingerprint");
  auto& r = s.record;
  r.id = meta.at("id"); r.channel = meta.at("channel"); r.processor = meta.at("processor"); r.session = meta.at("session");
  r.track = meta.at("track"); r.model = meta.at("model"); r.captured_ms = meta.at("captured_ms"); r.scene = meta.at("scene");
  s.evidence = meta.at("evidence"); s.expires_ms = meta.at("expires_ms");
  r.fingerprint = s.fingerprint;
  bson_iter_t slot;
  if (bson_iter_init_find(&slot, doc, "track_slot")) {
    if (!BSON_ITER_HOLDS_INT32(&slot) && !BSON_ITER_HOLDS_INT64(&slot)) throw std::runtime_error("history_slot_invalid");
    const auto value = bson_iter_as_int64(&slot);
    if (value < 0 || value >= 8 || r.scene) throw std::runtime_error("history_slot_invalid");
    s.track_slot = static_cast<size_t>(value);
  }
  return s;
}
HistoryMetadataRow MetadataRow(const bson_t* doc,const Json& meta,Sample sample) {
  HistoryMetadataRow row{std::move(sample),ExactInteger(doc,"ordinal"),Text(doc,"jpeg_sha")};
  const auto dimensions=meta.value("dimensions",Json());
  if(dimensions.is_number_integer()&&dimensions>0&&dimensions<=4096)row.dimensions=dimensions.get<size_t>();
  const auto format=meta.value("vector_format",Json());
  if(format.is_string()&&format.get_ref<const std::string&>().size()<=16)row.vector_format=format.get<std::string>();
  return row;
}
Sample Decode(const bson_t* doc, bool image) {
  auto meta=CheckedMetadata(doc);auto s=DecodeMetadata(doc,meta);auto& r=s.record;
  auto vector=Binary(doc,"vector");
  if(Text(doc,"vector_sha")!=Sha(vector.data(),vector.size()))
    throw std::runtime_error("history_integrity_mismatch");
  if(meta.at("vector_format")!="f32le"||vector.size()%4||vector.size()/4!=meta.at("dimensions").get<size_t>())
    throw std::runtime_error("history_vector_format");
  for (size_t at = 0; at < vector.size(); at += 4) {
    uint32_t bits = 0; for (int i = 0; i < 4; ++i) bits |= uint32_t(vector[at + i]) << (8 * i);
    float v; std::memcpy(&v, &bits, 4); r.vector.push_back(v);
  }
  NormalizeVector(r.vector, r.vector.size());
  if (image) {
    s.jpeg = Binary(doc, "jpeg");
    if (Text(doc, "jpeg_sha") != Sha(s.jpeg.data(), s.jpeg.size())) throw std::runtime_error("history_image_integrity");
  }
  return s;
}
void Range(const Scope& scope) {
  if (scope.channels.empty() || scope.channels.size() > 100 || scope.from_ms < 0 || scope.to_ms <= scope.from_ms ||
      scope.to_ms - scope.from_ms > 31LL * 86400000) throw std::invalid_argument("invalid_history_scope");
  for (const auto& channel : scope.channels) Uuid(channel);
}
std::string SearchKey(const std::string& id, const std::string& actor) {
  Uuid(id);
  if (actor.empty() || actor.size() > 128 || actor.find_first_of("\r\n") != std::string::npos)
    throw std::invalid_argument("invalid_search_actor");
  return Sha(Json::array({actor, id}).dump());
}
Json SearchRequestJson(const SearchSessionRequest& request) {
  SearchKey(request.id, request.actor); Range(request.scope);
  if (request.query.empty() || request.query.size() > 1024 || request.model.empty() || request.model.size() > 128)
    throw std::invalid_argument("invalid_search_request");
  const std::vector<std::string> channels(request.scope.channels.begin(), request.scope.channels.end());
  return {{"id", request.id}, {"actor", request.actor}, {"query", request.query}, {"model", request.model},
    {"channels", channels}, {"from", request.scope.from_ms}, {"to", request.scope.to_ms}, {"verify", request.verify}};
}
SearchSessionRequest ReadSearchRequest(const bson_t* doc) {
  const auto row = ToJson(doc); const auto& value = row.at("request");
  if (row.at("fingerprint") != Sha(value.dump())) throw std::runtime_error("search_session_integrity");
  SearchSessionRequest request;
  request.id = value.at("id"); request.actor = value.at("actor"); request.query = value.at("query"); request.model = value.at("model");
  request.scope.channels = value.at("channels").get<std::set<std::string>>();
  request.scope.from_ms = value.at("from"); request.scope.to_ms = value.at("to"); request.verify = value.at("verify");
  request.expires_ms = DateValue(doc, "expires_at");
  if (SearchRequestJson(request) != value || Text(doc, "_id") != SearchKey(request.id, request.actor))
    throw std::runtime_error("search_session_identity");
  return request;
}
bool SameEvidenceGroup(const Sample& primary, const Sample& related) {
  const auto& a=primary.record;const auto& b=related.record;
  if(a.scene||b.scene)return a.id==b.id;
  if(a.channel!=b.channel||a.processor!=b.processor||a.session!=b.session||a.track!=b.track||a.model!=b.model)return false;
  for(const auto* field:{"source_input_id","output_channel_id","recording_channel_id","input_path","output_path"})
    if(primary.evidence.value(field,Json())!=related.evidence.value(field,Json()))return false;
  return true;
}
Json FrozenEvidence(const Json& slot,const Sample& primary) {
  if(!slot.contains("frames"))return Json::array({{{"sample_id",primary.record.id},{"frame_id",primary.evidence.at("frame_id")},
    {"fingerprint",primary.fingerprint},{"captured_ms",primary.record.captured_ms},{"role","match"}}});
  const auto& frames=slot.at("frames");
  if(!frames.is_array()||frames.empty()||frames.size()>3)throw std::runtime_error("search_shortlist_integrity");
  std::set<std::string> ids,frame_ids;size_t matches=0;
  for(const auto& frame:frames){
    if(!frame.is_object()||frame.size()!=5)throw std::runtime_error("search_shortlist_integrity");
    const auto id=frame.at("sample_id").get<std::string>(),frame_id=frame.at("frame_id").get<std::string>();Uuid(id);Uuid(frame_id);
    const auto fp=frame.at("fingerprint").get<std::string>(),role=frame.at("role").get<std::string>();
    if(fp.size()!=64||!std::all_of(fp.begin(),fp.end(),[](char c){return(c>='0'&&c<='9')||(c>='a'&&c<='f');})||
      !ids.insert(id).second||!frame_ids.insert(frame_id).second||!frame.at("captured_ms").is_number_integer()||frame.at("captured_ms").get<int64_t>()<0||
      (role!="match"&&role!="before"&&role!="after"))throw std::runtime_error("search_shortlist_integrity");
    if(role=="match"){++matches;if(id!=primary.record.id||frame_id!=primary.evidence.at("frame_id")||fp!=primary.fingerprint||
      frame.at("captured_ms")!=primary.record.captured_ms)throw std::runtime_error("search_shortlist_integrity");}
  }
  if(matches!=1||(primary.record.scene&&frames.size()!=1))throw std::runtime_error("search_shortlist_integrity");
  return frames;
}
Json ReadShortlist(const bson_t* doc) {
  const auto row = ToJson(doc); const auto& shortlist = row.at("shortlist");
  if (shortlist.dump().size() > 65536 || row.at("shortlist_sha") != Sha(shortlist.dump()) || shortlist.at("version") != row.at("version") ||
      !shortlist.at("slots").is_array() || shortlist.at("slots").size() > 60)
    throw std::runtime_error("search_shortlist_integrity");
  return shortlist;
}
std::string NewSearchVersion() {
  uint8_t bytes[32]; if (RAND_bytes(bytes, sizeof(bytes)) != 1) throw std::runtime_error("search_nonce_failed");
  return Sha(bytes, sizeof(bytes));
}
}  // namespace

namespace {
void VerKeys(const Json& value, std::initializer_list<const char*> names) {
  if (!value.is_object() || value.size() != names.size()) throw std::invalid_argument("invalid_verification_fields");
  for (const auto* name : names) if (!value.contains(name)) throw std::invalid_argument("invalid_verification_fields");
}
std::string VerText(const Json& value, size_t limit = 128) {
  if (!value.is_string()) throw std::invalid_argument("invalid_verification_text");
  auto text = value.get<std::string>();
  if (text.empty() || text.size() > limit) throw std::invalid_argument("invalid_verification_text");
  for (unsigned char c : text) if (c < 32 || c == 127) throw std::invalid_argument("invalid_verification_text");
  return text;
}
std::string VerHash(const Json& value) {
  const auto text = VerText(value, 64);
  if (!std::regex_match(text, std::regex("^[a-f0-9]{64}$"))) throw std::invalid_argument("invalid_verification_hash");
  return text;
}
int64_t VerInteger(const Json& value, int64_t minimum = 0) {
  if (!value.is_number_integer() || (value.is_number_unsigned() && value.get<uint64_t>() > 9007199254740991ULL))
    throw std::invalid_argument("invalid_verification_integer");
  const auto n = value.get<int64_t>();
  if (n < minimum || n > 9007199254740991LL) throw std::invalid_argument("invalid_verification_integer");
  return n;
}
std::string VerScope(const Json& value) {
  const auto scope = VerText(value, 8);
  if (scope != "visible" && scope != "temporal") throw std::invalid_argument("invalid_verification_scope");
  return scope;
}
std::string VerRequestId(const Json& value) {
  const auto id = VerText(value);
  if (!std::regex_match(id, std::regex("^[a-zA-Z0-9_.:-]{1,128}$"))) throw std::invalid_argument("invalid_verification_request");
  return id;
}
Json VerProfile(const Json& profile) {
  VerKeys(profile, {"task_id", "template_sha256", "preprocessing_version", "decision_policy", "model_package_id", "model_package_sha256", "profile_fp"});
  if (profile.at("task_id") != "search-verify-zh-v1" || profile.at("decision_policy") != "abc-visible-v1")
    throw std::invalid_argument("invalid_verification_profile");
  VerHash(profile.at("template_sha256")); VerHash(profile.at("model_package_sha256"));
  VerText(profile.at("preprocessing_version")); VerText(profile.at("model_package_id"));
  const auto expected = Sha(Json::array({profile.at("task_id"), profile.at("template_sha256"), profile.at("preprocessing_version"),
    profile.at("decision_policy"), profile.at("model_package_id"), profile.at("model_package_sha256")}).dump());
  if (VerHash(profile.at("profile_fp")) != expected) throw std::invalid_argument("invalid_verification_profile");
  return profile;
}
Json VerTarget(const Json& target) {
  VerKeys(target, {"search_id", "actor", "version", "sample_id"});
  Uuid(VerText(target.at("search_id"), 36)); Uuid(VerText(target.at("sample_id"), 36));
  VerText(target.at("actor")); VerHash(target.at("version")); return target;
}
Json VerBinding(const Json& binding) {
  VerKeys(binding, {"search_id", "actor", "version", "sample_id", "frame_id", "fingerprint", "query_sha256", "jpeg_sha256", "profile_fp", "question_scope"});
  VerTarget({{"search_id", binding.at("search_id")}, {"actor", binding.at("actor")}, {"version", binding.at("version")}, {"sample_id", binding.at("sample_id")}});
  Uuid(VerText(binding.at("frame_id"), 36));
  for (const auto* hash : {"fingerprint", "query_sha256", "jpeg_sha256", "profile_fp"}) VerHash(binding.at(hash));
  VerScope(binding.at("question_scope")); return binding;
}
std::string VerQuery(const std::string& query) {
  const auto first = query.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) throw std::invalid_argument("empty_verification_query");
  return query.substr(first, query.find_last_not_of(" \t\r\n") - first + 1);
}
bool VerFinal(const Json& entry) {
  const auto state = entry.value("state", std::string{});
  return state == "match" || state == "mismatch" || state == "uncertain" || state == "unavailable";
}
Json VerRecords(const Json& row) {
  if (!row.contains("verification")) return Json::object();
  const auto records = row.at("verification");
  if (!records.is_object() || records.size() > 5 || records.dump().size() > 5 * 8192 ||
      row.value("verification_sha", std::string{}) != Sha(records.dump())) throw std::runtime_error("history_verification_integrity");
  for (const auto& pair : records.items()) {
    Uuid(pair.key()); const auto& entry = pair.value();
    if (!entry.is_object() || entry.dump().size() > 8192 || !entry.contains("binding") ||
        entry.at("binding").at("sample_id") != pair.key()) throw std::runtime_error("history_verification_integrity");
    VerBinding(entry.at("binding"));
    const auto state = entry.value("state", std::string{});
    if (state != "queued" && state != "running" && !VerFinal(entry)) throw std::runtime_error("history_verification_integrity");
  }
  return records;
}
Json VerView(const Json& entry) {
  if (entry.is_null()) return nullptr;
  return {{"state", entry.at("state")}, {"profile_fp", entry.at("binding").at("profile_fp")},
    {"request_id", entry.at("request_id")}, {"cached", entry.at("cached")}, {"reason", entry.at("reason")}};
}
Json VerSubmitted(const Json& entry) {
  if (entry.is_null() || !entry.value("submitted", false)) return nullptr;
  return {{"job_id", entry.at("job_id")}, {"generation", entry.at("generation")}, {"request_id", entry.at("request_id")}};
}
Json VerMutation(bool stored, const char* status, const Json& entry = nullptr) {
  return {{"stored", stored}, {"status", status}, {"verification", VerView(entry)}, {"submitted", VerSubmitted(entry)}};
}
void VerResult(const Json& result, const Json& binding, const Json& profile, const std::string& request_id, const std::string& kind, const std::string& query) {
  VerKeys(result, {"schema", "request_id", "frame_id", "evidence_sha256", "query_sha256", "input_sha256", "question_scope", "kind",
    "template", "template_sha256", "preprocessing_version", "model", "validated", "decision_policy", "score_kind", "decision", "reason", "logits", "reference_scores", "timing_ms"});
  if (result.dump().size() > 4096 || result.at("schema") != "ainvr.search_verification.v1" || result.at("request_id") != request_id ||
      result.at("frame_id") != binding.at("frame_id") || result.at("evidence_sha256") != binding.at("jpeg_sha256") ||
      result.at("query_sha256") != binding.at("query_sha256") || result.at("question_scope") != binding.at("question_scope") ||
      result.at("kind") != kind || result.at("template") != profile.at("task_id") || result.at("template_sha256") != profile.at("template_sha256") ||
      result.at("preprocessing_version") != profile.at("preprocessing_version") || result.at("decision_policy") != profile.at("decision_policy") ||
      result.at("validated") != false || result.at("score_kind") != "three_way_softmax_uncalibrated")
    throw std::invalid_argument("invalid_verification_result");
  VerKeys(result.at("model"), {"package_id", "package_sha256"});
  if (result.at("model").at("package_id") != profile.at("model_package_id") ||
      result.at("model").at("package_sha256") != profile.at("model_package_sha256")) throw std::invalid_argument("invalid_verification_model");
  if (result.at("input_sha256") != Sha(Json{{"query", VerQuery(query)}, {"question_scope", binding.at("question_scope")},
      {"kind", kind}, {"frame_id", binding.at("frame_id")}, {"evidence_sha256", binding.at("jpeg_sha256")},
      {"template_sha256", profile.at("template_sha256")}, {"preprocessing_version", profile.at("preprocessing_version")},
      {"model_sha256", profile.at("model_package_sha256")}}.dump())) throw std::invalid_argument("invalid_verification_input");
  const auto decision = VerText(result.at("decision"), 16), reason = VerText(result.at("reason"), 48);
  if ((decision != "match" && decision != "mismatch" && decision != "uncertain") ||
      (reason != "visible_evidence" && reason != "ambiguous_evidence" && reason != "insufficient_evidence" && reason != "temporal_evidence_required") ||
      ((decision == "match" || decision == "mismatch") && reason != "visible_evidence")) throw std::invalid_argument("invalid_verification_decision");
  if (binding.at("question_scope") == "temporal") {
    if (decision != "uncertain" || reason != "temporal_evidence_required" || !result.at("logits").is_null() || !result.at("reference_scores").is_null())
      throw std::invalid_argument("invalid_temporal_verification");
  } else {
    VerKeys(result.at("logits"), {"A", "B", "C"}); VerKeys(result.at("reference_scores"), {"A", "B", "C"});
    double total = 0;
    for (const auto* key : {"A", "B", "C"}) {
      const auto score = result.at("reference_scores").at(key).get<double>(), logit = result.at("logits").at(key).get<double>();
      if (!std::isfinite(score) || !std::isfinite(logit) || score < 0 || score > 1 || std::abs(logit) > 1e9) throw std::invalid_argument("invalid_verification_logits");
      total += score;
    }
    if (std::abs(total - 1) > 1e-6) throw std::invalid_argument("invalid_verification_logits");
  }
  VerKeys(result.at("timing_ms"), {"queue", "preprocess", "total"});
  for (const auto& value : result.at("timing_ms")) { const auto n = value.get<double>(); if (!std::isfinite(n) || n < 0 || n > 10000000) throw std::invalid_argument("invalid_verification_timing"); }
}
constexpr const char* kSourceWriterMarker="source_writer_epoch";
Json SourceWriterStateJson(const SourceWriterEpoch&e){
  return{{"schema_version","search-source-writer-epoch-v2"},{"owner_uuid",e.owner_uuid},{"dirty",e.dirty},
    {"previous_unclean",e.previous_unclean},{"uncertainty",e.uncertainty},
    {"resume_after_ms",e.resume_after_ms},
    {"topology",{{"connection_identity",e.topology.connection_identity},{"process_id",e.topology.process_id},
      {"standalone_verified",e.topology.standalone_verified}}}};
}
SourceWriterEpoch DecodeSourceWriterMarker(const bson_t*doc){
  if(!doc||doc->len>4096)throw std::runtime_error("source_writer_epoch_integrity");
  try{
    const auto envelope=ToJson(doc);VerKeys(envelope,{"_id","state","state_sha256","mutation_nonce"});
    if(envelope.at("_id")!=kSourceWriterMarker)throw std::runtime_error("source_writer_epoch_integrity");
    const auto&state=envelope.at("state");
    const bool v2=state.value("schema_version",std::string{})=="search-source-writer-epoch-v2";
    if(v2)VerKeys(state,{"schema_version","owner_uuid","dirty","previous_unclean","uncertainty","topology","resume_after_ms"});
    else VerKeys(state,{"schema_version","owner_uuid","dirty","previous_unclean","uncertainty","topology"});
    const auto&topology=state.at("topology");VerKeys(topology,{"connection_identity","process_id","standalone_verified"});
    if((!v2&&state.at("schema_version")!="search-source-writer-epoch-v1")||!state.at("dirty").is_boolean()||
        !state.at("previous_unclean").is_boolean()||!state.at("uncertainty").is_boolean()||!topology.at("standalone_verified").is_boolean()||
        VerHash(envelope.at("state_sha256"))!=Sha(state.dump())||VerHash(envelope.at("mutation_nonce")).size()!=64)
      throw std::runtime_error("source_writer_epoch_integrity");
    SourceWriterEpoch epoch{state.at("owner_uuid").get<std::string>(),state.at("dirty").get<bool>(),
      state.at("previous_unclean").get<bool>(),state.at("uncertainty").get<bool>(),
      {topology.at("connection_identity").get<std::string>(),topology.at("process_id").get<std::string>(),topology.at("standalone_verified").get<bool>()}};
    if(v2){
      if(!state.at("resume_after_ms").is_number_integer()||state.at("resume_after_ms")<0||state.at("resume_after_ms")>9007199254740991LL)
        throw std::runtime_error("source_writer_epoch_integrity");
      epoch.resume_after_ms=state.at("resume_after_ms").get<int64_t>();
    }
    if(!ValidSourceWriterOwner(epoch.owner_uuid)||!ValidSourceWriterTopology(epoch.topology))throw std::runtime_error("source_writer_epoch_integrity");
    return epoch;
  }catch(...){throw std::runtime_error("source_writer_epoch_integrity");}
}
std::string SourceWriterNonce(){
  unsigned char bytes[32];if(RAND_bytes(bytes,sizeof(bytes))!=1)throw std::runtime_error("source_writer_entropy_unavailable");
  static const char hex[]="0123456789abcdef";std::string out;for(const auto c:bytes){out+=hex[c>>4];out+=hex[c&15];}return out;
}
bool AcknowledgedSourceWriterReply(const bson_t*reply,const char*count_field){
  for(const auto*field:{"writeConcernError","writeConcernErrors","writeErrors"}){
    bson_iter_t error;if(bson_iter_init_find(&error,reply,field))return false;
  }
  bson_iter_t count;if(!bson_iter_init_find(&count,reply,count_field)||
      !(BSON_ITER_HOLDS_INT32(&count)||BSON_ITER_HOLDS_INT64(&count))||bson_iter_as_int64(&count)!=1)return false;
  if(std::string(count_field)=="matchedCount"){
    bson_iter_t changed;if(!bson_iter_init_find(&changed,reply,"modifiedCount")||
        !(BSON_ITER_HOLDS_INT32(&changed)||BSON_ITER_HOLDS_INT64(&changed))||bson_iter_as_int64(&changed)!=1)return false;
  }
  return true;
}
} // namespace

struct HistoryMongo::State {
  mongoc_client_pool_t* pool = nullptr;
  std::string database; HistoryBudget budget; std::mutex mutex;
  Json cached_usage,report_usage; int64_t usage_at = 0;
  std::string source_connection_identity,source_local_owner;
  bool source_single_host=false,source_local_unknown=false,source_begin_durable=false,source_epoch_closed=false;
  int64_t source_resume_after_ms=0;
  uint64_t projection_revision=0;
  bool projection_unsettled=false;
  ~State() { if (pool) mongoc_client_pool_destroy(pool); }
  struct Client {
    mongoc_client_pool_t* pool; mongoc_client_t* value;
    explicit Client(State& s): pool(s.pool), value(mongoc_client_pool_pop(pool)) { if (!value) throw std::runtime_error("history_unavailable"); }
    ~Client() { mongoc_client_pool_push(pool, value); }
  };
  Coll Collection(Client& c, const char* name) { return Coll(mongoc_client_get_collection(c.value, database.c_str(), name), mongoc_collection_destroy); }
  Json Command(Client& c, const nlohmann::ordered_json& command) {
    // MongoDB takes the first BSON key as the command name. A sorted JSON map
    // would turn {listCollections, filter} into an invalid "filter" command.
    const auto text = command.dump(); bson_error_t error{}; bson_t reply;
    Doc input(bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()), text.size(), &error));
    if (!input) throw std::invalid_argument("invalid_history_command");
    const bool ok = mongoc_client_command_simple(c.value, database.c_str(), input.get(), nullptr, &reply, &error);
    Doc owned(bson_copy(&reply)); bson_destroy(&reply); if (!ok) Fail(error);
    return ToJson(owned.get());
  }
  template<typename Visit>
  void Each(Client& c, const char* name, const Json& query, Json options, Visit visit,
            const std::vector<std::pair<std::string, int>>& sort_order = {}) {
    options["maxTimeMS"] = 5000;
    if (!sort_order.empty()) options.erase("sort");
    Bson filter(query), opts(options); auto collection = Collection(c, name);
    if (!sort_order.empty()) {
      bson_t sort; BSON_APPEND_DOCUMENT_BEGIN(opts.value, "sort", &sort);
      for (const auto& field : sort_order) BSON_APPEND_INT32(&sort, field.first.c_str(), field.second);
      bson_append_document_end(opts.value, &sort);
    }
    Cursor cursor(mongoc_collection_find_with_opts(collection.get(), filter, opts, nullptr), mongoc_cursor_destroy);
    const bson_t* doc; while (mongoc_cursor_next(cursor.get(), &doc)) visit(doc);
    bson_error_t error{}; if (mongoc_cursor_error(cursor.get(), &error)) Fail(error);
  }
  Doc One(Client& c, const char* name, const Json& query, Json options = Json::object()) {
    Doc found; options["limit"] = 1;
    Each(c, name, query, options, [&](const bson_t* doc) { found.reset(bson_copy(doc)); }); return found;
  }
  int64_t Update(Client& c, const char* name, const Json& query, const Json& update, bool insert) {
    auto collection = Collection(c, name); Bson filter(query), body(update), opts({{"upsert", insert}, {"writeConcern", {{"w", 1}, {"j", true}, {"wtimeout", 5000}}}});
    bson_error_t error{}; bson_t reply;
    const bool ok = mongoc_collection_update_one(collection.get(), filter, body, opts, &reply, &error);
    bson_iter_t matched; int64_t count = 0;
    if (bson_iter_init_find(&matched, &reply, "matchedCount") && BSON_ITER_HOLDS_NUMBER(&matched)) count = bson_iter_as_int64(&matched);
    bson_destroy(&reply); if (!ok) Fail(error);
    return count;
  }
  void Delete(Client& c, const char* name, const Json& query) {
    auto collection = Collection(c, name); Bson filter(query), opts(Json{{"writeConcern", {{"w", 1}, {"j", true}, {"wtimeout", 5000}}}});
    bson_error_t error{}; bson_t reply;
    const bool ok = mongoc_collection_delete_many(collection.get(), filter, opts, &reply, &error);
    bson_destroy(&reply); if (!ok) Fail(error);
  }
  int64_t Count(Client& c, const char* name) {
    auto collection = Collection(c, name); Bson filter(Json::object()), opts(Json{{"maxTimeMS", 5000}}); bson_error_t error{};
    const auto n = mongoc_collection_count_documents(collection.get(), filter, opts, nullptr, nullptr, &error);
    if (n < 0) Fail(error);
    return n;
  }
  Json Usage(Client& c) {
    const auto result = Command(c, {{"aggregate", "search_samples"}, {"pipeline", Json::array({
      {{"$group", {{"_id", nullptr}, {"samples", {{"$sum", 1}}}, {"bytes", {{"$sum", "$bytes"}}}}}}
    })}, {"cursor", Json::object()}, {"maxTimeMS", 5000}});
    const auto rows = result.at("cursor").at("firstBatch");
    cached_usage = rows.empty() ? Json{{"samples", 0}, {"bytes", 0}} : Json{{"samples", rows[0].at("samples")}, {"bytes", rows[0].at("bytes")}};
    usage_at = Now(); return cached_usage;
  }
  Json CachedUsage(Client& c) {
    if (cached_usage.is_null() || Now() - usage_at > 60000) return Usage(c);
    return cached_usage;
  }
  void Prune(Client& c, const char* name) {
    Json ids = Json::array();
    Each(c, name, {{"expires_at", {{"$lte", Date(Now())}}}}, {{"limit", 512}, {"projection", {{"_id", 1}}}},
      [&](const bson_t* doc) { ids.push_back(Text(doc, "_id")); });
    if (!ids.empty()) {
      cached_usage = Json();
      if(std::string(name)=="search_migration_reports")report_usage=Json();
      Delete(c, name, {{"_id", {{"$in", ids}}}});
    }
  }
  // Rolling retention: early expiry of the OLDEST evidence under the writer mutex. Deletes by _id
  // (same journaled delete as Prune), never writes deny-intents (that is DeleteRange), never touches
  // rows younger than budget.evict_min_age_ms, and never runs for migration derivatives.
  // Returns true when at least one row was removed.
  int64_t evicted_samples = 0, evicted_bytes = 0, eviction_runs = 0;
  bool EvictOldest(Client& c, int64_t incoming_bytes) {
    const auto now = Now();
    const int64_t cutoff = now - budget.evict_min_age_ms;
    const int64_t low_samples = static_cast<int64_t>(budget.max_samples * 0.95);
    const int64_t low_bytes = static_cast<int64_t>(budget.max_bytes * 0.95) - incoming_bytes;
    auto usage = Usage(c);
    int64_t samples = usage.at("samples").get<int64_t>(), bytes = usage.at("bytes").get<int64_t>();
    std::map<std::string, int64_t> horizon;   // per channel: newest evicted captured_ms
    bool removed = false;
    for (int batch = 0; batch < 8 && (samples > low_samples || bytes > low_bytes); ++batch) {
      Json ids = Json::array(); int64_t freed = 0; int64_t count = 0;
      Each(c, "search_samples", {{"captured_ms", {{"$lt", cutoff}}}},
        {{"limit", 128}, {"maxTimeMS", 5000}, {"projection", {{"_id", 1}, {"bytes", 1}, {"channel", 1}, {"captured_ms", 1}}}},
        [&](const bson_t* doc) {
          if (samples - count <= low_samples && bytes - freed <= low_bytes) return;   // enough already
          ids.push_back(Text(doc, "_id")); ++count; freed += Number(doc, "bytes");
          const auto channel = Text(doc, "channel"); const auto at = Number(doc, "captured_ms");
          auto found = horizon.find(channel); if (found == horizon.end() || found->second < at) horizon[channel] = at;
        }, {{"captured_ms", 1}, {"ordinal", 1}});
      if (ids.empty()) break;
      Delete(c, "search_samples", {{"_id", {{"$in", ids}}}});
      samples -= count; bytes -= freed; evicted_samples += count; evicted_bytes += freed; removed = true;
    }
    if (removed) {
      ++eviction_runs;
      // Evidence of the evicted span is gone, so its coverage must not keep saying "sampled":
      // dropping the ranges turns them into unknown (never a false "nothing happened").
      for (const auto& [channel, newest] : horizon)
        Delete(c, "search_coverage", {{"channel", channel}, {"from", {{"$lte", newest}}}});
      cached_usage = Json();
      ++projection_revision;   // index exhausted-proofs are bound to the revision
    }
    return removed;
  }
  Json ReportUsage(Client& c) {
    const auto result=Command(c,{{"aggregate","search_migration_reports"},{"pipeline",Json::array({
      {{"$limit",1001}},{{"$group",{{"_id",nullptr},{"count",{{"$sum",1}}},{"bytes",{{"$sum",{{"$bsonSize","$$ROOT"}}}}}}}}
    })},{"cursor",Json::object()},{"maxTimeMS",5000}});
    const auto rows=result.at("cursor").at("firstBatch");
    report_usage=rows.empty()?Json{{"count",0},{"bytes",0}}:Json{{"count",rows[0].at("count")},{"bytes",rows[0].at("bytes")}};
    return report_usage;
  }
  void SaveReport(Client& c,const std::string& key,const std::string& job,int64_t generation,const std::string& actor,
      const MigrationCoverageDefinition& definition,const MigrationCoveragePass& pass,const bson_t* previous) {
    const auto envelope=pass.State();
    Bson doc({{"_id",key},{"job_id",job},{"generation",generation},{"actor",actor},
      {"payload_fingerprint",definition.payload_fingerprint},{"expires_at",Date(definition.expires_ms)},
      {"state_sha256",envelope.at("state_sha256")},{"state_json",envelope.dump()}});
    if(doc.value->len>512*1024)throw std::runtime_error("migration_report_capacity");
    const int64_t old_bytes=previous?previous->len:0;
    auto usage=report_usage.is_null()?ReportUsage(c):report_usage;
    const auto over=[&]{return usage.at("count").get<int64_t>()+(previous?0:1)>1000||
      usage.at("bytes").get<int64_t>()-old_bytes+doc.value->len>64LL*1024*1024;};
    if(over())usage=ReportUsage(c);
    if(over())throw std::runtime_error("migration_report_capacity");
    Bson options(Json{{"writeConcern",{{"w",1},{"j",true},{"wtimeout",5000}}}});
    auto collection=Collection(c,"search_migration_reports");bson_t reply;bson_error_t error{};bool ok=false;int64_t matched=1;
    if(previous){
      Bson filter({{"_id",key},{"generation",ExactInteger(previous,"generation")},{"state_sha256",Text(previous,"state_sha256")}});
      ok=mongoc_collection_replace_one(collection.get(),filter,doc,options,&reply,&error);
      bson_iter_t count;matched=bson_iter_init_find(&count,&reply,"matchedCount")?bson_iter_as_int64(&count):0;
    }else ok=mongoc_collection_insert_one(collection.get(),doc,options,&reply,&error);
    bson_destroy(&reply);
    if(!ok||matched!=1){report_usage=Json();if(!ok)Fail(error);throw std::runtime_error("migration_report_stale");}
    report_usage={{"count",usage.at("count").get<int64_t>()+(previous?0:1)},
      {"bytes",usage.at("bytes").get<int64_t>()-old_bytes+doc.value->len}};
  }
  SourceWriterTopology SourceTopology(Client&c){
    const auto hello=Command(c,{{"hello",1}});SourceWriterTopology out{source_connection_identity,"",false};
    if(source_single_host&&hello.value("isWritablePrimary",false)&&!hello.contains("setName")&&!hello.contains("hosts")&&
        !hello.contains("msg")&&!hello.contains("serviceId")&&hello.contains("topologyVersion")){
      try{out.process_id=hello.at("topologyVersion").at("processId").at("$oid").get<std::string>();out.standalone_verified=true;
        if(!ValidSourceWriterTopology(out)){out.process_id.clear();out.standalone_verified=false;}}
      catch(...){out.process_id.clear();out.standalone_verified=false;}
    }
    return out;
  }
  void SaveSourceMarker(Client&c,const SourceWriterEpoch&epoch,const bson_t*previous){
    if(!ValidSourceWriterOwner(epoch.owner_uuid)||!ValidSourceWriterTopology(epoch.topology))throw std::invalid_argument("invalid_source_writer_epoch");
    const auto payload=SourceWriterStateJson(epoch);
    Bson doc({{"_id",kSourceWriterMarker},{"state",payload},{"state_sha256",Sha(payload.dump())},{"mutation_nonce",SourceWriterNonce()}});
    if(doc.value->len>4096)throw std::runtime_error("source_writer_epoch_capacity");
    Bson options(Json{{"writeConcern",{{"w",1},{"j",true},{"wtimeout",5000}}}});
    auto collection=Collection(c,"search_control");bson_t reply;bson_error_t error{};bool ok=false;
    if(previous){
      const auto old=DecodeSourceWriterMarker(previous);
      Bson filter({{"_id",kSourceWriterMarker},{"state.owner_uuid",old.owner_uuid},{"state_sha256",Text(previous,"state_sha256")},
        {"mutation_nonce",Text(previous,"mutation_nonce")}});
      ok=mongoc_collection_replace_one(collection.get(),filter,doc,options,&reply,&error);
    }else ok=mongoc_collection_insert_one(collection.get(),doc,options,&reply,&error);
    const bool acknowledged=ok&&AcknowledgedSourceWriterReply(&reply,previous?"matchedCount":"insertedCount");
    bson_destroy(&reply);
    if(!ok)Fail(error);
    if(!acknowledged)throw std::runtime_error("source_writer_cas_unconfirmed");
  }
  // Called only under the existing writer mutex, after a source mutation has
  // actually been submitted. A socket/WC failure can still commit later. Latch
  // before attempting the best-effort persistent poison; never replace the
  // original write exception with a failed diagnostic/control write.
  void SourceWriteUnknown(Client&c) noexcept {
    if(source_local_owner.empty())return;
    source_local_unknown=true;
    try{
      const auto doc=One(c,"search_control",{{"_id",kSourceWriterMarker}});
      if(!doc)return;
      auto epoch=DecodeSourceWriterMarker(doc.get());
      if(epoch.owner_uuid!=source_local_owner)return;
      epoch.uncertainty=true;epoch.dirty=true;SaveSourceMarker(c,epoch,doc.get());
    }catch(...){/* durable dirty Begin and the local latch remain authoritative */}
  }
  bool Deleted(Client& c, const Record& r) {
    return bool(One(c, "search_deletions", {{"channel", r.channel}, {"from", {{"$lte", r.captured_ms}}},
      {"to", {{"$gt", r.captured_ms}}}, {"expires_at", {{"$gt", Date(Now())}}}}));
  }
  std::optional<Sample> VisibleSample(Client& c, const std::string& id, bool image) {
    auto doc = One(c, "search_samples", {{"_id", id}, {"expires_at", {{"$gt", Date(Now())}}}},
      image ? Json::object() : Json{{"projection", {{"jpeg", 0}}}});
    if (!doc) return std::nullopt;
    Record identity; identity.channel = Text(doc.get(), "channel"); identity.captured_ms = Number(doc.get(), "captured_ms");
    if (Deleted(c, identity)) return std::nullopt;
    return Decode(doc.get(), image);
  }
  std::map<std::string, Sample> VisibleSamples(Client& c, const Json& ids, const Scope& scope) {
    if(!ids.is_array()||ids.size()>180)throw std::invalid_argument("search_evidence_capacity");
    const auto deleted = DeletedRanges(c, scope); std::map<std::string, Sample> found;
    Each(c, "search_samples", {{"_id", {{"$in", ids}}}, {"expires_at", {{"$gt", Date(Now())}}}},
      {{"limit", 180}, {"projection", {{"jpeg", 0}}}}, [&](const bson_t* doc) {
        const auto channel = Text(doc, "channel"); const auto captured = Number(doc, "captured_ms");
        for (const auto& range : deleted) if (range.at("channel") == channel && range.at("from").get<int64_t>() <= captured && captured < range.at("to").get<int64_t>()) return;
        auto sample = Decode(doc, false); const auto id = sample.record.id;
        found.emplace(id, std::move(sample));
      });
    return found;
  }
  std::optional<Sample> OwnedSample(Client& c, const bson_t* session, const std::string& id, bool image) {
    const auto request = ReadSearchRequest(session);
    const auto row = ToJson(session);
    if (!row.contains("shortlist")) return std::nullopt;
    const auto shortlist = ReadShortlist(session); std::optional<std::string> fingerprint;
    for (const auto& slot : shortlist.at("slots"))
      if (slot.at("id") == id && slot.at("fingerprint").is_string()) fingerprint = slot.at("fingerprint").get<std::string>();
    if (!fingerprint) return std::nullopt;
    auto sample = VisibleSample(c, id, image);
    if (!sample || sample->fingerprint != *fingerprint) return std::nullopt;
    const auto& r = sample->record;
    if (r.model != request.model || !request.scope.channels.count(r.channel) || r.captured_ms < request.scope.from_ms || r.captured_ms >= request.scope.to_ms)
      throw std::runtime_error("search_session_scope_mismatch");
    return sample;
  }
  Doc Search(Client& c, const std::string& key) {
    return One(c, "search_sessions", {{"_id", key}, {"expires_at", {{"$gt", Date(Now())}}}});
  }
  void AdmitSearch(Client& c, const std::string& key) {
    Delete(c, "search_sessions", {{"_id", key}, {"expires_at", {{"$lte", Date(Now())}}}});
    Prune(c, "search_sessions");
    if (Count(c, "search_sessions") >= budget.max_searches) throw std::runtime_error("search_sessions_capacity");
  }
  Json DeletedRanges(Client& c, const Scope& scope) {
    Json out = Json::array(); const std::vector<std::string> channels(scope.channels.begin(), scope.channels.end());
    Each(c, "search_deletions", {{"channel", {{"$in", channels}}}, {"from", {{"$lt", scope.to_ms}}},
      {"to", {{"$gt", scope.from_ms}}}, {"expires_at", {{"$gt", Date(Now())}}}}, {{"limit", 2049}},
      [&](const bson_t* doc) { out.push_back({{"channel", Text(doc, "channel")}, {"from", Number(doc, "from")}, {"to", Number(doc, "to")}}); });
    if (out.size() > 2048) throw std::runtime_error("deletion_capacity");
    return out;
  }
};

HistoryMongo::HistoryMongo(const std::string& uri, const std::string& database, HistoryBudget budget): state_(std::make_unique<State>()) {
  static std::once_flag init; std::call_once(init, [] { mongoc_init(); });
  if (!std::regex_match(database, std::regex("^[A-Za-z0-9_-]{1,64}$")) || budget.max_samples < 1 || budget.max_samples > 1000000 ||
      budget.max_bytes < 1024 || budget.max_bytes > 1024LL * 1024 * 1024 * 1024 || budget.retention_ms < 1000 || budget.retention_ms > 365LL * 86400000 || budget.max_coverage < 1 || budget.max_coverage > 1000000 || budget.max_searches < 1 || budget.max_searches > 10000)
    throw std::invalid_argument("invalid_history_budget");
  bson_error_t error{};
  std::unique_ptr<mongoc_uri_t, decltype(&mongoc_uri_destroy)> parsed(mongoc_uri_new_with_error(uri.c_str(), &error), mongoc_uri_destroy);
  if (!parsed) throw std::invalid_argument("invalid_history_connection");
  mongoc_uri_set_option_as_int32(parsed.get(), MONGOC_URI_SERVERSELECTIONTIMEOUTMS, 3000);
  mongoc_uri_set_option_as_int32(parsed.get(), MONGOC_URI_CONNECTTIMEOUTMS, 3000);
  mongoc_uri_set_option_as_int32(parsed.get(), MONGOC_URI_SOCKETTIMEOUTMS, 6000);
  state_->pool = mongoc_client_pool_new(parsed.get());
  if (!state_->pool) throw std::runtime_error("history_pool_unavailable");
  mongoc_client_pool_max_size(state_->pool, 4);
  state_->database = database; state_->budget = budget;
  const auto* hosts=mongoc_uri_get_hosts(parsed.get());
  state_->source_single_host=hosts&&!hosts->next&&!mongoc_uri_get_replica_set(parsed.get())&&
    !mongoc_uri_get_srv_hostname(parsed.get())&&!mongoc_uri_get_option_as_bool(parsed.get(),MONGOC_URI_LOADBALANCED,false);
  state_->source_connection_identity=Sha(Json::array({"ainvr-source-writer-connection-v1",uri,database}).dump());
}
HistoryMongo::~HistoryMongo() = default;
SourceWriterTopology HistoryMongo::ReadSourceWriterTopology(){
  std::lock_guard<std::mutex>lock(state_->mutex);State::Client c(*state_);return state_->SourceTopology(c);
}
std::optional<SourceWriterEpoch> HistoryMongo::ReadSourceWriterEpoch(){
  std::lock_guard<std::mutex>lock(state_->mutex);State::Client c(*state_);
  const auto doc=state_->One(c,"search_control",{{"_id",kSourceWriterMarker}});
  return doc?std::optional<SourceWriterEpoch>(DecodeSourceWriterMarker(doc.get())):std::nullopt;
}
SourceWriterCommit HistoryMongo::BeginSourceWriterEpoch(const std::string&owner,SourceWriterBootstrap bootstrap,int64_t resume_after_ms){
  if(!ValidSourceWriterOwner(owner)||resume_after_ms<0||resume_after_ms>9007199254740991LL)
    throw std::invalid_argument("invalid_source_writer_epoch");
  std::lock_guard<std::mutex>lock(state_->mutex);State::Client c(*state_);
  const auto topology=state_->SourceTopology(c);
  const auto doc=state_->One(c,"search_control",{{"_id",kSourceWriterMarker}});
  auto previous=doc?std::optional<SourceWriterEpoch>(DecodeSourceWriterMarker(doc.get())):std::nullopt;
  const bool same_local_owner=state_->source_local_owner==owner;
  // A reconstructed owner cannot forget a previous object's volatile Unknown.
  // Real resumes choose a fresh UUID and inherit the persisted dirty marker.
  if(previous&&previous->owner_uuid==owner&&!same_local_owner)previous->previous_unclean=true;
  auto plan=PlanSourceWriterEpoch(previous,owner,topology,bootstrap);
  // Persistent uncertainty survives HTTP generations and process restarts.
  // Otherwise an old dispatched write with an already-scanned ordinal could
  // arrive after an exhausted scan and manufacture a complete negative.
  state_->projection_unsettled=state_->projection_unsettled||plan.next.uncertainty||plan.next.previous_unclean||!plan.migration_safe;
  plan.next.resume_after_ms=std::max(resume_after_ms,previous?previous->resume_after_ms:int64_t(0));
  if(!plan.next.dirty){state_->source_begin_durable=false;throw std::runtime_error("source_writer_resume_owner_required");}
  if(same_local_owner&&state_->source_local_unknown){plan.next.uncertainty=true;plan.migration_safe=false;plan.reason=SourceWriterReason::UnknownWrite;}
  state_->source_local_owner=owner;state_->source_begin_durable=false;
  if(!same_local_owner)state_->source_local_unknown=false;
  // If this write is Unknown, admission must stay closed. An explicit retry
  // reconciles the same owner with another actual nonce mutation and j ACK.
  state_->SaveSourceMarker(c,plan.next,doc.get());state_->source_begin_durable=true;state_->source_epoch_closed=false;
  state_->source_resume_after_ms=plan.next.resume_after_ms;
  return{plan.next,true,plan.migration_safe,plan.reason};
}
bool HistoryMongo::MarkSourceWriterUnknown(const std::string&owner){
  if(!ValidSourceWriterOwner(owner))throw std::invalid_argument("invalid_source_writer_epoch");
  std::lock_guard<std::mutex>lock(state_->mutex);
  if(state_->source_local_owner!=owner)return false;
  state_->source_local_unknown=true; // precedes every fallible Mongo operation
  State::Client c(*state_);const auto doc=state_->One(c,"search_control",{{"_id",kSourceWriterMarker}});
  if(!doc)return false;
  auto epoch=DecodeSourceWriterMarker(doc.get());if(epoch.owner_uuid!=owner)return false;
  epoch.uncertainty=true;epoch.dirty=true;state_->SaveSourceMarker(c,epoch,doc.get());return true;
}
SourceWriterCommit HistoryMongo::CleanSourceWriterEpoch(const std::string&owner,bool drained){
  if(!ValidSourceWriterOwner(owner))throw std::invalid_argument("invalid_source_writer_epoch");
  std::lock_guard<std::mutex>lock(state_->mutex);State::Client c(*state_);
  const auto doc=state_->One(c,"search_control",{{"_id",kSourceWriterMarker}});
  if(!doc)return {{owner,true,true,false,{state_->source_connection_identity,"",false}},false,false,SourceWriterReason::OwnerChanged};
  auto epoch=DecodeSourceWriterMarker(doc.get());
  if(state_->source_local_owner!=owner||!state_->source_begin_durable||epoch.owner_uuid!=owner)
    return{epoch,false,false,SourceWriterReason::OwnerChanged};
  auto reason=SourceWriterCleanReason(epoch,owner,drained,state_->source_local_unknown);
  // Re-read hello before claiming a safe standalone fence. A change of server
  // while an epoch was live needs a fresh Begin; a stored PID is not current.
  const auto topology=state_->SourceTopology(c);
  if(!topology.standalone_verified)reason=SourceWriterReason::TopologyUnverified;
  else if(topology.connection_identity!=epoch.topology.connection_identity||topology.process_id!=epoch.topology.process_id)
    reason=SourceWriterReason::PreviousUnclean;
  if(reason!=SourceWriterReason::None)return{epoch,false,false,reason};
  // Close locally before the fallible Clean submission. Its reply can be
  // Unknown after Mongo has persisted dirty=false; a late source must never
  // be accepted on that potentially-clean durable marker.
  state_->source_epoch_closed=true;
  epoch.dirty=false;state_->SaveSourceMarker(c,epoch,doc.get());
  return{epoch,true,true,SourceWriterReason::None};
}
void HistoryMongo::Initialize() {
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_);
  const auto marker=state_->One(c,"search_control",{{"_id",kSourceWriterMarker}});
  if(marker){const auto epoch=DecodeSourceWriterMarker(marker.get());
    state_->projection_unsettled=epoch.dirty||epoch.uncertainty||epoch.previous_unclean;}
  for (const auto* name : {"search_samples", "search_coverage", "search_deletions", "search_sessions", "search_verification_cache","search_migration_reports"}) {
    const auto info = state_->Command(c, {{"listCollections", 1}, {"filter", {{"name", name}}}});
    const auto entries = info.at("cursor").at("firstBatch");
    if (!entries.empty() && entries[0].value("options", Json::object()).value("capped", false))
      throw std::runtime_error("search_capped_collection_forbidden");
    state_->Command(c, {{"createIndexes", name}, {"indexes", Json::array({
      {{"key", {{"expires_at", 1}}}, {"name", "search_expiry"}, {"expireAfterSeconds", 0}}
    })}});
  }
  state_->Command(c, {{"createIndexes", "search_samples"}, {"indexes", Json::array({
    {{"key", {{"model", 1}, {"channel", 1}, {"captured_ms", 1}, {"ordinal", 1}}}, {"name", "search_projection"}},
    {{"key", {{"ordinal", 1}}}, {"name", "search_ordinal"}, {"unique", true}},
    {{"key", {{"captured_ms", 1}, {"ordinal", 1}}}, {"name", "search_evict_order"}},
    {{"key", {{"metadata.channel", 1}, {"metadata.processor", 1}, {"metadata.session", 1},
              {"metadata.track", 1}, {"metadata.model", 1}, {"metadata.scene", 1}}}, {"name", "search_track_identity"}}
  })}});
  state_->Command(c, {{"createIndexes", "search_samples"}, {"indexes", Json::array({
    {{"key", {{"metadata.channel", 1}, {"metadata.processor", 1}, {"metadata.session", 1},
              {"metadata.track", 1}, {"metadata.model", 1}, {"track_slot", 1}}},
     {"name", "search_track_slot"}, {"unique", true}, {"partialFilterExpression", {{"track_slot", {{"$exists", true}}}}}}
  })}});
  nlohmann::ordered_json verification_index;
  verification_index["key"] = nlohmann::ordered_json{{"created_ms", -1}, {"_id", -1}};
  verification_index["name"] = "search_verification_scan";
  state_->Command(c, {{"createIndexes", "search_sessions"}, {"indexes", nlohmann::ordered_json::array({verification_index})}});
  state_->Command(c, {{"createIndexes", "search_deletions"}, {"indexes", Json::array({
    {{"key", {{"channel", 1}, {"from", 1}, {"to", 1}}}, {"name", "search_deleted_ranges"}}
  })}});
}
void HistoryMongo::Put(const Sample& sample) {
  if (sample.track_slot) throw std::invalid_argument("search_slot_api_required");
  WriteSample(sample, std::nullopt, "", "");
}
std::string HistoryMongo::ReplaceTrackSlot(const Sample& sample, size_t slot,
                                          const std::string& expected_fingerprint,
                                          const std::string& replacement_token) {
  static const std::regex fingerprint("^[0-9a-f]{64}$");
  if (slot >= 8 || sample.record.scene || (sample.track_slot && *sample.track_slot != slot) ||
      (!expected_fingerprint.empty() && !std::regex_match(expected_fingerprint, fingerprint)) ||
      replacement_token.empty() || replacement_token.size() > 128)
    throw std::invalid_argument("invalid_search_slot_request");
  ai_service::output::EvidenceIdentity(replacement_token);
  return WriteSample(sample, slot, expected_fingerprint, replacement_token);
}
std::string HistoryMongo::WriteSample(const Sample& sample, std::optional<size_t> slot,
                                     const std::string& expected_fingerprint,
                                     const std::string& replacement_token,const HistoryMetadataRow* migration_source) {
  const auto& r = sample.record; const auto now = Now(); Uuid(r.id); Uuid(r.channel);
  VectorIndex validator(r.model, r.vector.size(), 1); validator.Upsert(r);
  if (!sample.evidence.is_object() || sample.evidence.dump().size() > 16384 || r.model.size() > 128 ||
      r.captured_ms > now + 60000 || sample.expires_ms <= std::max(now, r.captured_ms) ||
      (!migration_source&&sample.expires_ms > r.captured_ms + state_->budget.retention_ms) ||
      sample.jpeg.size() < 4 || sample.jpeg.size() > 8 * 1024 * 1024 || sample.jpeg[0] != 255 || sample.jpeg[1] != 216 ||
      sample.jpeg[sample.jpeg.size()-2] != 255 || sample.jpeg.back() != 217)
    throw std::invalid_argument("invalid_search_sample");
  const auto& evidence = sample.evidence;
  Uuid(evidence.at("source_input_id").get<std::string>()); Uuid(evidence.at("frame_id").get<std::string>());
  for (const auto* field : {"output_channel_id", "recording_channel_id"}) {
    if (!evidence.at(field).is_null()) Uuid(evidence.at(field).get<std::string>());
  }
  using ai_service::output::EvidenceIdentity;
  using ai_service::output::EvidenceInteger;
  EvidenceIdentity(r.session);
  EvidenceInteger(evidence.at("source_pts_ns").get<std::string>());
  EvidenceInteger(evidence.at("source_frame_index").get<std::string>());
  if (evidence.at("schema_version") != "1.0" || evidence.at("stream_session_id") != r.session)
    throw std::invalid_argument("invalid_search_frame_identity");
  const auto role = evidence.at("role").get<std::string>();
  if (!evidence.at("frame_width").is_number_integer() || !evidence.at("frame_height").is_number_integer() ||
      evidence.at("frame_width") < 1 || evidence.at("frame_height") < 1 || evidence.at("frame_width") > 16384 || evidence.at("frame_height") > 16384 ||
      (role != "match" && role != "before" && role != "after" && role != "context"))
    throw std::invalid_argument("invalid_search_evidence_identity");
  const auto digest = ComputeSampleContractDigest(sample);
  const auto& metadata = digest.metadata; const auto& vector = digest.vector_bytes;
  const auto& metaSha = digest.metadata_sha; const auto& vectorSha = digest.vector_sha; const auto& jpegSha = digest.jpeg_sha;
  const auto& fingerprint = digest.fingerprint;
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_);
  if(!migration_source&&!state_->source_local_owner.empty()&&
      (!state_->source_begin_durable||state_->source_epoch_closed))
    throw std::runtime_error("source_writer_closed");
  if(!migration_source&&r.captured_ms<state_->source_resume_after_ms)
    throw std::runtime_error("source_frame_before_resume");
  ++state_->projection_revision;
  // The pre-lock check may have waited behind another operation. Never
  // dispatch a sample which expired while waiting for the writer lock.
  if(sample.expires_ms<=Now())throw std::runtime_error("search_slot_expired");
  if(migration_source) {
    const auto& source=migration_source->sample;const auto& old=source.record;
    if(migration_source->ordinal<1||sample.record.model==old.model||sample.record.channel!=old.channel||
        sample.record.processor!=old.processor||sample.record.session!=old.session||sample.record.track!=old.track||
        sample.record.captured_ms!=old.captured_ms||sample.record.scene!=old.scene||sample.track_slot!=source.track_slot||
        sample.expires_ms!=source.expires_ms||digest.jpeg_sha!=migration_source->jpeg_sha256)
      throw std::runtime_error("migration_source_changed");
    const auto current=state_->One(c,"search_samples",{{"_id",old.id},{"model",old.model},{"fingerprint",source.fingerprint},
      {"ordinal",migration_source->ordinal},{"expires_at",{{"$gt",Date(Now())}}}},{{"projection",MetadataProjection()}});
    if(!current)throw std::runtime_error("migration_source_changed");
    const auto metadata=CheckedMetadata(current.get());const auto actual=DecodeMetadata(current.get(),metadata);
    if(ExactInteger(current.get(),"ordinal")!=migration_source->ordinal||actual.track_slot!=source.track_slot||
        actual.expires_ms<=Now()||actual.expires_ms!=source.expires_ms||actual.record.captured_ms!=old.captured_ms||
        actual.evidence!=source.evidence||Text(current.get(),"jpeg_sha")!=migration_source->jpeg_sha256||state_->Deleted(c,actual.record))
      throw std::runtime_error("migration_source_changed");
  }
  if (state_->Deleted(c, r)) throw std::runtime_error("search_sample_deleted");
  auto old = state_->One(c, "search_samples", {{"_id", r.id}});
  int64_t old_bytes = 0;
  if (old) {
    const auto previous = Decode(old.get(), true);
    // Migration is immutable per original evidence and target space. A fresh
    // BPU encode after a lost response may differ numerically; a fully valid
    // same-metadata/JPEG result wins without replacement or a new ordinal.
    // Ordinary producer retransmissions retain strict body fingerprints.
    if(migration_source&&previous.track_slot==slot&&previous.expires_ms>Now()&&
        CheckedMetadata(old.get())==metadata&&Text(old.get(),"jpeg_sha")==jpegSha)
      return previous.fingerprint;
    if (!slot) {
      if (previous.fingerprint != fingerprint) throw std::runtime_error("search_sample_conflict");
      return fingerprint;
    }
    const auto& before = previous.record;
    if (state_->Deleted(c, before)) throw std::runtime_error("search_sample_deleted");
    if (previous.track_slot != slot || before.channel != r.channel || before.processor != r.processor ||
        before.session != r.session || before.track != r.track || before.model != r.model || before.scene ||
        previous.evidence.at("source_input_id") != evidence.at("source_input_id") ||
        previous.evidence.at("output_channel_id") != evidence.at("output_channel_id") ||
        previous.evidence.at("recording_channel_id") != evidence.at("recording_channel_id") ||
        previous.evidence.value("input_path", Json()) != evidence.value("input_path", Json()) ||
        previous.evidence.value("output_path", Json()) != evidence.value("output_path", Json()))
      throw std::runtime_error("search_slot_identity_conflict");
    if (Text(old.get(), "replacement_token") == replacement_token) {
      if (previous.fingerprint != fingerprint) throw std::runtime_error("search_slot_token_conflict");
      if (previous.expires_ms <= now) throw std::runtime_error("search_slot_expired");
      return fingerprint; // An acknowledged write may have lost its reply.
    }
    if (expected_fingerprint.empty() || previous.fingerprint != expected_fingerprint)
      throw std::runtime_error("search_slot_conflict");
    if (previous.expires_ms <= now) throw std::runtime_error("search_slot_expired");
    if (previous.evidence.at("frame_id") == evidence.at("frame_id") || r.captured_ms < before.captured_ms ||
        std::stoll(evidence.at("source_pts_ns").get<std::string>()) <= std::stoll(previous.evidence.at("source_pts_ns").get<std::string>()) ||
        std::stoll(evidence.at("source_frame_index").get<std::string>()) <= std::stoll(previous.evidence.at("source_frame_index").get<std::string>()))
      throw std::invalid_argument("search_slot_frame_not_newer");
    old_bytes = Number(old.get(), "bytes");
  } else if (slot && !expected_fingerprint.empty()) {
    throw std::runtime_error("search_slot_conflict");
  }
  state_->Prune(c, "search_samples"); auto usage = state_->CachedUsage(c);
  if (!old) {
    if (!r.scene) {
      // Ordinary immutable producers share the same object budget. They cannot
      // bypass the eight-slot bound by writing extra UUIDs outside this API.
      size_t count = 0;
      state_->Each(c, "search_samples", {{"metadata.channel", r.channel}, {"metadata.processor", r.processor},
        {"metadata.session", r.session}, {"metadata.track", r.track}, {"metadata.model", r.model},
        {"metadata.scene", false}},
        {{"limit", 8}, {"projection", {{"_id", 1}}}}, [&](const bson_t*) { ++count; });
      if (count >= 8) throw std::runtime_error("search_track_capacity");
    }
    if (usage.at("samples").get<int64_t>() >= state_->budget.max_samples) usage = state_->Usage(c);
    if (usage.at("samples").get<int64_t>() >= state_->budget.max_samples) {
      if (migration_source || !state_->EvictOldest(c, 0)) throw std::runtime_error("search_history_capacity");
      usage = state_->Usage(c);
      if (usage.at("samples").get<int64_t>() >= state_->budget.max_samples) throw std::runtime_error("search_history_capacity");
    }
  }
  const auto sequence = state_->Command(c, {{"findAndModify", "search_control"}, {"query", {{"_id", "sequence"}}},
    {"update", {{"$inc", {{"value", 1}}}}}, {"upsert", true}, {"new", true}, {"writeConcern", {{"w", 1}, {"j", true}}}});
  Bson doc({{"_id", r.id}, {"channel", r.channel}, {"model", r.model}, {"captured_ms", r.captured_ms},
    {"metadata", metadata}, {"fingerprint", fingerprint}, {"metadata_sha", metaSha}, {"vector_sha", vectorSha}, {"jpeg_sha", jpegSha},
    {"ordinal", sequence.at("value").at("value")}, {"expires_at", Date(sample.expires_ms)}, {"bytes", {{"$numberLong", "0"}}}});
  if (slot) {
    BSON_APPEND_INT32(doc.value, "track_slot", static_cast<int32_t>(*slot));
    BSON_APPEND_UTF8(doc.value, "replacement_token", replacement_token.c_str());
  }
  BSON_APPEND_BINARY(doc.value, "vector", BSON_SUBTYPE_BINARY, vector.data(), vector.size());
  BSON_APPEND_BINARY(doc.value, "jpeg", BSON_SUBTYPE_BINARY, sample.jpeg.data(), sample.jpeg.size());
  if (usage.at("bytes").get<int64_t>() - old_bytes + doc.value->len > state_->budget.max_bytes) usage = state_->Usage(c);
  if (usage.at("bytes").get<int64_t>() - old_bytes + doc.value->len > state_->budget.max_bytes) {
    if (migration_source || !state_->EvictOldest(c, doc.value->len)) throw std::runtime_error("search_history_capacity");
    usage = state_->Usage(c);
    if (usage.at("bytes").get<int64_t>() - old_bytes + doc.value->len > state_->budget.max_bytes) throw std::runtime_error("search_history_capacity");
  }
  bson_iter_t bytes; bson_iter_init_find(&bytes, doc.value, "bytes"); bson_iter_overwrite_int64(&bytes, doc.value->len);
  auto collection = state_->Collection(c, "search_samples"); Bson opts(Json{{"writeConcern", {{"w", 1}, {"j", true}, {"wtimeout", 5000}}}});
  bson_error_t error{}; bson_t reply; bool ok; bool known_zero_match=false;
  if (old) {
    Bson filter({{"_id", r.id}, {"fingerprint", expected_fingerprint}});
    ok = mongoc_collection_replace_one(collection.get(), filter, doc, opts, &reply, &error);
    bson_iter_t count;
    known_zero_match=bson_iter_init_find(&count,&reply,"matchedCount")&&
      (BSON_ITER_HOLDS_INT32(&count)||BSON_ITER_HOLDS_INT64(&count))&&bson_iter_as_int64(&count)==0;
  } else {
    ok = mongoc_collection_insert_one(collection.get(), doc, opts, &reply, &error);
  }
  const bool acknowledged=ok&&AcknowledgedSourceWriterReply(&reply,old?"matchedCount":"insertedCount");
  bool reply_error=false;
  for(const auto*field:{"writeConcernError","writeConcernErrors","writeErrors"}){
    bson_iter_t detail;if(bson_iter_init_find(&detail,&reply,field))reply_error=true;
  }
  // A known zero-match CAS is a rejection. Every other unconfirmed dispatched
  // source write is Unknown, even if a later metadata read can see its result.
  const bool rejected=ok&&!reply_error&&old&&known_zero_match;
  bson_destroy(&reply);
  if (!acknowledged) {
    if(!rejected)state_->projection_unsettled=true;
    state_->cached_usage = Json();
    if(!migration_source&&!rejected)state_->SourceWriteUnknown(c);
    if (!ok) Fail(error);
    throw std::runtime_error(rejected?"search_slot_conflict":"source_write_unconfirmed");
  }
  state_->cached_usage = {{"samples", usage.at("samples").get<int64_t>() + (old ? 0 : 1)},
                         {"bytes", usage.at("bytes").get<int64_t>() - old_bytes + doc.value->len}};
  return fingerprint;
}
std::optional<Sample> HistoryMongo::Get(const std::string& id, bool include_image) {
  Uuid(id); std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_);
  return state_->VisibleSample(c, id, include_image);
}
HistoryStamp HistoryMongo::ProjectionStamp() {
  std::lock_guard<std::mutex> lock(state_->mutex);
  return {state_->projection_revision,!state_->projection_unsettled&&!state_->source_local_unknown};
}
std::map<std::string,Sample> HistoryMongo::ReadVisibleSamples(const std::string& model,
    const Scope& scope,const std::vector<std::string>& ids) {
  Range(scope);if(ids.size()>100)throw std::invalid_argument("search_evidence_capacity");
  for(const auto& id:ids)Uuid(id);
  std::lock_guard<std::mutex> lock(state_->mutex);State::Client c(*state_);
  auto rows=state_->VisibleSamples(c,ids,scope);
  for(auto it=rows.begin();it!=rows.end();) {
    const auto& r=it->second.record;
    if(r.model!=model||!scope.channels.count(r.channel)||r.captured_ms<scope.from_ms||r.captured_ms>=scope.to_ms)
      it=rows.erase(it);else ++it;
  }
  return rows;
}
std::map<std::string, std::string> HistoryMongo::ReadVisibleFingerprints(const std::string& model,
    const std::vector<std::string>& ids) {
  if (model.empty() || model.size() > 128 || ids.size() > 64)
    throw std::invalid_argument("invalid_history_visibility_batch");
  std::set<std::string> unique;
  for (const auto& id : ids) { Uuid(id); if (!unique.insert(id).second) throw std::invalid_argument("duplicate_history_identity"); }
  std::map<std::string, std::string> out;
  if (ids.empty()) return out;
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_);
  struct Metadata { std::string id, channel, fingerprint; int64_t at; };
  std::vector<Metadata> rows; rows.reserve(ids.size());
  Scope window; window.from_ms = INT64_MAX;
  state_->Each(c, "search_samples", {{"_id", {{"$in", ids}}}, {"model", model}, {"expires_at", {{"$gt", Date(Now())}}}},
    {{"limit", ids.size()}, {"projection", {{"jpeg", 0}, {"vector", 0}}}}, [&](const bson_t* doc) {
      const auto meta = CheckedMetadata(doc);
      const auto channel = meta.at("channel").get<std::string>(); const auto at = meta.at("captured_ms").get<int64_t>();
      Uuid(channel);
      if (at < 0 || at == INT64_MAX) throw std::runtime_error("history_metadata_integrity");
      window.channels.insert(channel); window.from_ms = std::min(window.from_ms, at); window.to_ms = std::max(window.to_ms, at + 1);
      rows.push_back({meta.at("id"), channel, Text(doc, "fingerprint"), at});
    });
  if (rows.empty()) return out;
  // Same bounded deletion-intent contract as search sessions: at most 2048
  // ranges for this batch, never a per-row query or an unbounded history scan.
  const auto deleted = state_->DeletedRanges(c, window);
  for (const auto& row : rows) {
    bool hidden = false;
    for (const auto& range : deleted)
      if (range.at("channel") == row.channel && range.at("from").get<int64_t>() <= row.at && row.at < range.at("to").get<int64_t>()) {
        hidden = true; break;
      }
    if (!hidden) out.emplace(row.id, row.fingerprint);
  }
  return out;
}
TrackSlotReceipt HistoryMongo::ReadTrackSlotReceipt(const Sample& sample, size_t slot,
    const std::string& token, const std::string& request_fingerprint) {
  return ReadReceipt(sample, slot, token, request_fingerprint);
}
TrackSlotReceipt HistoryMongo::ReadSceneReceipt(const Sample& sample, const std::string& request_fingerprint) {
  return ReadReceipt(sample, std::nullopt, "", request_fingerprint);
}
TrackSlotReceipt HistoryMongo::ReadReceipt(const Sample& sample, std::optional<size_t> slot,
    const std::string& token, const std::string& request_fingerprint) {
  using Status = TrackSlotReceiptState;
  const auto& r = sample.record; const auto& e = sample.evidence; const auto now = Now();
  static const std::regex fingerprint("^[0-9a-f]{64}$");
  Uuid(r.id); Uuid(r.channel);
  if ((slot ? (*slot >= 8 || r.scene || (sample.track_slot && *sample.track_slot != *slot) ||
          r.processor.empty() || r.track.empty() || token.empty() || token.size() > 128) :
          (!r.scene || sample.track_slot || !token.empty())) || !r.vector.empty() || !sample.jpeg.empty() ||
      !e.is_object() || e.dump().size() > 16384 ||
      r.model.empty() || r.model.size() > 128 || r.processor.size() > 256 ||
      r.session.empty() || r.session.size() > 256 || r.track.size() > 256 ||
      r.captured_ms < 0 || r.captured_ms > now + 60000 || sample.expires_ms <= r.captured_ms ||
      sample.expires_ms > r.captured_ms + 365LL * 86400000 ||
      !std::regex_match(request_fingerprint, fingerprint)) throw std::invalid_argument("invalid_search_receipt");
  using ai_service::output::EvidenceIdentity; using ai_service::output::EvidenceInteger;
  for (const auto* id : {&r.model, &r.processor, &r.session, &r.track, &token})
    if (!id->empty()) EvidenceIdentity(*id);
  for (const auto* field : {"source_input_id", "output_channel_id", "recording_channel_id", "frame_id"}) Uuid(e.at(field).get<std::string>());
  EvidenceInteger(e.at("source_pts_ns").get<std::string>()); EvidenceInteger(e.at("source_frame_index").get<std::string>());
  if (e.at("schema_version") != "1.0" || e.at("stream_session_id") != r.session || e.at("output_channel_id") != r.channel ||
      !e.at("frame_width").is_number_integer() || !e.at("frame_height").is_number_integer() ||
      e.at("frame_width") < 1 || e.at("frame_width") > 16384 || e.at("frame_height") < 1 || e.at("frame_height") > 16384)
    throw std::invalid_argument("invalid_search_receipt_frame");
  for (const auto* field : {"input_path", "output_path", "role"}) EvidenceIdentity(e.at(field).get<std::string>());
  if (e.at("role") != "match" && e.at("role") != "before" && e.at("role") != "after" && e.at("role") != "context")
    throw std::invalid_argument("invalid_search_receipt_role");
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_);
  auto doc = state_->One(c, "search_samples", {{"_id", r.id}}, {{"projection", {{"jpeg", 0}, {"vector", 0}}}});
  if (!doc) {
    if (state_->Deleted(c, r)) return {Status::Deleted};
    // TTL may already have removed the row. This only says the requested
    // lifetime is over; it does not assert that the write ever committed.
    return {sample.expires_ms <= now ? Status::Expired : Status::NotFound};
  }
  const auto meta = CheckedMetadata(doc.get());
  const auto actual = Text(doc.get(), "fingerprint");
  bson_iter_t it;
  const bool has_slot = bson_iter_init_find(&it, doc.get(), "track_slot");
  if ((slot ? (!has_slot || (!BSON_ITER_HOLDS_INT32(&it) && !BSON_ITER_HOLDS_INT64(&it)) ||
          bson_iter_as_int64(&it) != int64_t(*slot)) : has_slot) ||
      meta.at("scene") != r.scene || meta.at("channel") != r.channel || meta.at("processor") != r.processor ||
      meta.at("session") != r.session || meta.at("track") != r.track || meta.at("model") != r.model)
    return {Status::ScopeMismatch};
  const auto& stored = meta.at("evidence");
  for (const auto* field : {"source_input_id", "output_channel_id", "recording_channel_id", "input_path", "output_path"})
    if (stored.at(field) != e.at(field)) return {Status::ScopeMismatch};
  // Only after exact ownership do we expose lifecycle state; no other source's
  // fingerprint, expiry, token, metadata, image or vector leaves this method.
  Record identity; identity.channel = r.channel; identity.captured_ms = meta.at("captured_ms");
  if (state_->Deleted(c, r) || state_->Deleted(c, identity)) return {Status::Deleted};
  if (sample.expires_ms <= now || DateValue(doc.get(), "expires_at") <= now) return {Status::Expired};
  if (slot && Text(doc.get(), "replacement_token") != token) return {Status::Replaced};
  if (meta.at("captured_ms") != r.captured_ms || meta.at("expires_ms") != sample.expires_ms) return {Status::WriteMismatch};
  for (const auto* field : {"frame_id", "schema_version", "stream_session_id", "source_pts_ns", "source_frame_index", "frame_width", "frame_height", "role"})
    if (stored.at(field) != e.at(field)) return {Status::WriteMismatch};
  auto requested_metadata = SampleStorageMetadata(sample);
  // Receipts intentionally omit vector bytes. Its declared dimension is bound
  // by the stored digest; all other metadata must match the frozen request.
  requested_metadata["dimensions"] = meta.at("dimensions");
  if (requested_metadata != meta || actual != request_fingerprint) return {Status::WriteMismatch};
  return {Status::Committed, actual};
}
HistoryBatch HistoryMongo::Scan(const std::string& model, const Scope& scope, int64_t after, size_t limit) {
  Range(scope); if (model.empty() || model.size() > 128 || after < 0 || limit < 1 || limit > 1000) throw std::invalid_argument("invalid_history_page");
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_); HistoryBatch out; out.checkpoint = after;
  const auto deleted = state_->DeletedRanges(c, scope);
  const std::vector<std::string> channels(scope.channels.begin(), scope.channels.end());
  size_t visited=0;
  state_->Each(c, "search_samples", {{"model", model}, {"channel", {{"$in", channels}}},
    {"captured_ms", {{"$gte", scope.from_ms}, {"$lt", scope.to_ms}}}, {"ordinal", {{"$gt", after}}}, {"expires_at", {{"$gt", Date(Now())}}}},
    {{"sort", {{"ordinal", 1}}}, {"limit", limit}, {"projection", {{"jpeg", 0}}}}, [&](const bson_t* doc) {
      ++visited;out.checkpoint = Number(doc, "ordinal");
      const auto channel = Text(doc, "channel"); const auto captured = Number(doc, "captured_ms");
      for (const auto& range : deleted)
        if (range.at("channel") == channel && range.at("from").get<int64_t>() <= captured && range.at("to").get<int64_t>() > captured) return;
      out.samples.push_back(Decode(doc, false));
    });
  out.exhausted=visited<limit;
  out.stamp={state_->projection_revision,!state_->projection_unsettled&&!state_->source_local_unknown};
  return out;
}
bool HistoryMongo::ModelSpaceCompatible(const std::string& model) {
  if(model.empty()||model.size()>128)throw std::invalid_argument("invalid_history_model");
  std::lock_guard<std::mutex> lock(state_->mutex);State::Client c(*state_);
  // Deletion intents are removed physically by the ordinary delete path; a
  // retained interrupted-delete row errs toward requiring explicit migration.
  const auto foreign=state_->One(c,"search_samples",{{"model",{{"$ne",model}}},
    {"expires_at",{{"$gt",Date(Now())}}}},{{"projection",{{"_id",1}}}});
  return !foreign;
}
int64_t HistoryMongo::MetadataWatermark(const std::string& model,const Scope& scope) {
  Range(scope);if(model.empty()||model.size()>128)throw std::invalid_argument("invalid_history_model");
  std::lock_guard<std::mutex> lock(state_->mutex);State::Client c(*state_);int64_t result=0;
  const std::vector<std::string> channels(scope.channels.begin(),scope.channels.end());
  state_->Each(c,"search_samples",{{"model",model},{"channel",{{"$in",channels}}},
    {"captured_ms",{{"$gte",scope.from_ms},{"$lt",scope.to_ms}}},{"expires_at",{{"$gt",Date(Now())}}}},
    {{"sort",{{"ordinal",-1}}},{"limit",1},{"projection",{{"ordinal",1}}}},[&](const bson_t* doc){
      result=ExactInteger(doc,"ordinal");if(result<1)throw std::runtime_error("history_metadata_integrity");});
  return result;
}
Json HistoryMongo::MetadataExtent(const std::string& model,const std::set<std::string>& selected) {
  if(model.empty()||model.size()>128||selected.empty()||selected.size()>1024)
    throw std::invalid_argument("invalid_history_extent");
  for(const auto& channel:selected)Uuid(channel);
  std::lock_guard<std::mutex> lock(state_->mutex);State::Client c(*state_);
  const std::vector<std::string> channels(selected.begin(),selected.end());
  const Json query={{"model",model},{"channel",{{"$in",channels}}},{"expires_at",{{"$gt",Date(Now())}}}};
  const auto boundary=[&](const char* field,int direction){
    std::optional<int64_t> value;size_t examined=0;
    state_->Each(c,"search_samples",query,{{"sort",{{field,direction}}},{"limit",257},
      {"projection",{{"channel",1},{"captured_ms",1},{"ordinal",1}}}},[&](const bson_t* doc){
        if(value)return;
        if(++examined>256)throw std::runtime_error("history_metadata_capacity");
        Record identity;identity.channel=Text(doc,"channel");identity.captured_ms=ExactInteger(doc,"captured_ms");
        if(!selected.count(identity.channel)||identity.captured_ms<0||identity.captured_ms>=9007199254740991LL)
          throw std::runtime_error("history_metadata_integrity");
        if(state_->Deleted(c,identity))return;
        const auto ordinal=ExactInteger(doc,"ordinal");if(ordinal<1)throw std::runtime_error("history_metadata_integrity");
        value=std::string(field)=="ordinal"?ordinal:identity.captured_ms;
      });
    return value;
  };
  const auto first=boundary("captured_ms",1),last=boundary("captured_ms",-1),watermark=boundary("ordinal",-1);
  if(bool(first)!=bool(last)||bool(first)!=bool(watermark))throw std::runtime_error("history_metadata_scope_changed");
  return {{"source_model",model},{"from_ms",first?Json(*first):Json(nullptr)},
    {"to_ms",last?Json(*last+1):Json(nullptr)},{"high_watermark",std::to_string(watermark.value_or(0))}};
}
HistoryMetadataBatch HistoryMongo::ScanMetadata(const std::string& model,const Scope& scope,
    int64_t after,int64_t through,size_t limit) {
  Range(scope);if(model.empty()||model.size()>128||after<0||through<after||limit<1||limit>32)
    throw std::invalid_argument("invalid_history_metadata_page");
  std::lock_guard<std::mutex> lock(state_->mutex);State::Client c(*state_);
  HistoryMetadataBatch out;out.checkpoint=after;
  const auto deleted=state_->DeletedRanges(c,scope);
  const std::vector<std::string> channels(scope.channels.begin(),scope.channels.end());
  size_t read=0,bytes=0;bool full=false;
  state_->Each(c,"search_samples",{{"model",model},{"channel",{{"$in",channels}}},
    {"captured_ms",{{"$gte",scope.from_ms},{"$lt",scope.to_ms}}},{"ordinal",{{"$gt",after},{"$lte",through}}},
    {"expires_at",{{"$gt",Date(Now())}}}},
    {{"sort",{{"ordinal",1}}},{"limit",limit},{"projection",MetadataProjection()}},[&](const bson_t* doc){
      ++read;if(full)return;
      const auto meta=CheckedMetadata(doc);const auto ordinal=ExactInteger(doc,"ordinal");
      if(ordinal<=out.checkpoint||ordinal>through)throw std::runtime_error("history_metadata_integrity");
      auto sample=DecodeMetadata(doc,meta);const auto& r=sample.record;
      bool hidden=sample.expires_ms<=Now();
      for(const auto& range:deleted)if(range.at("channel")==r.channel&&range.at("from").get<int64_t>()<=r.captured_ms&&
          r.captured_ms<range.at("to").get<int64_t>())hidden=true;
      if(hidden){out.checkpoint=ordinal;return;}
      // Half of the HTTP metadata limit leaves a deterministic envelope margin.
      const auto cost=meta.dump().size()+1024;
      if(cost>128*1024)throw std::runtime_error("history_metadata_capacity");
      if(bytes+cost>128*1024){full=true;return;}
      const auto jpeg_sha=Text(doc,"jpeg_sha");
      if(!std::regex_match(jpeg_sha,std::regex("[a-f0-9]{64}")))throw std::runtime_error("history_metadata_integrity");
      out.items.push_back(MetadataRow(doc,meta,std::move(sample)));bytes+=cost;out.checkpoint=ordinal;
    });
  out.exhausted=!full&&(read<limit||out.checkpoint>=through);
  return out;
}
std::optional<Sample> HistoryMongo::ReencodeImage(const std::string& id,const std::string& fingerprint,
    const std::string& model,const Scope& scope) {
  auto row=ReadReencodeSource(id,fingerprint,model,scope);
  if(!row)return {};
  return std::move(row->sample);
}
std::optional<HistoryMetadataRow> HistoryMongo::ReadReencodeSource(const std::string& id,const std::string& fingerprint,
    const std::string& model,const Scope& scope,bool include_image) {
  Uuid(id);Range(scope);if(model.empty()||model.size()>128||!std::regex_match(fingerprint,std::regex("[a-f0-9]{64}")))
    throw std::invalid_argument("invalid_reencode_image");
  std::lock_guard<std::mutex> lock(state_->mutex);State::Client c(*state_);
  auto doc=state_->One(c,"search_samples",{{"_id",id},{"model",model},{"fingerprint",fingerprint},
    {"expires_at",{{"$gt",Date(Now())}}}},{{"projection",MetadataProjection(include_image)}});
  if(!doc)return {};
  auto sample=DecodeMetadata(doc.get(),CheckedMetadata(doc.get()));const auto& r=sample.record;
  if(sample.expires_ms<=Now()||!scope.channels.count(r.channel)||r.captured_ms<scope.from_ms||r.captured_ms>=scope.to_ms||state_->Deleted(c,r))return {};
  if(include_image) {
    sample.jpeg=Binary(doc.get(),"jpeg");
    if(Text(doc.get(),"jpeg_sha")!=Sha(sample.jpeg.data(),sample.jpeg.size()))
      throw std::runtime_error("history_image_integrity");
  }
  if(sample.expires_ms<=Now())return {};
  const auto ordinal=ExactInteger(doc.get(),"ordinal");if(ordinal<1)throw std::runtime_error("history_metadata_integrity");
  return MetadataRow(doc.get(),CheckedMetadata(doc.get()),std::move(sample));
}
std::string HistoryMongo::WriteReencodedSample(const Sample& target,const HistoryMetadataRow& source) {
  std::string expected;
  if(target.track_slot) {
    const auto current=ReadVisibleFingerprints(target.record.model,{target.record.id});
    const auto found=current.find(target.record.id);if(found!=current.end())expected=found->second;
  }
  return WriteSample(target,target.track_slot,expected,target.track_slot?source.sample.fingerprint:std::string{},&source);
}
namespace {
std::string ReportKey(const std::string& job,int64_t generation,const std::string& actor,const MigrationCoverageDefinition& definition){
  migration_authorization::Uuid(job);migration_authorization::Text(actor,256);
  if(generation<1||generation>9007199254740991LL||definition.expires_ms<=Now()||definition.expires_ms>Now()+7LL*86400000)
    throw std::invalid_argument("invalid_migration_report_identity");
  return SampleStorageUuid("ainvr-search-migration-report-v1",Json::array({job,definition.payload_fingerprint}));
}
Json CoverageStatus(const MigrationCoveragePass& pass){
  const auto state=pass.State().at("state");
  return{{"state",pass.Complete()?"complete":"building"},{"checkpoint",std::to_string(pass.Checkpoint())},
    {"target_checkpoint",state.at("target_checkpoint")},
    {"coverage_snapshot",{{"required",state.at("required")},{"matched",state.at("matched")},{"unavailable",state.at("unavailable")}}},
    {"coverage_sha256",pass.Complete()?state.at("coverage_sha256"):Json(nullptr)}};
}
MigrationCoveragePass StoredCoverage(const bson_t* doc,const std::string& job,int64_t generation,
    const std::string& actor,const MigrationCoverageDefinition& definition){
  if(!doc||Text(doc,"job_id")!=job||ExactInteger(doc,"generation")!=generation||Text(doc,"actor")!=actor||
      Text(doc,"payload_fingerprint")!=definition.payload_fingerprint||DateValue(doc,"expires_at")!=definition.expires_ms)
    throw std::runtime_error("migration_report_stale");
  const auto text=Text(doc,"state_json");if(text.size()>512*1024)throw std::runtime_error("migration_report_capacity");
  const auto envelope=Json::parse(text);
  if(envelope.at("state_sha256")!=Text(doc,"state_sha256"))throw std::runtime_error("migration_report_integrity");
  return MigrationCoveragePass::Restore(definition,envelope);
}
}
Json HistoryMongo::BeginMigrationCoverage(const std::string& job,int64_t generation,const std::string& actor,
    const MigrationCoverageDefinition& definition){
  const auto key=ReportKey(job,generation,actor,definition);MigrationCoveragePass pass(definition);
  std::lock_guard<std::mutex> lock(state_->mutex);State::Client c(*state_);state_->Prune(c,"search_migration_reports");
  const auto previous=state_->One(c,"search_migration_reports",{{"_id",key}});
  if(previous){
    const auto old_generation=ExactInteger(previous.get(),"generation");
    if(old_generation>generation||Text(previous.get(),"actor")!=actor)throw std::runtime_error("migration_report_stale");
    if(old_generation==generation)return CoverageStatus(StoredCoverage(previous.get(),job,generation,actor,definition));
  }
  state_->SaveReport(c,key,job,generation,actor,definition,pass,previous.get());return CoverageStatus(pass);
}
MigrationCoverageBatch HistoryMongo::ReadCoverageBatch(const MigrationCoverageDefinition& definition,int64_t after){
  const auto page=ScanMetadata(definition.source.model_version,definition.scope,after,definition.source_high_watermark,32);
  MigrationCoverageBatch batch;batch.checkpoint=page.checkpoint;batch.exhausted=page.exhausted;
  if(page.items.empty())return batch;
  std::set<std::string> ids;std::map<std::string,std::string> target_ids;
  for(const auto& source:page.items){ids.insert(source.sample.record.id);
    try{const auto target=ReencodedSampleStorageUuid(source.sample,definition.target.model_version);ids.insert(target);target_ids[source.sample.record.id]=target;}
    catch(const std::invalid_argument&){/* Current source remains required, but cannot claim a guessed target. */}}
  std::lock_guard<std::mutex> lock(state_->mutex);State::Client c(*state_);
  std::map<std::string,HistoryMetadataRow> current;
  const std::vector<std::string> keys(ids.begin(),ids.end()),channels(definition.scope.channels.begin(),definition.scope.channels.end());
  state_->Each(c,"search_samples",{{"_id",{{"$in",keys}}},{"model",{{"$in",{definition.source.model_version,definition.target.model_version}}}},
      {"channel",{{"$in",channels}}},{"captured_ms",{{"$gte",definition.scope.from_ms},{"$lt",definition.scope.to_ms}}},
      {"expires_at",{{"$gt",Date(Now())}}}},{{"limit",64},{"projection",MetadataProjection()}},[&](const bson_t* doc){
    const auto metadata=CheckedMetadata(doc);auto sample=DecodeMetadata(doc,metadata);
    const auto id=sample.record.id;current.emplace(id,MetadataRow(doc,metadata,std::move(sample)));
  });
  const auto deleted=state_->DeletedRanges(c,definition.scope);
  const auto visible=[&](const HistoryMetadataRow& row){
    if(row.sample.expires_ms<=Now())return false;
    for(const auto& range:deleted)if(range.at("channel")==row.sample.record.channel&&
        range.at("from").get<int64_t>()<=row.sample.record.captured_ms&&row.sample.record.captured_ms<range.at("to").get<int64_t>())return false;
    return true;
  };
  for(const auto& source:page.items){MigrationCoverageObservation observation;observation.source=source;
    const auto found=current.find(source.sample.record.id);
    observation.source_current=found!=current.end()&&found->second.ordinal==source.ordinal&&
      found->second.sample.fingerprint==source.sample.fingerprint&&found->second.sample.record.model==definition.source.model_version&&visible(found->second);
    const auto target_id=target_ids.find(source.sample.record.id);
    if(target_id!=target_ids.end()){const auto target=current.find(target_id->second);
      if(target!=current.end()&&visible(target->second))observation.target=target->second;}
    batch.rows.push_back(std::move(observation));
  }
  return batch;
}
Json HistoryMongo::AdvanceMigrationCoverage(const std::string& job,int64_t generation,const std::string& actor,
    const MigrationCoverageDefinition& definition,int64_t expected){
  const auto key=ReportKey(job,generation,actor,definition);std::optional<MigrationCoveragePass> pass;std::string old_sha;
  {
    std::lock_guard<std::mutex> lock(state_->mutex);State::Client c(*state_);
    const auto old=state_->One(c,"search_migration_reports",{{"_id",key},{"expires_at",{{"$gt",Date(Now())}}}});
    pass.emplace(StoredCoverage(old.get(),job,generation,actor,definition));old_sha=Text(old.get(),"state_sha256");
  }
  if(expected<0||expected>pass->Checkpoint())throw std::runtime_error("migration_report_stale");
  if(pass->Complete()||expected<pass->Checkpoint())return CoverageStatus(*pass);
  pass->Observe(ReadCoverageBatch(definition,expected),Now());
  std::lock_guard<std::mutex> lock(state_->mutex);State::Client c(*state_);
  const auto current=state_->One(c,"search_migration_reports",{{"_id",key},{"expires_at",{{"$gt",Date(Now())}}}});
  const auto existing=StoredCoverage(current.get(),job,generation,actor,definition);
  if(Text(current.get(),"state_sha256")!=old_sha)return CoverageStatus(existing);
  state_->SaveReport(c,key,job,generation,actor,definition,*pass,current.get());return CoverageStatus(*pass);
}
Json HistoryMongo::ReadMigrationCoverage(const std::string& job,int64_t generation,const std::string& actor,
    const MigrationCoverageDefinition& definition,const std::optional<std::string>& after){
  const auto key=ReportKey(job,generation,actor,definition);
  std::lock_guard<std::mutex> lock(state_->mutex);State::Client c(*state_);
  const auto doc=state_->One(c,"search_migration_reports",{{"_id",key},{"expires_at",{{"$gt",Date(Now())}}}});
  return StoredCoverage(doc.get(),job,generation,actor,definition).Page(after);
}
HistoryIndexChanges HistoryMongo::ScanIndexChanges(const std::string& model,
    const std::set<std::string>& channels, int64_t after, size_t limit) {
  if (model.empty() || model.size() > 128 || channels.empty() || channels.size() > 1024 ||
      after < 0 || after > 9007199254740991LL || limit < 1 || limit > 64)
    throw std::invalid_argument("invalid_history_index_page");
  for (const auto& channel : channels) Uuid(channel);
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_);
  HistoryIndexChanges out; out.checkpoint = after;
  const std::vector<std::string> selected(channels.begin(), channels.end());
  Scope window; window.from_ms = INT64_MAX;
  state_->Each(c, "search_samples", {{"model", model}, {"channel", {{"$in", selected}}},
    {"ordinal", {{"$gt", after}}}, {"expires_at", {{"$gt", Date(Now())}}}},
    {{"sort", {{"ordinal", 1}}}, {"limit", limit}, {"projection", {{"jpeg", 0}, {"vector", 0}}}}, [&](const bson_t* doc) {
      const auto meta = CheckedMetadata(doc);
      const auto channel = meta.at("channel").get<std::string>();
      const auto at = meta.at("captured_ms").get<int64_t>(); const auto ordinal = Number(doc, "ordinal");
      if (!channels.count(channel) || meta.at("model") != model || at < 0 || at == INT64_MAX ||
          ordinal <= out.checkpoint || ordinal > 9007199254740991LL)
        throw std::runtime_error("history_metadata_integrity");
      out.checkpoint = ordinal; out.items.push_back({channel, at, ordinal});
      window.channels.insert(channel); window.from_ms = std::min(window.from_ms, at);
      window.to_ms = std::max(window.to_ms, at + 1);
    });
  if (!out.items.empty()) {
    const auto deleted = state_->DeletedRanges(c, window);
    out.items.erase(std::remove_if(out.items.begin(), out.items.end(), [&](const auto& item) {
      for (const auto& range : deleted)
        if (range.at("channel") == item.channel && range.at("from").get<int64_t>() <= item.captured_ms &&
            item.captured_ms < range.at("to").get<int64_t>()) return true;
      return false;
    }), out.items.end());
  }
  return out;
}
void HistoryMongo::PutCoverage(const std::string& id, const std::string& model, const std::string& channel,
                             int64_t from, int64_t to, bool scene, const std::string& status, int64_t expires) {
  Uuid(id); Range({{channel}, from, to, 20});
  if (model.empty() || model.size() > 128 || to > Now() + 60000 || to - from > 3600000 || expires <= Now() || expires > to + state_->budget.retention_ms)
    throw std::invalid_argument("invalid_coverage_range");
  const int rank = status == "pending" ? 0 : status == "gap" ? 1 : status == "sampled" ? 2 : -1;
  if (rank < 0) throw std::invalid_argument("invalid_coverage_state");
  Json identity = {{"model", model}, {"channel", channel}, {"from", from}, {"to", to}, {"scene", scene}};
  const auto fingerprint = Sha(identity.dump());
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_);
  if (state_->One(c, "search_deletions", {{"channel", channel}, {"from", {{"$lt", to}}}, {"to", {{"$gt", from}}}, {"expires_at", {{"$gt", Date(Now())}}}}))
    throw std::runtime_error("coverage_range_deleted");
  auto old = state_->One(c, "search_coverage", {{"_id", id}});
  if (old && Text(old.get(), "fingerprint") != fingerprint) throw std::runtime_error("coverage_identity_conflict");
  if (!old) {
    state_->Prune(c, "search_coverage");
    if (state_->Count(c, "search_coverage") >= state_->budget.max_coverage) throw std::runtime_error("coverage_capacity");
  }
  identity["expires_at"] = Date(expires); identity["fingerprint"] = fingerprint;
  // Pending may become a final result. Opposing final reports are not an
  // upgrade: retain a conservative, sticky conflict instead of losing a gap.
  const int previous=old?int(Number(old.get(),"rank")):0;
  const int resolved=previous==3||(previous>0&&rank>0&&previous!=rank)?3:std::max(previous,rank);
  state_->Update(c, "search_coverage", {{"_id", id}}, {{"$setOnInsert", identity}, {"$set", {{"rank", resolved}}}}, true);
}
Json HistoryMongo::Coverage(const std::string& model, const Scope& scope) {
  Range(scope); std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_); Json out = Json::array();
  const auto deleted = state_->DeletedRanges(c, scope);
  const std::vector<std::string> channels(scope.channels.begin(), scope.channels.end());
  size_t visited=0;
  state_->Each(c, "search_coverage", {{"model", model}, {"channel", {{"$in", channels}}}, {"from", {{"$lt", scope.to_ms}}},
    {"to", {{"$gt", scope.from_ms}}}, {"expires_at", {{"$gt", Date(Now())}}}},
    {{"sort", {{"channel", 1}, {"scene", 1}, {"rank", 1}, {"from", 1}, {"_id", 1}}},
     {"limit",100001},{"maxTimeMS",3000},{"projection",{{"channel",1},{"scene",1},{"rank",1},{"from",1},{"to",1}}}},
    [&](const bson_t* doc) {
      if(++visited>100000)throw std::runtime_error("coverage_range_too_large");
      const auto row = ToJson(doc); const auto rank = row.at("rank").get<int>();
      for (const auto& range : deleted)
        if (range.at("channel") == row.at("channel") && range.at("from").get<int64_t>() < row.at("to").get<int64_t>() && range.at("to").get<int64_t>() > row.at("from").get<int64_t>()) return;
      Json next={{"channel", row.at("channel")}, {"from", std::max(scope.from_ms, row.at("from").get<int64_t>())},
        {"to", std::min(scope.to_ms, row.at("to").get<int64_t>())}, {"scene", row.at("scene")}, {"state", rank == 2 ? "sampled" : rank>=1 ? "gap" : "pending"}};
      if(!out.empty()&&out.back().at("channel")==next.at("channel")&&out.back().at("scene")==next.at("scene")&&
          out.back().at("state")==next.at("state")&&next.at("from").get<int64_t>()<=out.back().at("to").get<int64_t>())
        out.back()["to"]=std::max(out.back().at("to").get<int64_t>(),next.at("to").get<int64_t>());
      else out.push_back(std::move(next));
      if(out.size()>10000)throw std::runtime_error("coverage_range_too_large");
    },{{"channel",1},{"scene",1},{"rank",1},{"from",1},{"_id",1}});
  if (out.size() > 10000) throw std::runtime_error("coverage_range_too_large");
  return out;
}
void HistoryMongo::DeleteRange(const std::string& channel, int64_t from, int64_t to) {
  Range({{channel}, from, to, 20});
  if (to > Now() + 60000) throw std::invalid_argument("invalid_delete_range");
  const auto key = Sha(channel + ":" + std::to_string(from) + ":" + std::to_string(to));
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_);
  state_->cached_usage = Json();
  ++state_->projection_revision;
  if (!state_->One(c, "search_deletions", {{"_id", key}})) {
    state_->Prune(c, "search_deletions");
    if (state_->Count(c, "search_deletions") >= 2048) throw std::runtime_error("deletion_capacity");
  }
  state_->Update(c, "search_deletions", {{"_id", key}}, {{"$setOnInsert", {{"channel", channel}, {"from", from}, {"to", to},
    {"expires_at", Date(to + state_->budget.retention_ms)}}}}, true);
  state_->Delete(c, "search_samples", {{"channel", channel}, {"captured_ms", {{"$gte", from}, {"$lt", to}}}});
  state_->Delete(c, "search_coverage", {{"channel", channel}, {"from", {{"$lt", to}}}, {"to", {{"$gt", from}}}});
}
void HistoryMongo::Ping() {
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_);
  state_->Command(c, {{"ping", 1}, {"maxTimeMS", 2000}});
}
Json HistoryMongo::Usage() { std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_); return state_->Usage(c); }
Json HistoryMongo::Capacity() {
  std::lock_guard<std::mutex> lock(state_->mutex);State::Client c(*state_);
  auto result=state_->CachedUsage(c);
  result["max_samples"]=state_->budget.max_samples;result["max_bytes"]=state_->budget.max_bytes;
  result["retention_days"]=state_->budget.retention_ms/86400000;
  result["coverage"]=state_->Count(c,"search_coverage");result["max_coverage"]=state_->budget.max_coverage;
  result["evicted_samples"]=state_->evicted_samples;result["evicted_bytes"]=state_->evicted_bytes;
  result["eviction_runs"]=state_->eviction_runs;result["rolling_min_age_ms"]=state_->budget.evict_min_age_ms;
  // The actual look-back horizon: captured time of the oldest retained evidence (null when empty).
  result["oldest_retained_captured_ms"]=nullptr;
  state_->Each(c,"search_samples",Json::object(),{{"limit",1},{"maxTimeMS",3000},{"projection",{{"captured_ms",1}}}},
    [&](const bson_t* doc){result["oldest_retained_captured_ms"]=Number(doc,"captured_ms");},{{"captured_ms",1},{"ordinal",1}});
  return result;
}
std::string HistoryMongo::BeginSearch(const SearchSessionRequest& request) {
  const auto key = SearchKey(request.id, request.actor);
  const auto value = SearchRequestJson(request); const auto now = Now();
  if (request.expires_ms <= now || request.expires_ms > now + 86400000 || value.dump().size() > 16384)
    throw std::invalid_argument("invalid_search_retention");
  const auto fingerprint = Sha(value.dump());
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_);
  auto old = state_->Search(c, key);
  if (old) {
    auto row = ToJson(old.get());
    if (row.value("cancelled", false)) throw std::runtime_error("search_cancelled");
    if (row.at("fingerprint") != fingerprint) throw std::runtime_error("search_request_conflict");
    ReadSearchRequest(old.get()); return Text(old.get(), "version");
  }
  state_->AdmitSearch(c, key); const auto version = NewSearchVersion();
  state_->Update(c, "search_sessions", {{"_id", key}}, {{"$setOnInsert", {{"request", value},
    {"fingerprint", fingerprint}, {"version", version}, {"created_ms", now}, {"cancelled", false}, {"expires_at", Date(request.expires_ms)}}}}, true);
  return version;
}
bool HistoryMongo::PublishSearch(const std::string& id, const std::string& actor, const std::string& version,
                                const std::vector<SearchSessionCandidate>& candidates, const std::string& coverage) {
  const auto key = SearchKey(id, actor);
  if (version.size() != 64 || candidates.size() > 60 || (coverage != "unknown" && coverage != "partial" && coverage != "sampled"))
    throw std::invalid_argument("invalid_search_shortlist");
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_); auto old = state_->Search(c, key);
  if (!old || ToJson(old.get()).value("cancelled", false)) throw std::runtime_error("search_cancelled");
  if (Text(old.get(), "version") != version) throw std::runtime_error("search_request_conflict");
  const auto request = ReadSearchRequest(old.get());
  auto row = ToJson(old.get());
  if (row.contains("shortlist")) { ReadShortlist(old.get()); return false; } // First acknowledged order wins.
  Json slots = Json::array(); std::set<std::string> ids; std::string actual_coverage = coverage;
  Json candidate_ids = Json::array();
  for (const auto& candidate : candidates) {
    Uuid(candidate.sample_id);
    if (!candidate.fingerprint.empty() &&
        (candidate.fingerprint.size() != 64 || !std::all_of(candidate.fingerprint.begin(), candidate.fingerprint.end(),
          [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); })))
      throw std::invalid_argument("invalid_search_candidate_generation");
    if (!std::isfinite(candidate.similarity) || candidate.similarity < -1.00001 || candidate.similarity > 1.00001 || !ids.insert(candidate.sample_id).second)
      throw std::invalid_argument("invalid_search_candidate");
    candidate_ids.push_back(candidate.sample_id);
    if(candidate.evidence_refs.size()>3)throw std::invalid_argument("search_evidence_capacity");
    if(!candidate.evidence_refs.empty()&&candidate.fingerprint.empty())throw std::invalid_argument("search_match_ref_missing");
    std::set<std::string> related_ids;
    for(const auto& ref:candidate.evidence_refs){
      Uuid(ref.sample_id);
      if(ref.fingerprint.size()!=64||!std::all_of(ref.fingerprint.begin(),ref.fingerprint.end(),[](char c){return(c>='0'&&c<='9')||(c>='a'&&c<='f');})||
        !related_ids.insert(ref.sample_id).second)throw std::invalid_argument("invalid_search_evidence_ref");
      if(ref.sample_id==candidate.sample_id&&ref.fingerprint!=candidate.fingerprint)throw std::invalid_argument("search_match_ref_mismatch");
      candidate_ids.push_back(ref.sample_id);
    }
    if(!candidate.evidence_refs.empty()&&!related_ids.count(candidate.sample_id))throw std::invalid_argument("search_match_ref_missing");
  }
  // Explicit bounded IDs only. Dedup includes the representative in refs.
  std::set<std::string> unique_ids;for(const auto& id:candidate_ids)unique_ids.insert(id.get<std::string>());
  candidate_ids=Json::array();for(const auto& id:unique_ids)candidate_ids.push_back(id);
  auto available = state_->VisibleSamples(c, candidate_ids, request.scope);
  for (const auto& candidate : candidates) {
    auto sample = available.find(candidate.sample_id);
    // Keep the original ordinal even if evidence disappears during inference.
    // Pagination advances over these slots; it never shifts following results.
    if (sample == available.end()) { slots.push_back({{"id", candidate.sample_id}, {"score", candidate.similarity}, {"fingerprint", nullptr}}); actual_coverage = "partial"; continue; }
    if ((sample->second.track_slot && candidate.fingerprint.empty()) ||
        (!candidate.fingerprint.empty() && sample->second.fingerprint != candidate.fingerprint)) {
      slots.push_back({{"id", candidate.sample_id}, {"score", candidate.similarity}, {"fingerprint", nullptr}});
      actual_coverage = "partial";
      continue;
    }
    const auto& r = sample->second.record;
    if (r.model != request.model || !request.scope.channels.count(r.channel) || r.captured_ms < request.scope.from_ms || r.captured_ms >= request.scope.to_ms)
      throw std::invalid_argument("search_candidate_out_of_scope");
    Json frames=Json::array();std::set<std::string> frame_ids;
    const auto append=[&](const Sample& value){
      const auto& record=value.record;
      if(!SameEvidenceGroup(sample->second,value)||record.model!=request.model||!request.scope.channels.count(record.channel)||record.captured_ms<request.scope.from_ms||record.captured_ms>=request.scope.to_ms)
        throw std::invalid_argument("search_related_out_of_scope");
      if(!frame_ids.insert(value.evidence.at("frame_id").get<std::string>()).second)return;
      frames.push_back({{"sample_id",record.id},{"frame_id",value.evidence.at("frame_id")},{"fingerprint",value.fingerprint},{"captured_ms",record.captured_ms},
        {"role",record.id==r.id?"match":record.captured_ms<=r.captured_ms?"before":"after"}});
    };
    append(sample->second);
    for(const auto& ref:candidate.evidence_refs){
      auto related=available.find(ref.sample_id);
      if(related==available.end()||related->second.fingerprint!=ref.fingerprint){actual_coverage="partial";continue;}
      if(ref.sample_id==r.id){if(ref.fingerprint!=sample->second.fingerprint)throw std::invalid_argument("search_match_ref_mismatch");continue;}
      append(related->second);
    }
    slots.push_back({{"id", candidate.sample_id}, {"score", candidate.similarity}, {"fingerprint", sample->second.fingerprint},{"frames",frames}});
  }
  Json shortlist = {{"version", version}, {"coverage", actual_coverage}, {"slots", slots}};
  if (shortlist.dump().size() > 65536) throw std::invalid_argument("search_shortlist_size");
  if (state_->Update(c, "search_sessions", {{"_id", key}, {"version", version}, {"cancelled", false}, {"expires_at", {{"$gt", Date(Now())}}}},
    {{"$set", {{"shortlist", shortlist}, {"shortlist_sha", Sha(shortlist.dump())}}}}, false) != 1)
    throw std::runtime_error("search_cancelled");
  return true;
}
std::optional<SearchSessionPage> HistoryMongo::ReadSearch(const std::string& id, const std::string& actor, size_t offset, size_t limit) {
  const auto key = SearchKey(id, actor);
  if (offset > 60 || limit < 1 || limit > 60) throw std::invalid_argument("invalid_search_cursor");
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_); auto doc = state_->Search(c, key);
  if (!doc || ToJson(doc.get()).value("cancelled", false)) return std::nullopt;
  SearchSessionPage page; page.request = ReadSearchRequest(doc.get()); page.version = Text(doc.get(), "version");
  const auto row = ToJson(doc.get());
  if (!row.contains("shortlist")) return page;
  const auto shortlist = ReadShortlist(doc.get()); const auto& slots = shortlist.at("slots");
  page.published = true; page.coverage = shortlist.at("coverage");
  Json ids = Json::array(); for (const auto& slot : slots) { const auto sample_id = slot.at("id").get<std::string>(); Uuid(sample_id); ids.push_back(sample_id); }
  auto available = state_->VisibleSamples(c, ids, page.request.scope);
  for (const auto& slot : slots) {
    const auto sample = available.find(slot.at("id").get<std::string>());
    if (sample != available.end() && (slot.at("fingerprint").is_null() || slot.at("fingerprint") != sample->second.fingerprint)) available.erase(sample);
  }
  // Coverage belongs to the entire immutable shortlist, not only this page.
  // Otherwise deleting page one's image could be hidden by a healthy page two.
  if (available.size() != slots.size()) page.coverage = "partial";
  Json evidence_ids=Json::array();
  for(const auto& slot:slots){auto primary=available.find(slot.at("id").get<std::string>());if(primary==available.end())continue;
    for(const auto& ref:FrozenEvidence(slot,primary->second))evidence_ids.push_back(ref.at("sample_id"));}
  const auto evidence=state_->VisibleSamples(c,evidence_ids,page.request.scope);
  for(const auto& slot:slots){auto primary=available.find(slot.at("id").get<std::string>());if(primary==available.end())continue;
    for(const auto& ref:FrozenEvidence(slot,primary->second)){
      auto image=evidence.find(ref.at("sample_id").get<std::string>());
      if(image==evidence.end()||image->second.fingerprint!=ref.at("fingerprint")||image->second.evidence.at("frame_id")!=ref.at("frame_id")||image->second.record.captured_ms!=ref.at("captured_ms"))page.coverage="partial";
    }
  }
  const auto verifications = VerRecords(row);
  const auto end = std::min(slots.size(), offset + limit);
  for (size_t i = offset; i < end; ++i) {
    const std::string sample_id = slots[i].at("id"); Uuid(sample_id);
    auto sample = available.find(sample_id); if (sample == available.end()) continue;
    const auto& r = sample->second.record;
    if (r.model != page.request.model || !page.request.scope.channels.count(r.channel) || r.captured_ms < page.request.scope.from_ms || r.captured_ms >= page.request.scope.to_ms)
      throw std::runtime_error("search_session_scope_mismatch");
    std::optional<bool> relevant;
    if (row.contains("feedback") && row.at("feedback").contains(sample_id)) relevant = row.at("feedback").at(sample_id).get<bool>();
    std::optional<Json> verification;
    if (verifications.contains(sample_id)) {
      const auto& entry = verifications.at(sample_id); const auto& binding = entry.at("binding");
      if (binding.at("search_id") != page.request.id || binding.at("actor") != page.request.actor || binding.at("version") != page.version ||
          binding.at("sample_id") != sample_id || binding.at("frame_id") != sample->second.evidence.at("frame_id") ||
          binding.at("fingerprint") != sample->second.fingerprint || binding.at("query_sha256") != Sha(VerQuery(page.request.query)) ||
          binding.at("profile_fp") != row.at("verification_profile")) throw std::runtime_error("history_verification_integrity");
      verification = VerView(entry);
    }
    const auto frozen=FrozenEvidence(slots[i],sample->second);Json frames=Json::array();
    int64_t started=r.captured_ms,ended=r.captured_ms;
    for(const auto& ref:frozen){
      const auto captured=ref.at("captured_ms").get<int64_t>();started=std::min(started,captured);ended=std::max(ended,captured);
      const auto found=evidence.find(ref.at("sample_id").get<std::string>());const auto* related=found==evidence.end()?nullptr:&found->second;
      if(!related||related->fingerprint!=ref.at("fingerprint")||related->evidence.at("frame_id")!=ref.at("frame_id")||related->record.captured_ms!=captured){page.coverage="partial";continue;}
      if(!SameEvidenceGroup(sample->second,*related)||related->record.model!=page.request.model||!page.request.scope.channels.count(related->record.channel)||
        captured<page.request.scope.from_ms||captured>=page.request.scope.to_ms)throw std::runtime_error("search_session_scope_mismatch");
      frames.push_back({{"id",ref.at("frame_id")},{"captured_ms",captured},{"role",ref.at("role")}});
      if(auto box=DisplayBBox(*related))frames.back()["bbox"]=*box;
    }
    if(frames.empty()||std::none_of(frames.begin(),frames.end(),[](const auto& frame){return frame.at("role")=="match";})){page.coverage="partial";continue;}
    page.items.push_back({std::move(sample->second), slots[i].at("score").get<double>(), relevant, std::move(verification),std::move(frames),started,ended});
  }
  if (end < slots.size()) page.next_offset = end;
  return page;
}
bool HistoryMongo::SearchFeedback(const std::string& id, const std::string& actor, const std::string& sample_id, bool relevant) {
  const auto key = SearchKey(id, actor); Uuid(sample_id);
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_); auto doc = state_->Search(c, key);
  if (!doc || ToJson(doc.get()).value("cancelled", false) || !ToJson(doc.get()).contains("shortlist")) return false;
  if (!state_->OwnedSample(c, doc.get(), sample_id, false)) return false;
  return state_->Update(c, "search_sessions", {{"_id", key}, {"version", Text(doc.get(), "version")}, {"cancelled", false}, {"expires_at", {{"$gt", Date(Now())}}}},
    {{"$set", {{"feedback." + sample_id, relevant}}}}, false) == 1;
}
std::optional<Sample> HistoryMongo::SearchImage(const std::string& id, const std::string& actor,
                                              const std::string& sample_id, const std::string& frame_id) {
  const auto key = SearchKey(id, actor); Uuid(sample_id); Uuid(frame_id);
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_); auto doc = state_->Search(c, key);
  if (!doc || ToJson(doc.get()).value("cancelled", false)) return std::nullopt;
  auto primary=state_->OwnedSample(c,doc.get(),sample_id,false);
  if(!primary||DateValue(doc.get(),"expires_at")<=Now())return std::nullopt;
  const auto request=ReadSearchRequest(doc.get());const auto shortlist=ReadShortlist(doc.get());
  for(const auto& slot:shortlist.at("slots"))if(slot.at("id")==sample_id){
    for(const auto& ref:FrozenEvidence(slot,*primary))if(ref.at("frame_id")==frame_id){
      auto image=state_->VisibleSample(c,ref.at("sample_id"),true);
      if(!image||image->fingerprint!=ref.at("fingerprint")||image->evidence.at("frame_id")!=frame_id||image->record.captured_ms!=ref.at("captured_ms"))return std::nullopt;
      if(!SameEvidenceGroup(*primary,*image)||image->record.model!=request.model||!request.scope.channels.count(image->record.channel)||
        image->record.captured_ms<request.scope.from_ms||image->record.captured_ms>=request.scope.to_ms)throw std::runtime_error("search_session_scope_mismatch");
      return image;
    }
  }
  return std::nullopt;
}
void HistoryMongo::CancelSearch(const std::string& id, const std::string& actor) {
  const auto key = SearchKey(id, actor);
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_);
  auto existing = state_->Search(c, key); if (!existing) state_->AdmitSearch(c, key);
  Json retained = Json::object();
  const auto records = existing ? VerRecords(ToJson(existing.get())) : Json::object();
  for (const auto& pair : records.items())
    if (pair.value().value("submitted", false)) retained[pair.key()] = pair.value();
  Json fields{{"cancelled", true}, {"verification_submitted", !retained.empty()}};
  Json removed{{"shortlist", ""}, {"shortlist_sha", ""}, {"feedback", ""}, {"verification_complete", ""}};
  if (retained.empty()) {
    removed.update({{"verification", ""}, {"verification_sha", ""}, {"verification_profile", ""}, {"verification_profile_details", ""}});
  } else {
    // Only at most five small submitted proofs survive, never a JPEG/vector.
    // They allow a restarted controller to cancel an unknown external call.
    fields["verification"] = retained; fields["verification_sha"] = Sha(retained.dump());
  }
  // Keep the original TTL; cancel-before-open tombstones remain bounded too.
  state_->Update(c, "search_sessions", {{"_id", key}}, {{"$setOnInsert", {{"expires_at", Date(Now() + 3600000)}}},
    {"$set", fields}, {"$unset", removed}}, true);
}
Json HistoryMongo::SearchVerification(const Json& input) {
  if (!input.is_object() || input.dump().size() > 16384) throw std::invalid_argument("invalid_verification_request");
  const auto action = VerText(input.at("action"), 16);
  if (action == "scan") VerKeys(input, {"action", "profile_fp", "cursor"});
  else if (action == "inspect") VerKeys(input, {"action", "target", "profile", "question_scope"});
  else if (action == "queued") VerKeys(input, {"action", "binding", "job_id", "generation", "profile"});
  else if (action == "begin") VerKeys(input, {"action", "binding", "job_id", "generation", "request_id"});
  else if (action == "finish") VerKeys(input, {"action", "binding", "job_id", "generation", "request_id", "result"});
  else if (action == "abort") VerKeys(input, {"action", "binding", "job_id", "generation", "request_id", "reason"});
  else throw std::invalid_argument("invalid_verification_action");
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_);
  const auto now = Now();
  if (action == "scan") {
    const auto profile = VerHash(input.at("profile_fp"));
    Json query{{"request.verify", true}, {"created_ms", {{"$type", "number"}, {"$gte", 0}}}, {"expires_at", {{"$gt", Date(now)}}}};
    Json pending = Json::array();
    pending.push_back({{"verification_profile", {{"$ne", profile}}}});
    pending.push_back({{"verification_complete", {{"$ne", true}}}});
    Json candidates{{"cancelled", false}, {"shortlist", {{"$exists", true}}}, {"$or", pending}};
    // Discover orphaned submissions even when PG already finalized the job
    // but controller cancel/abort failed. The controller must check the PG
    // lease before treating any of these proofs as abandoned.
    Json submitted_candidates{{"verification_submitted", true}};
    Json conditions = Json::array();
    conditions.push_back({{"$or", Json::array({candidates, submitted_candidates})}});
    if (!input.at("cursor").is_null()) {
      const auto& cursor = input.at("cursor"); VerKeys(cursor, {"created_ms", "key"});
      const auto created = VerInteger(cursor.at("created_ms")); const auto key = VerHash(cursor.at("key"));
      conditions.push_back({{"$or", Json::array({{{"created_ms", {{"$lt", created}}}}, {{"created_ms", created}, {"_id", {{"$lt", key}}}}})}});
    }
    query["$and"] = conditions;
    Json refs = Json::array(), cleanup_refs = Json::array(), cursor = nullptr;
    size_t visited = 0;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(500);
    state_->Each(c, "search_sessions", query, {{"sort", {{"created_ms", -1}, {"_id", -1}}}, {"limit", 16}}, [&](const bson_t* doc) {
      if (!refs.empty() || !cleanup_refs.empty() || (visited && std::chrono::steady_clock::now() >= deadline)) return;
      const auto request = ReadSearchRequest(doc); const auto row = ToJson(doc);
      const auto key = Text(doc, "_id"); const auto created = Number(doc, "created_ms");
      VerHash(key); VerInteger(created); ++visited; cursor = {{"created_ms", created}, {"key", key}};
      const auto records = VerRecords(row); Json ids = Json::array();
      for (const auto& entry : records) if (entry.value("submitted", false)) {
        const auto& binding = entry.at("binding");
        if (binding.at("search_id") != request.id || binding.at("actor") != request.actor || binding.at("version") != Text(doc, "version"))
          throw std::runtime_error("history_verification_integrity");
        // Metadata-only references, mutually exclusive with new work. A live
        // submitted lease is not a cancellation request; BFF decides whether
        // it is terminal/expired/absent before cancelling and aborting it.
        cleanup_refs.push_back({{"search_id", request.id}, {"actor", request.actor}, {"version", Text(doc, "version")}, {"sample_id", binding.at("sample_id")}});
      }
      if (!cleanup_refs.empty() || row.value("cancelled", false)) return;
      const auto shortlist = ReadShortlist(doc); const auto& slots = shortlist.at("slots");
      for (size_t n = 0; n < std::min(size_t(5), slots.size()); ++n) {
        const auto& slot = slots[n]; if (!slot.at("fingerprint").is_string()) continue;
        const auto id = slot.at("id").get<std::string>();
        if (row.value("verification_profile", std::string{}) == profile && records.contains(id) &&
            records.at(id).at("binding").at("question_scope") == "visible") continue;
        ids.push_back(id);
      }
      if (ids.empty()) return;
      const auto available = state_->VisibleSamples(c, ids, request.scope);
      for (size_t n = 0; n < std::min(size_t(5), slots.size()); ++n) {
        const auto& slot = slots[n]; const auto id = slot.at("id").get<std::string>();
        const auto sample = available.find(id);
        if (sample == available.end() || slot.at("fingerprint") != sample->second.fingerprint) continue;
        refs.push_back({{"search_id", request.id}, {"actor", request.actor}, {"version", Text(doc, "version")}, {"sample_id", id}});
      }
    }, {{"created_ms", -1}, {"_id", -1}});
    return {{"refs", refs}, {"cleanup_refs", cleanup_refs}, {"next_cursor", cursor}};
  }
  struct Owned {
    std::string key, kind;
    SearchSessionRequest request;
    Sample sample;
    Json row, binding;
    bool evidence_available = true;
  };
  const auto own = [&](const Json& target, const std::string& profile, const std::string& scope) -> std::optional<Owned> {
    VerTarget(target); VerHash(profile); VerScope(scope);
    const auto key = SearchKey(target.at("search_id"), target.at("actor")); auto doc = state_->Search(c, key);
    if (!doc) return std::nullopt;
    const auto row = ToJson(doc.get());
    if (row.value("cancelled", false) || Text(doc.get(), "version") != target.at("version") || !row.contains("shortlist")) return std::nullopt;
    const auto request = ReadSearchRequest(doc.get()); if (!request.verify) return std::nullopt;
    const auto slots = ReadShortlist(doc.get()).at("slots"); bool head = false;
    for (size_t n = 0; n < std::min(size_t(5), slots.size()); ++n) if (slots[n].at("id") == target.at("sample_id")) head = true;
    if (!head) return std::nullopt;
    auto sample = state_->OwnedSample(c, doc.get(), target.at("sample_id"), true);
    if (!sample) return std::nullopt;
    const auto jpeg_sha = Sha(sample->jpeg.data(), sample->jpeg.size());
    Json binding = target; binding.update({{"frame_id", sample->evidence.at("frame_id")}, {"fingerprint", sample->fingerprint},
      {"query_sha256", Sha(VerQuery(request.query))}, {"jpeg_sha256", jpeg_sha}, {"profile_fp", profile}, {"question_scope", scope}});
    VerBinding(binding);
    return Owned{key, sample->record.scene ? "scene" : "object", request, std::move(*sample), row, binding};
  };
  const auto complete = [&](const Owned& owned, const Json& records) {
    const auto slots = owned.row.at("shortlist").at("slots"); Json ids = Json::array();
    for (size_t n = 0; n < std::min(size_t(5), slots.size()); ++n) ids.push_back(slots[n].at("id"));
    const auto available = state_->VisibleSamples(c, ids, owned.request.scope);
    for (size_t n = 0; n < std::min(size_t(5), slots.size()); ++n) {
      const auto& slot = slots[n]; const auto id = slot.at("id").get<std::string>(); const auto found = available.find(id);
      if (found == available.end() || slot.at("fingerprint") != found->second.fingerprint) continue;
      if (!records.contains(id) || !VerFinal(records.at(id)) || records.at(id).at("binding").at("question_scope") != "visible") return false;
    }
    return true;
  };
  const auto save = [&](Owned& owned, const Json& profile, const Json& records) {
    if ((owned.evidence_available && owned.sample.expires_ms <= Now()) || owned.request.expires_ms <= Now()) throw std::runtime_error("search_verification_stale");
    if (records.size() > 5 || records.dump().size() > 5 * 8192) throw std::runtime_error("verification_capacity");
    for (const auto& entry : records) if (entry.dump().size() > 8192) throw std::runtime_error("verification_capacity");
    const bool cancelled = owned.row.value("cancelled", false);
    const bool done = !cancelled && complete(owned, records);
    const bool submitted = std::any_of(records.begin(), records.end(), [](const auto& entry) { return entry.value("submitted", false); });
    const auto count = state_->Update(c, "search_sessions", {{"_id", owned.key}, {"version", owned.binding.at("version")},
      {"cancelled", cancelled}, {"expires_at", {{"$gt", Date(Now())}}}}, {{"$set", {{"verification_profile", profile.at("profile_fp")},
      {"verification_profile_details", profile}, {"verification", records}, {"verification_sha", Sha(records.dump())}, {"verification_complete", done}, {"verification_submitted", submitted}}}}, false);
    if (count != 1) throw std::runtime_error("search_cancelled");
    owned.row["verification_profile"] = profile.at("profile_fp"); owned.row["verification_profile_details"] = profile;
    owned.row["verification"] = records; owned.row["verification_sha"] = Sha(records.dump());
  };
  const auto entry_for = [](const Owned& owned, const Json& records) -> Json {
    const auto id = owned.sample.record.id;
    if (!records.contains(id) || records.at(id).at("binding") != owned.binding) return nullptr;
    return records.at(id);
  };
  if (action == "inspect") {
    const auto profile = VerProfile(input.at("profile")); const auto scope = VerScope(input.at("question_scope"));
    const auto target = VerTarget(input.at("target"));
    // Metadata references survive a profile transition until the previous
    // unknown submission has been explicitly cancelled and aborted.
    auto original = state_->Search(c, SearchKey(target.at("search_id"), target.at("actor")));
    if (original) {
      const auto row = ToJson(original.get());
      if (Text(original.get(), "version") == target.at("version")) {
        const auto records = VerRecords(row);
        if (row.value("cancelled", false)) {
          for (const auto& entry : records) if (entry.value("submitted", false))
            return {{"status", "cancelled"}, {"binding", entry.at("binding")}, {"query", nullptr}, {"kind", nullptr}, {"scope", nullptr},
              {"expires_ms", nullptr}, {"verification", VerView(entry)}, {"submitted", VerSubmitted(entry)}};
          return {{"status", "cancelled"}, {"binding", nullptr}, {"query", nullptr}, {"kind", nullptr}, {"scope", nullptr},
            {"expires_ms", nullptr}, {"verification", nullptr}, {"submitted", nullptr}};
        }
        for (const auto& entry : records) if (entry.value("submitted", false) &&
            (entry.at("binding").at("profile_fp") != profile.at("profile_fp") ||
             (entry.at("binding").at("sample_id") == target.at("sample_id") && entry.at("binding").at("question_scope") != scope))) {
          return {{"status", "profile_superseded"}, {"binding", entry.at("binding")}, {"query", nullptr}, {"kind", nullptr}, {"scope", nullptr},
            {"expires_ms", nullptr}, {"verification", VerView(entry)}, {"submitted", VerSubmitted(entry)}};
        }
        // A durable submission proof is control metadata, not inference
        // input. Keep it discoverable even if its sample expired or its slot
        // was replaced, so a controller can cancel an abandoned external call.
        for (const auto& entry : records) if (entry.value("submitted", false) &&
            entry.at("binding").at("sample_id") == target.at("sample_id")) {
          const auto& binding = entry.at("binding");
          if (binding.at("search_id") != target.at("search_id") || binding.at("actor") != target.at("actor") ||
              binding.at("version") != target.at("version")) throw std::runtime_error("history_verification_integrity");
          return {{"status", "submitted"}, {"binding", binding}, {"query", nullptr}, {"kind", nullptr}, {"scope", nullptr},
            {"expires_ms", nullptr}, {"verification", VerView(entry)}, {"submitted", VerSubmitted(entry)}};
        }
      }
    }
    auto owned = own(target, profile.at("profile_fp"), scope);
    if (!owned) return {{"status", "unavailable"}, {"binding", nullptr}, {"query", nullptr}, {"kind", nullptr}, {"scope", nullptr},
      {"expires_ms", nullptr}, {"verification", nullptr}, {"submitted", nullptr}};
    const auto records = VerRecords(owned->row);
    if (owned->row.value("verification_profile", std::string{}) == profile.at("profile_fp") && owned->row.at("verification_profile_details") != profile)
      throw std::runtime_error("history_verification_integrity");
    auto entry = entry_for(*owned, records);
    // Cache scope means question_scope (visible/temporal), not the search's
    // time/channel filter. The filter never enters the single-image model.
    // Reuse still requires own() above to re-check this session's scope,
    // expiry, exact sample/frame/fingerprint/JPEG and actor; BFF checks current
    // channel permissions before and after every operation, including hits.
    const auto cache_key = Sha(Json::array({owned->request.actor, owned->request.query, owned->sample.record.id, owned->binding.at("frame_id"),
      owned->binding.at("fingerprint"), owned->binding.at("jpeg_sha256"), profile.at("profile_fp"), owned->kind, scope}).dump());
    if (entry.is_null()) {
      auto cached = state_->One(c, "search_verification_cache", {{"_id", cache_key}, {"expires_at", {{"$gt", Date(Now())}}}});
      if (cached) {
        const auto row = ToJson(cached.get()); const auto& result = row.at("result");
        if (row.dump().size() > 8192 || row.at("result_sha") != Sha(result.dump()) || row.at("profile_fp") != profile.at("profile_fp"))
          throw std::runtime_error("history_verification_integrity");
        VerResult(result, owned->binding, profile, VerRequestId(result.at("request_id")), owned->kind, owned->request.query);
        entry = {{"binding", owned->binding}, {"state", result.at("decision")}, {"request_id", result.at("request_id")},
          {"cached", true}, {"reason", result.at("reason")}, {"submitted", false}, {"job_id", nullptr}, {"generation", 0}, {"result", result}};
      }
    }
    const std::vector<std::string> channels(owned->request.scope.channels.begin(), owned->request.scope.channels.end());
    return {{"status", entry.is_null() ? "pending" : VerFinal(entry) ? (entry.at("cached").get<bool>() ? "cached" : "final") : "pending"},
      {"binding", owned->binding}, {"query", VerQuery(owned->request.query)}, {"kind", owned->kind},
      {"scope", {{"channel_ids", channels}, {"from_ms", owned->request.scope.from_ms}, {"to_ms", owned->request.scope.to_ms}}},
      {"expires_ms", std::min(owned->request.expires_ms, owned->sample.expires_ms)}, {"verification", VerView(entry)}, {"submitted", VerSubmitted(entry)}};
  }
  const auto binding = VerBinding(input.at("binding")); const auto job = VerText(input.at("job_id"), 36); Uuid(job);
  const auto generation = VerInteger(input.at("generation"), action == "begin" || action == "finish" ? 1 : 0);
  Json target{{"search_id", binding.at("search_id")}, {"actor", binding.at("actor")}, {"version", binding.at("version")}, {"sample_id", binding.at("sample_id")}};
  auto owned = own(target, binding.at("profile_fp"), binding.at("question_scope"));
  if (!owned && action == "abort") {
    auto original = state_->Search(c, SearchKey(binding.at("search_id"), binding.at("actor")));
    if (original) {
      auto row = ToJson(original.get());
      if (Text(original.get(), "version") == binding.at("version") && (row.contains("shortlist") || row.value("cancelled", false)) &&
          row.value("verification_profile", std::string{}) == binding.at("profile_fp")) {
        const auto records = VerRecords(row); const auto found = records.find(binding.at("sample_id").get<std::string>());
        if (found != records.end() && found->at("binding") == binding) {
          auto request = ReadSearchRequest(original.get()); Sample missing; missing.record.id = binding.at("sample_id");
          owned = Owned{SearchKey(binding.at("search_id"), binding.at("actor")), "", request, std::move(missing), row, binding, false};
        }
      }
    }
  }
  if (!owned || owned->binding != binding) return VerMutation(false, "stale");
  auto records = VerRecords(owned->row); Json profile;
  if (action == "queued") {
    profile = VerProfile(input.at("profile"));
    if (profile.at("profile_fp") != binding.at("profile_fp")) throw std::invalid_argument("invalid_verification_profile");
    if (owned->row.value("verification_profile", std::string{}) != binding.at("profile_fp")) {
      for (const auto& prior : records) if (prior.value("submitted", false)) return VerMutation(false, "already_submitted", prior);
      records = Json::object();
    } else if (owned->row.at("verification_profile_details") != profile) throw std::runtime_error("history_verification_integrity");
  } else {
    if (owned->row.value("verification_profile", std::string{}) != binding.at("profile_fp")) return VerMutation(false, "stale");
    profile = VerProfile(owned->row.at("verification_profile_details"));
  }
  auto entry = entry_for(*owned, records);
  if (records.contains(owned->sample.record.id) && entry.is_null() && !VerFinal(records.at(owned->sample.record.id))) {
    const auto prior = records.at(owned->sample.record.id);
    return VerMutation(false, prior.value("submitted", false) ? "already_submitted" : "stale", prior);
  }
  if (action == "finish") VerResult(input.at("result"), binding, profile, VerRequestId(input.at("request_id")), owned->kind, owned->request.query);
  if (action == "abort" && !input.at("request_id").is_null()) VerRequestId(input.at("request_id"));
  if (!entry.is_null() && VerFinal(entry)) {
    bool identical = action == "finish" && entry.at("job_id") == job && entry.at("generation") == generation &&
      entry.at("request_id") == input.at("request_id") && entry.at("result") == input.at("result");
    identical = identical || (action == "abort" && entry.at("state") == "unavailable" && entry.at("job_id") == job &&
      entry.at("generation") == generation && entry.at("request_id") == input.at("request_id") && entry.at("reason") == input.at("reason"));
    return VerMutation(identical, "final", entry);
  }
  if (action == "queued") {
    if (!entry.is_null() && entry.value("submitted", false)) return VerMutation(false, "already_submitted", entry);
    if (!entry.is_null() && (entry.at("job_id") != job || entry.at("generation").get<int64_t>() > generation)) return VerMutation(false, "stale", entry);
    const auto cache_key = Sha(Json::array({owned->request.actor, owned->request.query, owned->sample.record.id, binding.at("frame_id"),
      binding.at("fingerprint"), binding.at("jpeg_sha256"), profile.at("profile_fp"), owned->kind, binding.at("question_scope")}).dump());
    auto cached = state_->One(c, "search_verification_cache", {{"_id", cache_key}, {"expires_at", {{"$gt", Date(Now())}}}});
    if (cached) {
      const auto cache = ToJson(cached.get()); const auto& result = cache.at("result");
      if (cache.dump().size() > 8192 || cache.at("result_sha") != Sha(result.dump()) || cache.at("profile_fp") != profile.at("profile_fp"))
        throw std::runtime_error("history_verification_integrity");
      VerResult(result, binding, profile, VerRequestId(result.at("request_id")), owned->kind, owned->request.query);
      entry = {{"binding", binding}, {"state", result.at("decision")}, {"job_id", nullptr}, {"generation", 0}, {"request_id", result.at("request_id")},
        {"cached", true}, {"reason", result.at("reason")}, {"submitted", false}, {"result", result}};
      records[owned->sample.record.id] = entry; save(*owned, profile, records); return VerMutation(true, "final", entry);
    }
    entry = {{"binding", binding}, {"state", "queued"}, {"job_id", job}, {"generation", generation}, {"request_id", nullptr},
      {"cached", false}, {"reason", nullptr}, {"submitted", false}, {"result", nullptr}};
    records[owned->sample.record.id] = entry; save(*owned, profile, records); return VerMutation(true, "queued", entry);
  }
  if (entry.is_null() || entry.at("job_id") != job || generation < entry.at("generation").get<int64_t>()) return VerMutation(false, "stale", entry);
  if (action == "begin") {
    const auto request_id = VerRequestId(input.at("request_id"));
    if (entry.value("submitted", false)) return VerMutation(false, "already_submitted", entry);
    entry.update({{"state", "running"}, {"generation", generation}, {"request_id", request_id}, {"submitted", true}});
    records[owned->sample.record.id] = entry; save(*owned, profile, records); return VerMutation(true, "submit", entry);
  }
  if (action == "abort") {
    const auto reason = VerText(input.at("reason"), 48);
    static const std::set<std::string> reasons{"cancelled", "request_timeout", "model_unavailable", "evidence_unavailable", "profile_changed",
      "already_submitted", "job_expired", "scope_denied", "input_too_long", "inference_failed", "search_busy", "invalid_result", "task_unavailable"};
    if (!reasons.count(reason)) throw std::invalid_argument("invalid_verification_reason");
    if (input.at("request_id") != entry.at("request_id")) return VerMutation(false, "stale", entry);
    entry.update({{"state", "unavailable"}, {"reason", reason}, {"generation", generation}, {"submitted", false}});
    records[owned->sample.record.id] = entry; save(*owned, profile, records); return VerMutation(true, "final", entry);
  }
  const auto request_id = VerRequestId(input.at("request_id"));
  if (!entry.value("submitted", false) || entry.at("state") != "running" || entry.at("request_id") != request_id || entry.at("generation") != generation)
    return VerMutation(false, "stale", entry);
  const auto& result = input.at("result"); VerResult(result, binding, profile, request_id, owned->kind, owned->request.query);
  entry.update({{"state", result.at("decision")}, {"reason", result.at("reason")}, {"result", result}, {"submitted", false}});
  records[owned->sample.record.id] = entry; save(*owned, profile, records);
  const auto cache_key = Sha(Json::array({owned->request.actor, owned->request.query, owned->sample.record.id, binding.at("frame_id"),
    binding.at("fingerprint"), binding.at("jpeg_sha256"), binding.at("profile_fp"), owned->kind, binding.at("question_scope")}).dump());
  const auto expires = std::min(Now() + 3600000, owned->sample.expires_ms);
  Json cached{{"_id", cache_key}, {"profile_fp", binding.at("profile_fp")}, {"result", result}, {"result_sha", Sha(result.dump())}, {"expires_at", Date(expires)}};
  state_->Prune(c, "search_verification_cache");
  const auto existing = state_->One(c, "search_verification_cache", {{"_id", cache_key}});
  if (cached.dump().size() <= 8192 && expires > Now() && (existing || state_->Count(c, "search_verification_cache") < std::min(state_->budget.max_searches * 5, int64_t(5000))))
    state_->Update(c, "search_verification_cache", {{"_id", cache_key}}, {{"$setOnInsert", cached}}, true);
  return VerMutation(true, "final", entry);
}
}  // namespace ainvr::search
