// AINVR. Shared metadata/frame admission coordinator. No production encoder or HTTP adapter.
#pragma once
#include "config/search_producer_grant.hpp"
#include "output/search_sampling_executor.hpp"
#include "output/search_frame_admission.hpp"
#include "output/search_sampling_coverage.hpp"
#include "output/search_sampling_limits.hpp"
#include "output/search_appearance.hpp"
#include <functional>
#include <memory>
#include <optional>
#include <string>
namespace ai_service::output {
struct SearchEmbeddingSpace {
  std::string package_id, model_version, input_spec_version;
  bool operator==(const SearchEmbeddingSpace&) const = default;
};
using SearchSamplingCurrent = std::function<bool()>;
// Only a durable, acknowledged matching write is Committed. Unknown is never a
// rejection: the coordinator keeps its token pending until authoritative lookup.
struct SearchSamplingReceipt {
  enum class Result { Committed, Rejected, Unknown };
  Result result = Result::Unknown;
  std::string fingerprint, receipt_key;
};
class SearchSamplingOperation {
 public:
  virtual ~SearchSamplingOperation() = default;
  virtual size_t RetainedBytes() const noexcept = 0;
  // Stable write/CAS lookup identity, available BEFORE a write can happen.
  // Safe identifier only (<=128), never a URL, auth token or device input.
  virtual std::string ReceiptKey() const = 0;
  // Frozen receipt request prepared from the SAME immutable write: original
  // sample UUID/expiry/evidence and request fingerprint. At most 16 KiB JSON,
  // no vector/image, HTTP headers, URLs or credentials. Available before Submit.
  virtual std::string ReceiptQuery() const = 0;
  // Borrowed immutable normalized descriptor; valid only while this operation
  // lives. The owner copies <=4096 floats into its separate bounded RAM ledger,
  // never aliases a Sample here (that would also retain its JPEG).
  virtual std::span<const float> Descriptor() const noexcept { return {}; }
  // Must recheck current immediately before the actual write. Prepared bytes
  // must be immutable; no camera/identity lookup or re-encoding in Submit.
  virtual SearchSamplingReceipt Submit(const SearchSamplingCurrent& current) = 0;
};
struct SearchSamplingProbePreparation {
  enum class Result { NotReady, NoChange, Write };
  Result result=Result::NotReady;
  std::optional<double> distance{};
  std::shared_ptr<SearchSamplingOperation> operation{};
};
class SearchSamplingExecutionPort {
 public:
  virtual ~SearchSamplingExecutionPort() = default;
  // Verified embedding package + preprocessing space, not merely configured ID.
  // Thread-safe, non-networking. A missing port/space means explicitly not_ready.
  virtual std::optional<SearchEmbeddingSpace> CurrentSpace() const = 0;
  // Runs on ArchiveExecutor, never the inference producer. This port must use an
  // existing affine hardware owner; ArchiveExecutor workers are NOT BPU owners.
  // Prepare must not submit writes or retain the borrowed frame beyond return.
  virtual std::shared_ptr<SearchSamplingOperation> Prepare(const FrozenSearchFrame& frame,
      const SearchEmbeddingSpace& space, const config::SearchProducerLease& lease,
      const SearchSamplingCurrent& current) = 0;
  // Query the SAME frozen write metadata only; never re-encode or resubmit.
  // A not_found lookup is Unknown, never proof of rejection.
  virtual SearchSamplingReceipt Reconcile(const SearchSamplingPolicy::Candidate& candidate,
      const config::SearchProducerSource& source, const SearchEmbeddingSpace& space,
      const std::string& receipt_key, const std::string& receipt_query,
      const config::SearchProducerLease& current_lease,
      const SearchSamplingCurrent& current) = 0;
  // Optional metadata-only coverage write, on the SAME bounded executor.
  // False/unsupported never certifies coverage. No JPEG or vector is retained.
  virtual bool CoverageEnabled() const noexcept { return false; }
  virtual bool PublishCoverage(const SearchCoverageRange&, const config::SearchProducerLease&,
      const SearchSamplingCurrent&) { return false; }
  virtual bool SupportsProbes()const noexcept{return false;}
  virtual SearchSamplingProbePreparation PrepareProbe(const FrozenSearchFrame&,
      const SearchEmbeddingSpace&,const config::SearchProducerLease&,std::span<const float>,
      const SearchSamplingCurrent&){return {};}
};
struct SearchSamplingOffer {
  enum class Status { NotReady, NotBound, Stale, Queued, NeedsReconcile, Busy, NotDue,
    NotEligible, Capacity, Invalid };
  Status status = Status::NotReady;
  SearchSamplingPolicy::Token token = 0;
  // Capacity only: coverage owes this sample and keeps it due; not a lost observation.
  bool deferred = false;
};
using SearchSamplingPixelRetainer = std::function<std::shared_ptr<const ainvr::Nv12Frame>()>;
namespace search_owner_detail { struct State; struct Source; }
class SearchSamplingSource {
 public:
  ~SearchSamplingSource();
  // Capture before inference. Reset increments this fence, so an old in-flight
  // result cannot rebind a retired source even if it arrives after reset.
  uint64_t Token() const noexcept;
  void Reset() noexcept;
  // Trusted synchronous lifecycle boundary only, after worker's current-frame
  // check under its lifecycle lock. Receiving a different session is not proof.
  bool Bind(uint64_t expected_token, const SearchFrameFence& fence);
  SearchSamplingOffer OfferObject(uint64_t expected_token, const FrameResult& result,
      const SearchFrameCapture& capture, const ainvr::Nv12Frame& borrowed,
      SearchSamplingPixelRetainer retain, const std::string& track_id, bool usable = true,
      std::optional<double> quality = {}, std::optional<double> change = {});
  SearchSamplingOffer OfferScene(uint64_t expected_token, const FrameResult& result,
      const SearchFrameCapture& capture, const ainvr::Nv12Frame& borrowed,
      SearchSamplingPixelRetainer retain, const SearchSamplingScene& scene);
  // Exactly once after every object's/scene's Offer for this immutable frame.
  // Does not wait, encode or do network I/O; missed EndFrame stays gap/unknown.
  bool EndFrame(uint64_t expected_token,const FrameResult&,const SearchFrameCapture&,
      bool object_offers_complete=true,bool scene_offer_complete=true);
 private:
  SearchSamplingSource(std::weak_ptr<search_owner_detail::State>, std::shared_ptr<search_owner_detail::Source>);
  std::weak_ptr<search_owner_detail::State> state_;
  std::shared_ptr<search_owner_detail::Source> source_;
  friend class SearchSamplingOwner;
};
class SearchSamplingOwner {
 public:
  explicit SearchSamplingOwner(config::SearchProducerLeaseReader reader,
      std::shared_ptr<SearchSamplingExecutionPort> port = {}, ArchiveExecutor& executor = SearchSamplingExecutor(),
      std::function<std::chrono::steady_clock::time_point()> clock = {});
  ~SearchSamplingOwner();
  SearchSamplingOwner(const SearchSamplingOwner&) = delete;
  SearchSamplingOwner& operator=(const SearchSamplingOwner&) = delete;
  std::shared_ptr<SearchSamplingSource> CreateSource(const std::string& processor_id);
  SearchSamplingOffer Reconcile(SearchSamplingPolicy::Token token);
  // Control tick only: one round-robin lookup from the existing pending map.
  // Non-blocking admission; network work stays on the dedicated bounded executors.
  SearchSamplingOffer ReconcileNext();
  struct Counters { size_t sources, tracks, pending, needs_reconcile, retained_jobs, retained_bytes; bool stopped;
    size_t descriptor_count=0,descriptor_bytes=0;
    size_t coverage_windows=0,coverage_dropped=0,coverage_untracked=0,coverage_failures=0,retired_unknown=0;
    SearchCoverageLedger::GapStats coverage_gap;
    size_t deferred_offers=0,end_frame_lock_busy=0;
    std::array<uint64_t,5> reset_reasons{};
    std::array<uint64_t,8> fence_fields{};
    std::array<uint64_t,10> offer_status{}; };
  Counters Usage() const;
  std::optional<SearchSamplingPolicy::TrackSnapshot> Inspect(const SearchSamplingBinding&, const std::string&) const;
  // Control-thread only. Revokes callbacks before joining; never call from port.
  void Stop() noexcept;
 private:
  std::shared_ptr<search_owner_detail::State> state_;
};
}  // namespace ai_service::output
