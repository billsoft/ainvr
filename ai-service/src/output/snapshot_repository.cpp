#include "snapshot_internal.hpp"

namespace ai_service::output {
using namespace snapshot_detail;
namespace snapshot_detail {
int64_t CountHistory(mongoc_collection_t* collection) {
  bson_t filter, opts;
  bson_init(&filter); bson_init(&opts);
  BSON_APPEND_UTF8(&opts, "hint", "_id_");
  bson_error_t error{};
  auto count = mongoc_collection_count_documents(collection, &filter, &opts, nullptr, nullptr, &error);
  bson_destroy(&filter); bson_destroy(&opts);
  if (count < 0) throw std::runtime_error(BsonErrorMessage(error));
  return count;
}

// With a known count, seek only the excess oldest IDs (normally <=20), not
// max_count newest IDs (100,000 on production). Caller serializes mutations.
void TrimHistory(mongoc_collection_t* collection, int64_t max_count,
                                    std::optional<int64_t>& count) {
  try {
    if (!count) count = CountHistory(collection);
    const int64_t excess = *count - std::max(int64_t(0), max_count);
    if (excess <= 0) return;
    bson_error_t error{};
    bson_t filter; bson_init(&filter);
    auto options = json{{"sort", {{"_id", 1}}}, {"skip", excess - 1}, {"limit", 1},
                        {"hint", "_id_"}, {"projection", {{"_id", 1}}}}.dump();
    bson_t* opts = bson_new_from_json(reinterpret_cast<const uint8_t*>(options.c_str()), -1, &error);
    auto* cursor = mongoc_collection_find_with_opts(collection, &filter, opts, nullptr);
    const bson_t* doc = nullptr;
    bson_oid_t boundary{};
    bool found = false;
    if (mongoc_cursor_next(cursor, &doc)) {
      bson_iter_t it;
      if (bson_iter_init_find(&it, doc, "_id") && BSON_ITER_HOLDS_OID(&it)) {
        bson_oid_copy(bson_iter_oid(&it), &boundary); found = true;
      }
    }
    const bool failed = mongoc_cursor_error(cursor, &error);
    mongoc_cursor_destroy(cursor); bson_destroy(opts); bson_destroy(&filter);
    if (failed) throw std::runtime_error(BsonErrorMessage(error));
    if (!found) throw std::runtime_error("history count changed outside archive service");
    bson_t stale, range;
    bson_init(&stale);
    BSON_APPEND_DOCUMENT_BEGIN(&stale, "_id", &range);
    BSON_APPEND_OID(&range, "$lte", &boundary);
    bson_append_document_end(&stale, &range);
    // No caller consumes deleted image IDs. The indexed boundary is sufficient:
    // avoid an extra round trip and materialization on every rolling trim.
    bson_t reply;
    bool ok = mongoc_collection_delete_many(collection, &stale, nullptr, &reply, &error);
    bson_destroy(&stale);
    bson_iter_t deleted;
    if (ok && bson_iter_init_find(&deleted, &reply, "deletedCount"))
      *count -= bson_iter_as_int64(&deleted);
    else count.reset();
    bson_destroy(&reply);
    if (!ok) throw std::runtime_error(BsonErrorMessage(error));
  } catch (...) { count.reset(); throw; }
}
}  // namespace

void SnapshotStore::WriteBatch(std::vector<ArchiveJob>& jobs) {
  if (std::any_of(jobs.begin(), jobs.end(), [](const ArchiveJob& job) { return job.jpeg.empty(); }))
    PrepareBatch(jobs);
  if (jobs.empty()) return;
  const double mongo_start = NowMono();
  std::lock_guard<std::mutex> history_lock(history_mutex_);
  const double history_wait_ms = (NowMono() - mongo_start) * 1000;
  deletions_.Flush();
  for (auto it = jobs.begin(); it != jobs.end();) {
    if (!deletions_.Matches(it->archive_epoch, it->image_id, it->timestamp)) { ++it; continue; }
    RemovePending(it->image_id);
    Finish(it->image_id, "deleted");
    it = jobs.erase(it);
  }
  if (jobs.empty()) return;
  for (const auto& job : jobs) Track(job.image_id, "writing_mongo");
  PooledClient pc(pool_);
  ScopedCollection coll(pc.get(), db_name_, collection_name_);
  bson_t opts, wc;
  bson_init(&opts);
  BSON_APPEND_BOOL(&opts, "ordered", true);
  BSON_APPEND_DOCUMENT_BEGIN(&opts, "writeConcern", &wc);
  BSON_APPEND_INT32(&wc, "w", 1);
  BSON_APPEND_BOOL(&wc, "j", true);
  BSON_APPEND_INT32(&wc, "wtimeout", 5000);
  bson_append_document_end(&opts, &wc);
  auto* bulk = mongoc_collection_create_bulk_operation_with_opts(coll.get(), &opts);
  bson_destroy(&opts);
  if (!bulk) throw std::runtime_error("Cannot create snapshot write batch");
  try {
    for (const auto& job : jobs) AppendWrite(bulk, job);
    bson_error_t error{};
    bson_t reply;
    const bool ok = mongoc_bulk_operation_execute(bulk, &reply, &error) != 0;
    bson_iter_t inserted;
    if (ok && history_count_ && bson_iter_init_find(&inserted, &reply, "nUpserted"))
      *history_count_ += bson_iter_as_int64(&inserted);
    else history_count_.reset();
    bson_destroy(&reply);
    if (!ok) throw std::runtime_error(BsonErrorMessage(error));
  } catch (...) {
    history_count_.reset();
    mongoc_bulk_operation_destroy(bulk);
    throw;
  }
  mongoc_bulk_operation_destroy(bulk);
  {
    std::lock_guard<std::mutex> lock(stats_mutex_);
    last_mongo_ms_ = (NowMono() - mongo_start) * 1000;
    mongo_max_ms_ = std::max(mongo_max_ms_, last_mongo_ms_);
    last_history_wait_ms_ = history_wait_ms;
    if (last_mongo_ms_ >= 100) ++mongo_slow_batches_;
  }
  if (!pending_dir_.empty()) {
    for (const auto& job : jobs)
      RemovePending(job.image_id);
  }
  for (const auto& job : jobs) Finish(job.image_id, "committed");
}

void SnapshotStore::AppendWrite(mongoc_bulk_operation_t* bulk, const ArchiveJob& job) {

  const Detection& d = job.detection;
  bson_t doc;
  bson_init(&doc);
  BSON_APPEND_OID(&doc, "_id", &job.oid);
  BSON_APPEND_UTF8(&doc, "image_id", job.image_id.c_str());
  BSON_APPEND_INT64(&doc, "archive_epoch", static_cast<int64_t>(job.archive_epoch));
  BSON_APPEND_UTF8(&doc, "channel_id", job.channel_id.c_str());
  BSON_APPEND_UTF8(&doc, "channel_name", job.channel_name.c_str());
  BSON_APPEND_INT64(&doc, "frame_pts_ns", job.frame_pts_ns);
  BSON_APPEND_DOUBLE(&doc, "timestamp", job.timestamp);
  BSON_APPEND_UTF8(&doc, "model_name", job.model_name.c_str());
  BSON_APPEND_UTF8(&doc, "task_type", job.task_type.c_str());
  BSON_APPEND_INT32(&doc, "class_id", d.class_id);
  BSON_APPEND_UTF8(&doc, "class_name", d.class_name.c_str());
  if (d.confidence_known) BSON_APPEND_DOUBLE(&doc, "confidence", d.confidence);
  else BSON_APPEND_NULL(&doc, "confidence");
  if (!d.label_id.empty()) BSON_APPEND_UTF8(&doc, "label_id", d.label_id.c_str());
  if (!d.track_id.empty()) BSON_APPEND_UTF8(&doc, "track_id", d.track_id.c_str());
  if (!d.query_description.empty()) BSON_APPEND_UTF8(&doc, "query_description", d.query_description.c_str());
  if (!d.model_extra.empty()) {
    const auto text = d.model_extra.dump();
    bson_t* extra = bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()), text.size(), nullptr);
    if (!extra) { bson_destroy(&doc); throw std::runtime_error("invalid grounding metadata"); }
    BSON_APPEND_DOCUMENT(&doc, "model_extra", extra);
    bson_destroy(extra);
  }

  if (job.point.is_null()) {
    bson_t bbox_doc;
    BSON_APPEND_DOCUMENT_BEGIN(&doc, "bbox", &bbox_doc);
    BSON_APPEND_DOUBLE(&bbox_doc, "x", d.bbox[0]);
    BSON_APPEND_DOUBLE(&bbox_doc, "y", d.bbox[1]);
    BSON_APPEND_DOUBLE(&bbox_doc, "w", d.bbox[2]);
    BSON_APPEND_DOUBLE(&bbox_doc, "h", d.bbox[3]);
    bson_append_document_end(&doc, &bbox_doc);
  } else {
    BSON_APPEND_NULL(&doc, "bbox");
    BSON_APPEND_UTF8(&doc, "geometry_type", "point");
    BSON_APPEND_UTF8(&doc, "context_image", "full_frame");
    const auto text = job.point.dump();
    bson_t* point = bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()), text.size(), nullptr);
    if (!point) { bson_destroy(&doc); throw std::runtime_error("Invalid archive point metadata"); }
    BSON_APPEND_DOCUMENT(&doc, "point", point);
    bson_destroy(point);
  }

  if (d.landmarks.has_value() && !d.landmarks->empty()) {
    bson_t lm_arr;
    BSON_APPEND_ARRAY_BEGIN(&doc, "landmarks", &lm_arr);
    for (size_t i = 0; i < d.landmarks->size(); ++i) {
      bson_t pt;
      BSON_APPEND_DOCUMENT_BEGIN(&lm_arr, std::to_string(i).c_str(), &pt);
      BSON_APPEND_DOUBLE(&pt, "x", (*d.landmarks)[i][0]);
      BSON_APPEND_DOUBLE(&pt, "y", (*d.landmarks)[i][1]);
      bson_append_document_end(&lm_arr, &pt);
    }
    bson_append_array_end(&doc, &lm_arr);
  } else {
    BSON_APPEND_NULL(&doc, "landmarks");
  }

  bson_t image_doc;
  BSON_APPEND_DOCUMENT_BEGIN(&doc, "image", &image_doc);
  BSON_APPEND_UTF8(&image_doc, "format", "jpg");
  BSON_APPEND_INT32(&image_doc, "width", job.image_width);
  BSON_APPEND_INT32(&image_doc, "height", job.image_height);
  bson_append_binary(&image_doc, "data", -1, BSON_SUBTYPE_BINARY, job.jpeg.data(),
                     static_cast<uint32_t>(job.jpeg.size()));
  bson_append_document_end(&doc, &image_doc);
  bson_t original_doc;
  BSON_APPEND_DOCUMENT_BEGIN(&doc, "original_image", &original_doc);
  BSON_APPEND_UTF8(&original_doc, "format", "jpg");
  BSON_APPEND_INT32(&original_doc, "width", job.crop.cols);
  BSON_APPEND_INT32(&original_doc, "height", job.crop.rows);
  bson_append_binary(&original_doc, "data", -1, BSON_SUBTYPE_BINARY, job.original_jpeg.data(),
                    static_cast<uint32_t>(job.original_jpeg.size()));
  bson_append_document_end(&doc, &original_doc);

  BSON_APPEND_BOOL(&doc, "enhanced", job.enhanced);
  if (job.enhanced) {
    BSON_APPEND_UTF8(&doc, "enhance_model", job.enhance_model.c_str());
  } else {
    BSON_APPEND_NULL(&doc, "enhance_model");
  }
  BSON_APPEND_BOOL(&doc, "brightness_corrected", job.brightness_applied);
  BSON_APPEND_NULL(&doc, "embedding");
  BSON_APPEND_NULL(&doc, "embedding_model");

  {
    bson_error_t error;
    bson_t opts, filter;
    bson_init(&opts);
    bson_init(&filter);
    BSON_APPEND_OID(&filter, "_id", &job.oid);
    BSON_APPEND_BOOL(&opts, "upsert", true);
    bool ok = mongoc_bulk_operation_replace_one_with_opts(bulk, &filter, &doc, &opts, &error);
    bson_destroy(&filter);
    bson_destroy(&opts);
    bson_destroy(&doc);
    if (!ok) throw std::runtime_error(BsonErrorMessage(error));
  }
}

