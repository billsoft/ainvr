#include "index_runtime.hpp"
#include "index_discovery.hpp"
#include "index_runtime_policy.hpp"
#include "../../shared/cpp/config_center_client.hpp"
#include <condition_variable>
#include <deque>
#include <optional>
#include <iostream>
#include <mutex>
#include <set>
#include <thread>
namespace ainvr::search {
namespace {
IndexShardFiles& RequireFiles(const std::unique_ptr<IndexShardFiles>& files) {
  if (!files) throw std::invalid_argument("invalid_index_runtime");
  return *files;
}
}
struct ManagedIndexRuntime::Impl {
  using Clock = std::chrono::steady_clock;
  HistoryMongo& history;
  MatchEngine* engine;
  std::unique_ptr<IndexShardFiles> files;
  const IndexJobContext context;
  const size_t dimensions;
  std::shared_ptr<std::atomic<bool>> admitted;
  ainvr::config::ConfigTransport transport;
  std::unique_ptr<IndexJobClient> jobs;
  std::unique_ptr<IndexBuildWorker> builder;
  std::unique_ptr<IndexDiscovery> discovery;
  MigrationArtifactsRuntime migrations;
  std::atomic<bool> stopping{false};
  std::mutex wait_mutex;
  std::condition_variable wake;
  std::thread thread;
  std::optional<IndexBuildOutcome> unknown;
  std::optional<std::string> warm_cursor, cleanup_cursor;
  std::optional<IndexCatalogPage> warm_page;
  std::optional<IndexRetiredCatalogPage> cleanup_page;
  size_t warm_position = 0, cleanup_position = 0;
  std::set<std::string> walk_seen;   // shards listed in the current catalog pass (runtime thread only)
  std::map<std::string, std::string> opened;   // shard id -> manifest hash opened by this runtime
  std::deque<IndexShardIdentity> rebuilds;     // shards with rows gone from Mongo, not yet requested
  std::map<std::string, Clock::time_point> rebuild_requested;
  size_t pass_faults = 0;   // runtime thread only
  bool cleanup_rescan_requested = false;
  Clock::time_point discover_after{}, warm_after{}, cleanup_after{},source_after{};
  std::string state = "pending";
  mutable std::mutex status_mutex;
  std::atomic<uint64_t> verified_files{0}, publications{0};
  std::atomic<int64_t> discovery_checkpoint{0};
  std::atomic<bool> reconcile_pending{false};
  const std::string worker;
  Impl(const nlohmann::json& bootstrap, HistoryMongo& history_owner, MatchEngine* engine_owner,
       std::unique_ptr<IndexShardFiles> file_owner, IndexJobContext identity, size_t dims,
       std::shared_ptr<std::atomic<bool>> admission)
      : history(history_owner), engine(engine_owner), files(std::move(file_owner)), context(std::move(identity)),
        dimensions(dims), admitted(std::move(admission)), transport(bootstrap),
        migrations(bootstrap,history,RequireFiles(files),context,admitted),
        worker(SampleStorageUuid("ainvr-search-index-worker-v1", nlohmann::json::array({context.revision,
          context.storage_generation,int64_t(std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now().time_since_epoch()).count())}))) {
    if(!files||!admitted||dimensions>4096)throw std::invalid_argument("invalid_index_runtime");
    // Metadata/file maintenance survives missing old weights. Only source RAM
    // warming/query projection depends on the old encoder/MatchEngine.
    if(engine&&dimensions&&!context.model_version.empty()){
      jobs=std::make_unique<IndexJobClient>(transport,context);
#ifdef AINVR_INDEX_BUILDER_TESTING
      builder=std::make_unique<IndexBuildWorker>([&history_owner](const auto&m,const auto&s,int64_t a,size_t n){return history_owner.Scan(m,s,a,n);},RequireFiles(files),*jobs,context,dimensions);
#else
      builder=std::make_unique<IndexBuildWorker>(history,RequireFiles(files),*jobs,context,dimensions);
#endif
      discovery=std::make_unique<IndexDiscovery>(std::set<std::string>(context.channels.begin(),context.channels.end()),
        [this](int64_t after,size_t limit){return history.ScanIndexChanges(context.model_version,
          std::set<std::string>(context.channels.begin(),context.channels.end()),after,limit);},
        [this](const auto&channel,const auto&day,int64_t minimum){
          if(!jobs->Refresh(channel,day,minimum))throw std::runtime_error("index_refresh_unavailable");});
    }
    thread = std::thread([this] { Loop(); });
  }
  bool Cancelled() const { return stopping.load() || !admitted->load(); }
  void State(const char* next) {
    if (RecoveredIndexState(next, true)) ++pass_faults;   // a transient fault in this pass
    std::lock_guard<std::mutex> lock(status_mutex);
    if (state != next) { state = next; std::cerr << "search_index_state=" << next << '\n'; }
  }
  void Cleanup() {
    if (Clock::now() < cleanup_after || Cancelled()) return;
    if (!cleanup_page) {
      cleanup_page = jobs->RetiredCatalog(cleanup_cursor, 16); cleanup_position = 0;
      if (!cleanup_page) throw std::runtime_error("index_catalog_unavailable");
    }
    if (cleanup_position < cleanup_page->shards.size()) {
      const auto& retired = cleanup_page->shards[cleanup_position];
      // The catalog atomically fenced this exact revision before issuing it.
      // Repeating deletion after a lost confirm ACK remains idempotent; never
      // infer authorization from Published()==null or directory enumeration.
      files->DeleteRetired(retired.shard, retired.manifest_key);
      if (!jobs->ConfirmCleanup(retired)) {
        // Another acknowledged cleanup may have advanced this slot. Abandon
        // only the old metadata and request fresh authority; no new key is
        // deleted based on this negative response.
        cleanup_page.reset(); cleanup_cursor.reset();
        cleanup_after = Clock::now() + std::chrono::seconds(5); return;
      }
      ++cleanup_position;
    }
    if (cleanup_position >= cleanup_page->shards.size()) {
      cleanup_cursor = cleanup_page->next_cursor; cleanup_page.reset();
      if (!cleanup_cursor) {
        // New publications may retire an entry behind an in-progress cursor.
        // Finish this page sequence, then rescan once without starving later IDs.
        if (cleanup_rescan_requested) { cleanup_rescan_requested = false; cleanup_after = {}; }
        else cleanup_after = Clock::now() + std::chrono::seconds(30);
      }
    }
  }
  // Attach a published shard to the query engine: opened (hash verified) once per runtime,
  // then served from its memory mapping until a new publication replaces it.
  void WarmPublished(PublishedIndexShard published) {
      if (Cancelled()) return;
      published.shard.dimensions = dimensions; // Bound to the verified model version.
      published.shard.views = context.views;
      walk_seen.insert(published.shard.id);
      try {
        // Opened (hash verified) by this runtime: every runtime verifies each file once.
        const auto found = opened.find(published.shard.id);
        if (found != opened.end() && found->second == published.publication.manifest_sha256) return;
        engine->Attach(files->Open(published.shard, published.publication)); ++verified_files;
        opened[published.shard.id] = published.publication.manifest_sha256;
      } catch (...) {
        // A missing/corrupt derived file cannot close producer admission or
        // fabricate a complete negative: the day is read from Mongo (bounded; partial if
        // capped) while the repair job below rebuilds the file.
        State("cache_unavailable");
        if (!Cancelled()) {
          const auto current = jobs->Published(published.shard.id);
          // A saved page may legitimately outlive the file it named. GC of an
          // older publication is not corruption of the current derived index.
          if (!current || current->shard.revision != published.shard.revision ||
              current->shard.storage_generation != published.shard.storage_generation ||
              current->publication.manifest_key != published.publication.manifest_key ||
              current->publication.manifest_sha256 != published.publication.manifest_sha256) return;
          // One deterministic repair job per exact broken publication. Reuse
          // the existing PG queue/kind consumed below; repeated observations
          // cannot enqueue a new job every minute or infer deletion authority.
          const auto key = SampleStorageUuid("ainvr-search-index-repair-v1", nlohmann::json::array({
            context.revision, context.storage_generation, context.package_id, context.model_version,
            published.shard.channel_id, published.shard.utc_day, published.shard.revision,
            published.publication.manifest_sha256}));
          jobs->Enqueue(key, published.shard.channel_id, context.model_version, published.shard.utc_day, "index");
        }
      }
  }
  void Warm() {
    if (Clock::now() < warm_after || Cancelled()) return;
    if (!warm_page) {
      if (!warm_cursor) walk_seen.clear();   // a new pass over the whole catalog
      warm_page = jobs->Catalog(warm_cursor, 16); warm_position = 0;
      if (!warm_page) throw std::runtime_error("index_catalog_unavailable");
    }
    // One shard per tick, the pace of the former warm loop (a v1 file is ~50 MB).
    if (warm_position < warm_page->shards.size()) {
      WarmPublished(warm_page->shards[warm_position]);
      ++warm_position;
    }
    if (warm_position >= warm_page->shards.size()) {
      warm_cursor = warm_page->next_cursor; warm_page.reset();
      if (!warm_cursor) {
        // A whole pass: shards no longer in the catalog (retired) are released, and
        // from now on a day without an attached shard is read from Mongo, not unknown.
        for (const auto& [id, _] : engine->Attached()) if (!walk_seen.count(id)) { engine->Detach(id); opened.erase(id); }
        engine->MarkCatalogComplete();
        warm_after = Clock::now() + std::chrono::seconds(60);
      }
    }
  }
  // Mongo evicts old samples by its byte budget (and deletes/expires rows) without a new
  // ordinal, so discovery never rebuilds those shards. The query engine reports a shard
  // whose rows it found gone; rebuilding it from Mongo drops them. At most once per
  // shard per 30 minutes; a failed request is retried on the next pass.
  void RequestRebuilds() {
    for (auto& shard : engine->TakeRebuildRequests()) rebuilds.push_back(std::move(shard));
    const auto now = Clock::now();
    while (!rebuilds.empty() && !Cancelled()) {
      const auto& shard = rebuilds.front();
      const auto last = rebuild_requested.find(shard.id);
      if (last == rebuild_requested.end() || now - last->second >= std::chrono::minutes(30)) {
        if (!jobs->Refresh(shard.channel_id, shard.utc_day, shard.checkpoint + 1)) throw std::runtime_error("index_refresh_unavailable");
        rebuild_requested[shard.id] = now;
      }
      rebuilds.pop_front();
    }
    if (rebuild_requested.size() > 4096) rebuild_requested.clear();
  }
  void Published(const IndexBuildOutcome& result) {
    if (!result.lease || !result.publication) throw std::runtime_error("index_publication_invalid");
    ++publications; State("working");
    cleanup_after = {}; cleanup_rescan_requested = true;
    // Warm this exact confirmed file immediately, including a lost-response
    // reconciliation. Do not restart catalog pagination: frequent new files
    // must not starve later partitions during background restore.
    WarmPublished({result.lease->shard, *result.publication, true});
  }
  void Build() {
    if (Cancelled()) return;
    if (unknown) {
      const auto result = builder->Reconcile(*unknown, [this] { return Cancelled(); });
      if (result.state == IndexBuildOutcome::State::NeedsReconcile) { State("publication_unconfirmed"); return; }
      unknown.reset(); reconcile_pending.store(false);
      if (result.state == IndexBuildOutcome::State::Published) Published(result);
    }
    const auto result = builder->RunOne(worker, "index", [this] { return Cancelled(); });
    if (result.state == IndexBuildOutcome::State::NeedsReconcile) { unknown = result; reconcile_pending.store(true); State("publication_unconfirmed"); }
    else if (result.state == IndexBuildOutcome::State::Published) Published(result);
    else if (result.state == IndexBuildOutcome::State::Capacity) State("capacity_limited");
    else if (result.state == IndexBuildOutcome::State::Unavailable) State("dependency_unavailable");
    else if (result.state == IndexBuildOutcome::State::Invalid) State("artifact_invalid");
  }
  void Loop() noexcept {
    while (!stopping.load()) {
      if (!Cancelled()) {
        // Independent bounded stages: unavailable GC cannot stop querying or
        // sample persistence. Only existing PG leases decide publication work.
        if(jobs&&Clock::now()>=source_after){
        pass_faults = 0;
        try { Cleanup(); } catch (...) { State("cleanup_pending"); }
        try { Build(); } catch (...) { State("dependency_unavailable"); }
        try { Warm(); } catch (...) { State("cache_unavailable"); }
        try { RequestRebuilds(); } catch (...) { State("dependency_unavailable"); }
        if (Clock::now() >= discover_after && !Cancelled()) try {
          if (!discovery->Step([this] { return Cancelled(); }))
            discover_after = Clock::now() + std::chrono::seconds(30);
          discovery_checkpoint.store(discovery->Checkpoint());
        } catch (...) { State("discovery_pending"); discover_after = Clock::now() + std::chrono::seconds(5); }
        if (!pass_faults) {
          std::string current; { std::lock_guard<std::mutex> lock(status_mutex); current = state; }
          if (const auto recovered = RecoveredIndexState(current, true)) State(recovered);
        }
        source_after=Clock::now()+std::chrono::seconds(1);
        }
        // Same owner thread/files; target vectors never enter the old engine.
        migrations.Pump();
      }
      std::unique_lock<std::mutex> lock(wait_mutex);
      const auto delay=migrations.WantsFastSteps()?std::chrono::milliseconds(20):std::chrono::milliseconds(1000);
      wake.wait_for(lock,delay,[this]{return stopping.load();});
    }
  }
  nlohmann::json Status() const {
    std::lock_guard<std::mutex> lock(status_mutex);
    return {{"state", state}, {"verified_files", verified_files.load()}, {"publications", publications.load()},
      {"discovery_checkpoint", discovery_checkpoint.load()}, {"publication_unconfirmed", reconcile_pending.load()}};
  }
  void Stop() {
    stopping.store(true); migrations.Stop(); wake.notify_all();
    if (thread.joinable()) thread.join();
  }
};
ManagedIndexRuntime::ManagedIndexRuntime(const nlohmann::json& bootstrap, HistoryMongo& history, MatchEngine& engine,
    std::unique_ptr<IndexShardFiles> files, IndexJobContext context, size_t dimensions,
    std::shared_ptr<std::atomic<bool>> admitted)
    :ManagedIndexRuntime(bootstrap,history,&engine,std::move(files),std::move(context),dimensions,std::move(admitted)){}
ManagedIndexRuntime::ManagedIndexRuntime(const nlohmann::json& bootstrap,HistoryMongo& history,MatchEngine* engine,
    std::unique_ptr<IndexShardFiles> files,IndexJobContext context,size_t dimensions,
    std::shared_ptr<std::atomic<bool>> admitted)
    :impl_(std::make_unique<Impl>(bootstrap,history,engine,std::move(files),std::move(context),dimensions,std::move(admitted))){}
nlohmann::json ManagedIndexRuntime::ActivateMigration(const MigrationWriteProof&p,const MigrationWriteGrant&g){return impl_->migrations.Activate(p,g);}
ManagedIndexRuntime::~ManagedIndexRuntime() { Stop(); }
void ManagedIndexRuntime::Stop() { if (impl_) impl_->Stop(); }
nlohmann::json ManagedIndexRuntime::Status() const { return impl_->Status(); }
} // namespace ainvr::search
