#include "history_mongo.hpp"
#include "observation_evidence.hpp"
#include <mongoc/mongoc.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <chrono>
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
  std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> context(EVP_MD_CTX_new(), EVP_MD_CTX_free);
  unsigned char digest[EVP_MAX_MD_SIZE]; unsigned int length = 0;
  if (!context || EVP_DigestInit_ex(context.get(), EVP_sha256(), nullptr) != 1 ||
      EVP_DigestUpdate(context.get(), data, size) != 1 || EVP_DigestFinal_ex(context.get(), digest, &length) != 1)
    throw std::runtime_error("history_hash_failed");
  const char* hex = "0123456789abcdef"; std::string out;
  for (unsigned int i = 0; i < length; ++i) { out += hex[digest[i] >> 4]; out += hex[digest[i] & 15]; }
  return out;
}
std::string Sha(const std::string& text) { return Sha(reinterpret_cast<const uint8_t*>(text.data()), text.size()); }
std::vector<uint8_t> Encode(const std::vector<float>& vector) {
  std::vector<uint8_t> out; out.reserve(vector.size() * 4);
  for (float v : vector) { uint32_t bits; std::memcpy(&bits, &v, 4); for (int i = 0; i < 4; ++i) out.push_back(uint8_t(bits >> (8 * i))); }
  return out;
}
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
int64_t DateValue(const bson_t* doc, const char* name) {
  bson_iter_t it;
  if (!bson_iter_init_find(&it, doc, name) || !BSON_ITER_HOLDS_DATE_TIME(&it)) throw std::runtime_error("history_date_missing");
  return bson_iter_date_time(&it);
}
Json Metadata(const Sample& s) {
  const auto& r = s.record;
  return {{"id", r.id}, {"channel", r.channel}, {"processor", r.processor}, {"session", r.session},
    {"track", r.track}, {"model", r.model}, {"captured_ms", r.captured_ms}, {"scene", r.scene},
    {"evidence", s.evidence}, {"vector_format", "f32le"}, {"dimensions", r.vector.size()}, {"expires_ms", s.expires_ms}};
}
Json ReadMetadata(const bson_t* doc) {
  bson_iter_t it; const uint8_t* data; uint32_t size;
  if (!bson_iter_init_find(&it, doc, "metadata") || !BSON_ITER_HOLDS_DOCUMENT(&it)) throw std::runtime_error("history_metadata_missing");
  bson_iter_document(&it, &size, &data); bson_t view;
  if (!bson_init_static(&view, data, size)) throw std::runtime_error("history_metadata_invalid");
  return ToJson(&view);
}
Sample Decode(const bson_t* doc, bool image) {
  auto meta = ReadMetadata(doc); auto vector = Binary(doc, "vector");
  if (Text(doc, "metadata_sha") != Sha(meta.dump()) || Text(doc, "vector_sha") != Sha(vector.data(), vector.size()))
    throw std::runtime_error("history_integrity_mismatch");
  if (meta.at("vector_format") != "f32le" || vector.size() % 4 || vector.size() / 4 != meta.at("dimensions").get<size_t>())
    throw std::runtime_error("history_vector_format");
  Sample s; s.fingerprint = Text(doc, "fingerprint");
  if (s.fingerprint != Sha(Text(doc, "metadata_sha") + Text(doc, "vector_sha") + Text(doc, "jpeg_sha")))
    throw std::runtime_error("history_fingerprint_mismatch");
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
  for (size_t at = 0; at < vector.size(); at += 4) {
    uint32_t bits = 0; for (int i = 0; i < 4; ++i) bits |= uint32_t(vector[at + i]) << (8 * i);
    float v; std::memcpy(&v, &bits, 4); r.vector.push_back(v);
  }
  NormalizeVector(r.vector, r.vector.size());
  if (r.id != Text(doc, "_id") || r.channel != Text(doc, "channel") || r.model != Text(doc, "model") || r.captured_ms != Number(doc, "captured_ms") || s.expires_ms != DateValue(doc, "expires_at"))
    throw std::runtime_error("history_identity_mismatch");
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
Json ReadShortlist(const bson_t* doc) {
  const auto row = ToJson(doc); const auto& shortlist = row.at("shortlist");
  if (row.at("shortlist_sha") != Sha(shortlist.dump()) || shortlist.at("version") != row.at("version") ||
      !shortlist.at("slots").is_array() || shortlist.at("slots").size() > 60)
    throw std::runtime_error("search_shortlist_integrity");
  return shortlist;
}
std::string NewSearchVersion() {
  uint8_t bytes[32]; if (RAND_bytes(bytes, sizeof(bytes)) != 1) throw std::runtime_error("search_nonce_failed");
  return Sha(bytes, sizeof(bytes));
}
}  // namespace