// ---- 管理 API ----

namespace {
json NotConnectedOverview(int64_t max_count, const std::optional<std::string>& err) {
  return json{
      {"enabled", true},      {"connected", false},         {"last_error", err.has_value() ? json(*err) : json(nullptr)},
      {"count", 0},           {"max_count", max_count},     {"storage_bytes", 0},
      {"earliest_timestamp", nullptr}, {"latest_timestamp", nullptr},
  };
}
}  // namespace

json SnapshotStore::GetOverview() const {
  int64_t max_count;
  {
    std::lock_guard<std::mutex> lock(cfg_mutex_);
    max_count = cfg_.max_count;
  }
  if (!connected_.load()) {
    std::lock_guard<std::mutex> lock(connect_mutex_);
    return NotConnectedOverview(max_count, last_connect_error_);
  }

  try {
    PooledClient pc(pool_);
    ScopedCollection coll(pc.get(), db_name_, collection_name_);
    bson_error_t error;
    bson_t* filter = bson_new();
    bson_t count_opts;
    bson_init(&count_opts);
    BSON_APPEND_UTF8(&count_opts, "hint", "_id_");
    int64_t count =
        mongoc_collection_count_documents(coll.get(), filter, &count_opts, nullptr, nullptr, &error);
    bson_destroy(&count_opts);
    bson_destroy(filter);
    if (count < 0) throw std::runtime_error(BsonErrorMessage(error));

    int64_t storage_bytes = 0;
    {
      std::string cmd_json = "{\"collStats\": \"" + collection_name_ + "\"}";
      bson_t* cmd = bson_new_from_json(reinterpret_cast<const uint8_t*>(cmd_json.c_str()), -1, nullptr);
      bson_t reply;
      if (mongoc_client_command_simple(pc.get(), db_name_.c_str(), cmd, nullptr, &reply, &error)) {
        bson_iter_t it;
        if (bson_iter_init_find(&it, &reply, "size")) {
          storage_bytes = bson_iter_as_int64(&it);
        }
      }
      bson_destroy(&reply);
      bson_destroy(cmd);
    }

    std::optional<double> earliest, latest;
    {
      bson_t* f = bson_new();
      bson_t* opts_asc = bson_new_from_json(
          reinterpret_cast<const uint8_t*>("{\"sort\": {\"_id\": 1}, \"limit\": 1, \"projection\": {\"timestamp\": 1}}"),
          -1, nullptr);
      mongoc_cursor_t* c1 = mongoc_collection_find_with_opts(coll.get(), f, opts_asc, nullptr);
      const bson_t* doc;
      if (mongoc_cursor_next(c1, &doc)) {
        bson_iter_t it;
        if (bson_iter_init_find(&it, doc, "timestamp")) earliest = bson_iter_as_double(&it);
      }
      mongoc_cursor_destroy(c1);
      bson_destroy(opts_asc);

      bson_t* opts_desc = bson_new_from_json(
          reinterpret_cast<const uint8_t*>("{\"sort\": {\"_id\": -1}, \"limit\": 1, \"projection\": {\"timestamp\": 1}}"),
          -1, nullptr);
      mongoc_cursor_t* c2 = mongoc_collection_find_with_opts(coll.get(), f, opts_desc, nullptr);
      if (mongoc_cursor_next(c2, &doc)) {
        bson_iter_t it;
        if (bson_iter_init_find(&it, doc, "timestamp")) latest = bson_iter_as_double(&it);
      }
      mongoc_cursor_destroy(c2);
      bson_destroy(opts_desc);
      bson_destroy(f);
    }

    return json{
        {"enabled", true},
        {"connected", true},
        {"last_error", nullptr},
        {"count", count},
        {"max_count", max_count},
        {"storage_bytes", storage_bytes},
        {"earliest_timestamp", earliest.has_value() ? json(*earliest) : json(nullptr)},
        {"latest_timestamp", latest.has_value() ? json(*latest) : json(nullptr)},
    };
  } catch (const std::exception& e) {
    connected_.store(false);
    std::lock_guard<std::mutex> lock(connect_mutex_);
    last_connect_error_ = e.what();
    return NotConnectedOverview(max_count, last_connect_error_);
  }
}

