// Copyright AINVR. Hardware execution behind the original snapshot crop rules.
#pragma once
#include <cstdint>
#include <memory>
#include <vector>
#include <opencv2/core.hpp>
#include "output/erp_perspective.hpp"
namespace ainvr {
struct GlesErpMap {
  cv::Size size, source_size;
  cv::Rect required;
  bool finite = false;
 private:
  struct Storage;
  std::shared_ptr<Storage> storage;
  friend class GlesCropBackend;
};
struct GlesCropStats {
  uint64_t maps, cache_hits, crops, failures;
  uint64_t contexts_created, contexts_reused, contexts_live, shader_compilations;
};
GlesCropStats GetGlesCropStats();
class GlesCropBackend {
 public:
  explicit GlesCropBackend(size_t max_entries=256,size_t max_bytes=size_t(64)<<20, bool exact_views=false);
  ~GlesCropBackend();
  GlesCropBackend(const GlesCropBackend&)=delete;
  GlesCropBackend& operator=(const GlesCropBackend&)=delete;
  std::shared_ptr<const GlesErpMap> GetMap(cv::Size source,const ai_service::output::ErpView& view);
  void Upload(const cv::Mat& rgba);
  // Immutable packed NV12; tag must uniquely identify pixels for this lifetime.
  void UploadNv12(const std::vector<uint8_t>& pixels,cv::Size size,
                  uint64_t tag,bool bt709,bool full_range);
  // Integral source rectangle, including replicated out-of-frame padding.
  // bounded_linear preserves the original huge-square remap exception.
  cv::Mat Area(const cv::Rect& rectangle,cv::Size output,bool bounded_linear=false);
  // Original-coordinate quantization precedes ROI offset subtraction.
  // Remap to an 8-bit supersampled image, then cubic resize on GPU.
  cv::Mat Remap(const std::shared_ptr<const GlesErpMap>& map,cv::Point origin,cv::Size output);
  size_t CacheSize() const;
  size_t CacheBytes() const;
 private:
  struct State;
  std::unique_ptr<State> state_;
};
}