struct HistoryMongo::State {
  mongoc_client_pool_t* pool = nullptr;
  std::string database; HistoryBudget budget; std::mutex mutex;
  Json cached_usage; int64_t usage_at = 0;
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
  void Each(Client& c, const char* name, const Json& query, Json options, Visit visit) {
    options["maxTimeMS"] = 5000; Bson filter(query), opts(options); auto collection = Collection(c, name);
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
      Delete(c, name, {{"_id", {{"$in", ids}}}});
    }
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
    const auto deleted = DeletedRanges(c, scope); std::map<std::string, Sample> found;
    Each(c, "search_samples", {{"_id", {{"$in", ids}}}, {"expires_at", {{"$gt", Date(Now())}}}},
      {{"limit", 60}, {"projection", {{"jpeg", 0}}}}, [&](const bson_t* doc) {
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
}
HistoryMongo::~HistoryMongo() = default;
void HistoryMongo::Initialize() {
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_);
  for (const auto* name : {"search_samples", "search_coverage", "search_deletions", "search_sessions"}) {
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
    {{"key", {{"metadata.channel", 1}, {"metadata.processor", 1}, {"metadata.session", 1},
              {"metadata.track", 1}, {"metadata.model", 1}, {"metadata.scene", 1}}}, {"name", "search_track_identity"}}
  })}});
  state_->Command(c, {{"createIndexes", "search_samples"}, {"indexes", Json::array({
    {{"key", {{"metadata.channel", 1}, {"metadata.processor", 1}, {"metadata.session", 1},
              {"metadata.track", 1}, {"metadata.model", 1}, {"track_slot", 1}}},
     {"name", "search_track_slot"}, {"unique", true}, {"partialFilterExpression", {{"track_slot", {{"$exists", true}}}}}}
  })}});
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
                                     const std::string& replacement_token) {
  const auto& r = sample.record; const auto now = Now(); Uuid(r.id); Uuid(r.channel);
  VectorIndex validator(r.model, r.vector.size(), 1); validator.Upsert(r);
  if (!sample.evidence.is_object() || sample.evidence.dump().size() > 16384 || r.model.size() > 128 ||
      r.captured_ms > now + 60000 || sample.expires_ms <= std::max(now, r.captured_ms) || sample.expires_ms > r.captured_ms + state_->budget.retention_ms ||
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
  auto metadata = Metadata(sample); const auto vector = Encode(r.vector);
  const auto metaSha = Sha(metadata.dump()), vectorSha = Sha(vector.data(), vector.size()), jpegSha = Sha(sample.jpeg.data(), sample.jpeg.size());
  const auto fingerprint = Sha(metaSha + vectorSha + jpegSha);
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_);
  if (state_->Deleted(c, r)) throw std::runtime_error("search_sample_deleted");
  auto old = state_->One(c, "search_samples", {{"_id", r.id}});
  int64_t old_bytes = 0;
  if (old) {
    const auto previous = Decode(old.get(), true);
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
    if (usage.at("samples").get<int64_t>() >= state_->budget.max_samples) throw std::runtime_error("search_history_capacity");
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
  if (usage.at("bytes").get<int64_t>() - old_bytes + doc.value->len > state_->budget.max_bytes) throw std::runtime_error("search_history_capacity");
  bson_iter_t bytes; bson_iter_init_find(&bytes, doc.value, "bytes"); bson_iter_overwrite_int64(&bytes, doc.value->len);
  auto collection = state_->Collection(c, "search_samples"); Bson opts(Json{{"writeConcern", {{"w", 1}, {"j", true}, {"wtimeout", 5000}}}});
  bson_error_t error{}; bson_t reply; bool ok; int64_t matched = 1;
  if (old) {
    Bson filter({{"_id", r.id}, {"fingerprint", expected_fingerprint}});
    ok = mongoc_collection_replace_one(collection.get(), filter, doc, opts, &reply, &error);
    bson_iter_t count;
    matched = bson_iter_init_find(&count, &reply, "matchedCount") && BSON_ITER_HOLDS_NUMBER(&count) ? bson_iter_as_int64(&count) : 0;
  } else {
    ok = mongoc_collection_insert_one(collection.get(), doc, opts, &reply, &error);
  }
  bson_destroy(&reply);
  if (!ok || matched != 1) {
    state_->cached_usage = Json();
    if (!ok) Fail(error);
    throw std::runtime_error("search_slot_conflict");
  }
  state_->cached_usage = {{"samples", usage.at("samples").get<int64_t>() + (old ? 0 : 1)},
                         {"bytes", usage.at("bytes").get<int64_t>() - old_bytes + doc.value->len}};
  return fingerprint;
}
std::optional<Sample> HistoryMongo::Get(const std::string& id, bool include_image) {
  Uuid(id); std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_);
  return state_->VisibleSample(c, id, include_image);
}
HistoryBatch HistoryMongo::Scan(const std::string& model, const Scope& scope, int64_t after, size_t limit) {
  Range(scope); if (model.empty() || model.size() > 128 || after < 0 || limit < 1 || limit > 1000) throw std::invalid_argument("invalid_history_page");
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_); HistoryBatch out; out.checkpoint = after;
  const auto deleted = state_->DeletedRanges(c, scope);
  const std::vector<std::string> channels(scope.channels.begin(), scope.channels.end());
  state_->Each(c, "search_samples", {{"model", model}, {"channel", {{"$in", channels}}},
    {"captured_ms", {{"$gte", scope.from_ms}, {"$lt", scope.to_ms}}}, {"ordinal", {{"$gt", after}}}, {"expires_at", {{"$gt", Date(Now())}}}},
    {{"sort", {{"ordinal", 1}}}, {"limit", limit}, {"projection", {{"jpeg", 0}}}}, [&](const bson_t* doc) {
      out.checkpoint = Number(doc, "ordinal");
      const auto channel = Text(doc, "channel"); const auto captured = Number(doc, "captured_ms");
      for (const auto& range : deleted)
        if (range.at("channel") == channel && range.at("from").get<int64_t>() <= captured && range.at("to").get<int64_t>() > captured) return;
      out.samples.push_back(Decode(doc, false));
    }); return out;
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
  state_->Update(c, "search_coverage", {{"_id", id}}, {{"$setOnInsert", identity}, {"$max", {{"rank", rank}}}}, true);
}
Json HistoryMongo::Coverage(const std::string& model, const Scope& scope) {
  Range(scope); std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_); Json out = Json::array();
  const auto deleted = state_->DeletedRanges(c, scope);
  const std::vector<std::string> channels(scope.channels.begin(), scope.channels.end());
  state_->Each(c, "search_coverage", {{"model", model}, {"channel", {{"$in", channels}}}, {"from", {{"$lt", scope.to_ms}}},
    {"to", {{"$gt", scope.from_ms}}}, {"expires_at", {{"$gt", Date(Now())}}}}, {{"sort", {{"from", 1}, {"_id", 1}}}, {"limit", 10001}},
    [&](const bson_t* doc) {
      const auto row = ToJson(doc); const auto rank = row.at("rank").get<int>();
      for (const auto& range : deleted)
        if (range.at("channel") == row.at("channel") && range.at("from").get<int64_t>() < row.at("to").get<int64_t>() && range.at("to").get<int64_t>() > row.at("from").get<int64_t>()) return;
      out.push_back({{"channel", row.at("channel")}, {"from", std::max(scope.from_ms, row.at("from").get<int64_t>())},
        {"to", std::min(scope.to_ms, row.at("to").get<int64_t>())}, {"scene", row.at("scene")}, {"state", rank == 2 ? "sampled" : rank == 1 ? "gap" : "pending"}});
    });
  if (out.size() > 10000) throw std::runtime_error("coverage_range_too_large");
  return out;
}
void HistoryMongo::DeleteRange(const std::string& channel, int64_t from, int64_t to) {
  Range({{channel}, from, to, 20});
  if (to > Now() + 60000) throw std::invalid_argument("invalid_delete_range");
  const auto key = Sha(channel + ":" + std::to_string(from) + ":" + std::to_string(to));
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_);
  state_->cached_usage = Json();
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
    {"fingerprint", fingerprint}, {"version", version}, {"cancelled", false}, {"expires_at", Date(request.expires_ms)}}}}, true);
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
  }
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
    slots.push_back({{"id", candidate.sample_id}, {"score", candidate.similarity}, {"fingerprint", sample->second.fingerprint}});
  }
  Json shortlist = {{"version", version}, {"coverage", actual_coverage}, {"slots", slots}};
  if (shortlist.dump().size() > 16384) throw std::invalid_argument("search_shortlist_size");
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
  const auto end = std::min(slots.size(), offset + limit);
  for (size_t i = offset; i < end; ++i) {
    const std::string sample_id = slots[i].at("id"); Uuid(sample_id);
    auto sample = available.find(sample_id); if (sample == available.end()) continue;
    const auto& r = sample->second.record;
    if (r.model != page.request.model || !page.request.scope.channels.count(r.channel) || r.captured_ms < page.request.scope.from_ms || r.captured_ms >= page.request.scope.to_ms)
      throw std::runtime_error("search_session_scope_mismatch");
    std::optional<bool> relevant;
    if (row.contains("feedback") && row.at("feedback").contains(sample_id)) relevant = row.at("feedback").at(sample_id).get<bool>();
    page.items.push_back({std::move(sample->second), slots[i].at("score").get<double>(), relevant});
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
  auto sample = state_->OwnedSample(c, doc.get(), sample_id, true);
  if (!sample || sample->evidence.at("frame_id") != frame_id || DateValue(doc.get(), "expires_at") <= Now()) return std::nullopt;
  return sample;
}
void HistoryMongo::CancelSearch(const std::string& id, const std::string& actor) {
  const auto key = SearchKey(id, actor);
  std::lock_guard<std::mutex> lock(state_->mutex); State::Client c(*state_);
  if (!state_->Search(c, key)) state_->AdmitSearch(c, key);
  // A cancel-before-open tombstone prevents a late HTTP submission from opening
  // this same request. Repeated cancellation does not extend its expiry.
  state_->Update(c, "search_sessions", {{"_id", key}}, {{"$setOnInsert", {{"expires_at", Date(Now() + 3600000)}}},
    {"$set", {{"cancelled", true}}}, {"$unset", {{"shortlist", ""}, {"shortlist_sha", ""}, {"feedback", ""}}}}, true);
}
}  // namespace ainvr::search