json SnapshotStore::ListPage(std::optional<std::string> cursor, int limit, double min_confidence,
                             std::optional<double> from_ts, std::optional<double> to_ts) const {
  if (!connected_.load()) throw SnapshotUnavailable();

  std::ostringstream filter_oss;
  filter_oss << "{";
  bool first = true;
  auto sep = [&] {
    if (!first) filter_oss << ",";
    first = false;
  };
  if (cursor.has_value()) {
    // 游标是上一页最后一条的 ObjectId;格式不对就是无效游标,返回空页。
    if (!IsObjectIdHex(*cursor)) return json{{"items", json::array()}, {"next_cursor", nullptr}};
    sep();
    filter_oss << "\"_id\": {\"$lt\": {\"$oid\": \"" << *cursor << "\"}}";
  }
  if (min_confidence > 0.0) {
    sep();
    filter_oss << "\"$or\": [{\"confidence\": null}, {\"confidence\": {\"$gte\": " << JsonNum(min_confidence) << "}}]";
  }
  if (from_ts.has_value() || to_ts.has_value()) {
    sep();
    filter_oss << "\"timestamp\": " << TsRangeJson(from_ts, to_ts);
  }
  filter_oss << "}";

  try {
    PooledClient pc(pool_);
    ScopedCollection coll(pc.get(), db_name_, collection_name_);
    bson_error_t error;
    bson_t* filter =
        bson_new_from_json(reinterpret_cast<const uint8_t*>(filter_oss.str().c_str()), -1, &error);
    if (!filter) return json{{"items", json::array()}, {"next_cursor", nullptr}};

    std::string opts_json = "{\"sort\": {\"_id\": -1}, \"limit\": " + std::to_string(limit) +
                            ", \"projection\": {\"image.data\": 0, \"original_image\": 0}}";
    bson_t* opts = bson_new_from_json(reinterpret_cast<const uint8_t*>(opts_json.c_str()), -1, nullptr);

    mongoc_cursor_t* c = mongoc_collection_find_with_opts(coll.get(), filter, opts, nullptr);
    json items = json::array();
    std::string last_id;
    int count = 0;
    const bson_t* doc;
    while (mongoc_cursor_next(c, &doc)) {
      // 游标直接取 BSON 的 _id,不依赖下面 JSON 解析是否成功。
      bson_iter_t id_it;
      if (bson_iter_init_find(&id_it, doc, "_id") && BSON_ITER_HOLDS_OID(&id_it)) {
        char oid_str[25];
        bson_oid_to_string(bson_iter_oid(&id_it), oid_str);
        last_id = oid_str;
      }
      char* doc_json = bson_as_relaxed_extended_json(doc, nullptr);
      json raw = json::parse(doc_json, nullptr, false);
      bson_free(doc_json);
      if (!raw.is_discarded()) items.push_back(DocToListItem(raw));
      count++;
    }
    const bool failed = mongoc_cursor_error(c, &error);
    mongoc_cursor_destroy(c);
    bson_destroy(opts);
    bson_destroy(filter);
    if (failed) throw std::runtime_error(BsonErrorMessage(error));

    return json{{"items", items}, {"next_cursor", count == limit ? json(last_id) : json(nullptr)}};
  } catch (const std::exception& e) {
    connected_.store(false);
    std::lock_guard<std::mutex> lock(connect_mutex_);
    last_connect_error_ = e.what();
    throw SnapshotUnavailable();
  }
}

