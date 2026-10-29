// AINVR. One affine hardware owner using the existing bounded ArchiveExecutor.
#pragma once
#include "output/search_prepared_sample.hpp"
#include "output/search_reencode.hpp"
namespace ai_service::output {
class SearchHardwareSession {
 public:
  virtual ~SearchHardwareSession()=default;
  virtual SearchEmbeddingSpace Space() const=0;
  // Non-networking, thread-safe latch reader; it must not capture the session.
  virtual std::function<bool()> HealthReader() const=0;
  virtual SearchHardwareProduct Prepare(const FrozenSearchFrame&,const SearchSamplingCurrent&)=0;
  // JPEG bytes are borrowed only until the affine call returns. The default
  // preserves existing fake factories; it cannot manufacture an embedding.
  virtual SearchReencodeResult ReencodeJpeg(const std::vector<uint8_t>&,
      const SearchSamplingCurrent&) { return {SearchReencodeResult::Status::Unsupported,{}, {},0,0}; }
};
class SearchHardwareOwner {
 public:
  struct ProbeResult {
    std::optional<double> distance{};
    std::shared_ptr<const SearchPreparedSample> prepared{};
    // distance<threshold with no prepared means an actual descriptor NoChange.
  };
  using Factory=std::function<std::unique_ptr<SearchHardwareSession>(const std::string&)>;
  // Verify the package, compare the expected pin, then check current immediately
  // before any SDK load. The callback/pin are borrowed for the factory call.
  using PinnedFactory=std::function<std::unique_ptr<SearchHardwareSession>(const std::string&,
      const std::optional<ainvr::search::RuntimeModelPin>&,const SearchSamplingCurrent&)>;
  enum class State {Disabled,Loading,Ready,Busy,Failed,Stopped};
  using Clock=std::function<std::chrono::steady_clock::time_point()>;
  explicit SearchHardwareOwner(Factory,Clock={});
  explicit SearchHardwareOwner(PinnedFactory,Clock={});
  ~SearchHardwareOwner();
  SearchHardwareOwner(const SearchHardwareOwner&)=delete;
  SearchHardwareOwner& operator=(const SearchHardwareOwner&)=delete;
  // Control tick only. Coalesces one desired package and at most one refresh
  // future, then returns; model I/O/SDK never runs on this calling thread.
  State Refresh(std::optional<config::SearchProducerLease>,bool force_reload=false);
  State Tick();
  std::optional<SearchEmbeddingSpace> CurrentSpace() const;
  // Existing ArchiveExecutor background caller only. If admitted, waits for its
  // affine future without a short timeout: borrowed raw data stays alive until
  // every encoder/hardware future has completed. No HTTP or hidden load here.
  std::shared_ptr<const SearchPreparedSample> Prepare(const FrozenSearchFrame&,const SearchEmbeddingSpace&,
      const config::SearchProducerLease&,const SearchSamplingCurrent&);
  // Same affine encoder and admitted frame. Baseline is borrowed until this
  // method's future completes; no short timeout may let the borrow expire.
  ProbeResult PrepareProbe(const FrozenSearchFrame&,const SearchEmbeddingSpace&,
      const config::SearchProducerLease&,std::span<const float> baseline,const SearchSamplingCurrent&);
  // Authenticated/background caller only; never a frame/producer hook. A single
  // <=8MiB copy is admitted before model load. Same affine executor, one target
  // cache with <=30s TTL, no change to live CurrentSpace or producer authority.
  // The JPEG borrow remains live until the returned hardware future finishes.
  SearchReencodeResult Reencode(const ainvr::search::RuntimeModelPin&,
      std::span<const uint8_t> jpeg,std::chrono::steady_clock::time_point valid_until,
      const SearchSamplingCurrent& current);
  // Control shutdown only; invalidates first, joins/releases on affine thread.
  void Stop();
 private:
  ProbeResult PrepareInternal(const FrozenSearchFrame&,const SearchEmbeddingSpace&,
      const config::SearchProducerLease&,std::span<const float> baseline,bool probe,const SearchSamplingCurrent&);
  struct Impl;std::shared_ptr<Impl> impl_;
};
struct SearchHardwareNativeOptions {
  int object_max_dimension=768,scene_max_dimension=1280,jpeg_quality=85;
  double object_padding_ratio=.25;
};
// Explicit native factory; constructor itself only starts an idle affine owner.
// The first valid control Refresh authorizes actual package verification/load.
std::shared_ptr<SearchHardwareOwner> MakeNativeSearchHardwareOwner(SearchHardwareNativeOptions options={});
} // namespace ai_service::output