json SnapshotStore::Heatmap(std::optional<double> from_ts, std::optional<double> to_ts,
                            int bucket_s) const {
  bucket_s = std::clamp(bucket_s, 30, 3600);
  if (!connected_.load()) throw SnapshotUnavailable();

  // 没给范围时也必须是一个合法的管道阶段:空的 {} 不是阶段,聚合会直接报错。
  std::string match_stage = "{\"$match\": {}}";
  if (from_ts.has_value() || to_ts.has_value()) {
    match_stage = "{\"$match\": {\"timestamp\": " + TsRangeJson(from_ts, to_ts) + "}}";
  }

  std::ostringstream pipeline_oss;
  pipeline_oss << "[" << match_stage << ","
              << "{\"$group\": {\"_id\": {\"$toInt\": {\"$floor\": {\"$divide\": [\"$timestamp\", "
              << bucket_s << "]}}}, \"count\": {\"$sum\": 1}}},"
              << "{\"$sort\": {\"_id\": 1}},"
              << "{\"$project\": {\"_id\": 0, \"t\": {\"$multiply\": [\"$_id\", " << bucket_s
              << "]}, \"count\": 1}}]";

  try {
    PooledClient pc(pool_);
    ScopedCollection coll(pc.get(), db_name_, collection_name_);
    bson_error_t error;
    bson_t* pipeline =
        bson_new_from_json(reinterpret_cast<const uint8_t*>(pipeline_oss.str().c_str()), -1, &error);
    if (!pipeline) throw SnapshotUnavailable();

    mongoc_cursor_t* c =
        mongoc_collection_aggregate(coll.get(), MONGOC_QUERY_NONE, pipeline, nullptr, nullptr);
    json buckets = json::array();
    const bson_t* doc;
    while (mongoc_cursor_next(c, &doc)) {
      char* doc_json = bson_as_relaxed_extended_json(doc, nullptr);
      json item = json::parse(doc_json, nullptr, false);
      bson_free(doc_json);
      if (!item.is_discarded()) buckets.push_back(std::move(item));
    }
    const bool failed = mongoc_cursor_error(c, &error);
    mongoc_cursor_destroy(c);
    bson_destroy(pipeline);
    if (failed) throw std::runtime_error(BsonErrorMessage(error));

    return json{{"enabled", true}, {"bucket_s", bucket_s}, {"count", buckets.size()}, {"buckets", buckets}};
  } catch (const std::exception& e) {
    connected_.store(false);
    std::lock_guard<std::mutex> lock(connect_mutex_);
    last_connect_error_ = e.what();
    throw SnapshotUnavailable();
  }
}

std::optional<std::vector<uint8_t>> SnapshotStore::GetImage(const std::string& image_id, bool original) const {
  if (!connected_.load()) throw SnapshotUnavailable();
  try {
    PooledClient pc(pool_);
    ScopedCollection coll(pc.get(), db_name_, collection_name_);
    std::string filter_json = "{\"image_id\": " + JsonStr(image_id) + "}";
    bson_t* filter =
        bson_new_from_json(reinterpret_cast<const uint8_t*>(filter_json.c_str()), -1, nullptr);
    // 解析失败绝不能带着空 filter 去查/删(空 filter 在 delete 上等于全表)
    if (!filter) return {};
    const char* field = original ? "original_image.data" : "image.data";
    auto projection = json{{"projection", {{field, 1}}}}.dump();
    bson_t* opts = bson_new_from_json(
        reinterpret_cast<const uint8_t*>(projection.c_str()), -1, nullptr);
    mongoc_cursor_t* c = mongoc_collection_find_with_opts(coll.get(), filter, opts, nullptr);
    const bson_t* doc;
    std::optional<std::vector<uint8_t>> result;
    if (mongoc_cursor_next(c, &doc)) {
      bson_iter_t it, image_it, data_it;
      if (bson_iter_init(&it, doc) && bson_iter_find_descendant(&it, field, &data_it) &&
          BSON_ITER_HOLDS_BINARY(&data_it)) {
        bson_subtype_t subtype;
        uint32_t len;
        const uint8_t* bin;
        bson_iter_binary(&data_it, &subtype, &len, &bin);
        result = std::vector<uint8_t>(bin, bin + len);
      }
    }
    bson_error_t error{};
    const bool failed = mongoc_cursor_error(c, &error);
    mongoc_cursor_destroy(c);
    bson_destroy(opts);
    bson_destroy(filter);
    if (failed) throw std::runtime_error(BsonErrorMessage(error));
    return result;
  } catch (const std::exception& e) {
    connected_.store(false);
    std::lock_guard<std::mutex> lock(connect_mutex_);
    last_connect_error_ = e.what();
    throw SnapshotUnavailable();
  }
}

int64_t SnapshotStore::ApplyDeletionRules(mongoc_collection_t* collection) {
  deletions_.Flush();
  int64_t deleted = 0;
  for (const auto& rule : deletions_.Rules()) {
    const auto epoch = rule.at("epoch").get<uint64_t>();
    if (epoch <= applied_deletion_epoch_) continue;
    // Legacy documents have no epoch and belong to generation zero.
    json query = rule.at("filter");
    query["$or"] = json::array({
      {{"archive_epoch", {{"$lt", rule.at("epoch")}}}},
      {{"archive_epoch", {{"$exists", false}}}}
    });
    const auto encoded = query.dump();
    bson_error_t error{};
    bson_t* filter = bson_new_from_json(reinterpret_cast<const uint8_t*>(encoded.c_str()), -1, &error);
    if (!filter) throw SnapshotUnavailable();
    bson_t options;
    bson_init(&options);
    bson_t concern;
    BSON_APPEND_DOCUMENT_BEGIN(&options, "writeConcern", &concern);
    BSON_APPEND_INT32(&concern, "w", 1);
    BSON_APPEND_BOOL(&concern, "j", true);
    BSON_APPEND_INT32(&concern, "wtimeout", 5000);
    bson_append_document_end(&options, &concern);
    bson_t reply;
    bool ok = mongoc_collection_delete_many(collection, filter, &options, &reply, &error);
    bson_iter_t count;
    if (ok && bson_iter_init_find(&count, &reply, "deletedCount")) deleted += bson_iter_as_int64(&count);
    bson_destroy(&reply); bson_destroy(filter); bson_destroy(&options);
    if (!ok) throw SnapshotUnavailable();
    applied_deletion_epoch_ = epoch;
  }
  history_count_.reset();
  return deleted;
}

int64_t SnapshotStore::DeleteHistory(json filter) {
  if (!connected_.load()) throw SnapshotUnavailable();
  std::lock_guard<std::mutex> history_lock(history_mutex_);
  try {
    deletions_.Add(std::move(filter));
    PooledClient pc(pool_);
    ScopedCollection coll(pc.get(), db_name_, collection_name_);
    return ApplyDeletionRules(coll.get());
  } catch (...) {
    connected_.store(false); // reconnect completes durable deletion intent
    throw SnapshotUnavailable();
  }
}

bool SnapshotStore::DeleteOne(const std::string& image_id) {
  return DeleteHistory(json{{"image_id", image_id}}) > 0;
}

int64_t SnapshotStore::DeleteRange(double from_ts, double to_ts) {
  return DeleteHistory(json{{"timestamp", {{"$gte", from_ts}, {"$lte", to_ts}}}});
}

void SnapshotStore::DropChannelHistory(const config::SnapshotStoreConfig& config,
                                     const std::string& channel_id) {
  if (channel_id.empty() || config.db_name.empty()) throw SnapshotUnavailable();
  EnsureMongocInit();
  bson_error_t error{};
  auto* uri = mongoc_uri_new_with_error(config.mongo_uri.c_str(), &error);
  if (!uri) throw SnapshotUnavailable();
  mongoc_uri_set_option_as_int32(uri, MONGOC_URI_SERVERSELECTIONTIMEOUTMS, 5000);
  mongoc_uri_set_option_as_int32(uri, MONGOC_URI_CONNECTTIMEOUTMS, 5000);
  mongoc_uri_set_option_as_int32(uri, MONGOC_URI_SOCKETTIMEOUTMS, 15000);
  auto* client = mongoc_client_new_from_uri(uri);
  mongoc_uri_destroy(uri);
  if (!client) throw SnapshotUnavailable();
  mongoc_client_set_error_api(client, 2);
  auto* coll = mongoc_client_get_collection(client, config.db_name.c_str(),
                                           ("snapshots_" + channel_id).c_str());
  bool ok = mongoc_collection_drop(coll, &error);
  mongoc_collection_destroy(coll);
  mongoc_client_destroy(client);
  // NamespaceNotFound is success on retry after a crash between drop and config removal.
  if (!ok && !(error.domain == MONGOC_ERROR_SERVER && error.code == 26))
    throw SnapshotUnavailable();
}

int64_t SnapshotStore::Clear() {
  return DeleteHistory(json::object());
}


}  // namespace ai_service::output
