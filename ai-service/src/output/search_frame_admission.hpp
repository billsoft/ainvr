// AINVR. Search admission identity/ownership only; no encoder, queue or worker.
#pragma once
#include "config/search_producer_grant.hpp"
#include "output/search_sampling_policy.hpp"
#include "output/search_work_budget.hpp"
#include "output/search_observation.hpp"
#include "pipeline/postprocessor.hpp"
#include "platform/vpu_decoder.hpp"
#include <cmath>
#include <limits>
#include <memory>
#include <optional>
namespace ai_service::output {
enum class SearchFrameGeometryKind { Unverified, FullFrameAxisScale };
// Actual configured image-processing mode, not physical lens calibration.
// RawPlanar indexes original axes without claiming dewarping or lens quality.
enum class SearchSourceProjection { Unverified, RawPlanar, ERP };
struct SearchFrameFence {
  std::string processor_id, stream_session_id, input_path, output_path;
  int64_t source_epoch = -1;
  std::optional<int64_t> stream_generation;
  uint64_t view_reset_epoch = 0;
  int raw_width = 0, raw_height = 0, observation_width = 0, observation_height = 0;
  SearchFrameGeometryKind geometry = SearchFrameGeometryKind::Unverified;
  // Supplied from the owner's existing permission/liveness check; this boundary
  // neither implements licensing nor infers source liveness from a screenshot.
  bool owner_allowed = false;
  SearchSourceProjection projection = SearchSourceProjection::Unverified;
  bool operator==(const SearchFrameFence& other) const {
    return processor_id == other.processor_id && stream_session_id == other.stream_session_id &&
      input_path == other.input_path && output_path == other.output_path && source_epoch == other.source_epoch &&
      stream_generation == other.stream_generation && view_reset_epoch == other.view_reset_epoch &&
      raw_width == other.raw_width && raw_height == other.raw_height && observation_width == other.observation_width &&
      observation_height == other.observation_height && geometry == other.geometry && owner_allowed == other.owner_allowed && projection == other.projection;
  }
};
struct SearchFrameCapture {
  SearchFrameFence fence;
  // CapturedFrame is the canonical envelope: seq is not FrameRef.frame_index,
  // and mapped PTS is not the optional original packet/source PTS.
  int64_t mapped_pts_ns = -1, capture_sequence = -1;
  double captured_wall = -1;
  std::string worker_input_url, worker_output_url;
  std::optional<int64_t> decoder_frame_index, original_source_pts_ns;
  bool bt709 = true, full_range = false;
  // Optional scheduler proof. Never replaces capture_sequence/PTS or sample UUID.
  std::optional<SearchObservationTicket> observation;
};
struct SearchRawFrameProvenance {
  uint64_t nv12_timestamp_token = 0; // Raw provenance, never a mapped identity.
  std::optional<int64_t> decoder_frame_index, original_source_pts_ns;
};
struct SearchFrameGeometry {
  int observation_width, observation_height, raw_width, raw_height;
  double observation_to_raw_x, observation_to_raw_y;
};
// Inspect before TryAcquire; this borrows pixels and never retains/copies them.
// Count the retained allocation, including spare vector capacity, not just the
// visible packed bytes. Small metadata is separately bounded by this boundary.
inline size_t SearchFrameRetainedPixelBytes(const ainvr::Nv12Frame& frame) noexcept {
  if (frame.width <= 0 || frame.height <= 0 || frame.width > 16384 || frame.height > 16384 || frame.width % 2 || frame.height % 2)
    return 0;
  const auto expected = size_t(frame.width) * size_t(frame.height) * 3 / 2;
  return frame.pixels.size() == expected ? frame.pixels.capacity() : 0;
}
enum class SearchFrameAdmissionError { None, BudgetMissing, GrantUnavailable, SourceMismatch, FrameMismatch,
  InvalidCapture, UnsupportedGeometry, InvalidPixels, ObjectNotEligible, InvalidMetadata, Capacity };
class FrozenSearchFrame;
struct SearchFrameAdmissionResult {
  std::shared_ptr<const FrozenSearchFrame> frame;
  SearchFrameAdmissionError error = SearchFrameAdmissionError::None;
  explicit operator bool() const { return bool(frame); }
};
SearchFrameAdmissionResult FreezeSearchFrame(const config::SearchProducerLease& lease,
    const SearchSamplingPolicy::Candidate& selection, const FrameResult& result,
    const SearchFrameCapture& capture, const SearchFrameFence& current,
    const std::shared_ptr<const ainvr::Nv12Frame>& pixels, SearchWorkBudget::Ticket ticket);
class FrozenSearchFrame {
 public:
  const SearchSamplingPolicy::Candidate& Selection() const { return selection_; }
  const config::SearchProducerSource& Source() const { return source_; }
  const SearchFrameGeometry& Geometry() const { return geometry_; }
  const SearchRawFrameProvenance& RawProvenance() const { return provenance_; }
  const std::optional<Detection>& SourceDetection() const { return detection_; }
  const std::optional<std::array<double,4>>& RawTargetBox() const { return raw_box_; }
  // Borrow only: never expose a shared raw owner that could escape its ticket.
  // The hardware future must complete while the FrozenSearchFrame stays alive.
  const ainvr::Nv12Frame& Pixels() const { return *pixels_; }
  size_t RetainedPixelBytes() const { return retained_bytes_; }
  bool Bt709() const { return bt709_; }
  bool FullRange() const { return full_range_; }
  bool IsCurrent(const SearchFrameFence& current) const {
    return lease_.IsCurrent() && current == fence_;
  }
 private:
  FrozenSearchFrame(config::SearchProducerLease lease, SearchSamplingPolicy::Candidate selection,
      config::SearchProducerSource source, SearchFrameFence fence, SearchFrameGeometry geometry,
      SearchRawFrameProvenance provenance, std::optional<Detection> detection,
      std::optional<std::array<double,4>> raw_box, std::shared_ptr<const ainvr::Nv12Frame> pixels,
      size_t retained_bytes, bool bt709, bool full_range, SearchWorkBudget::Ticket ticket)
    : lease_(std::move(lease)), selection_(std::move(selection)), source_(std::move(source)), fence_(std::move(fence)),
      geometry_(geometry), provenance_(std::move(provenance)), detection_(std::move(detection)), raw_box_(raw_box),
      ticket_(std::move(ticket)), pixels_(std::move(pixels)), retained_bytes_(retained_bytes), bt709_(bt709), full_range_(full_range) {}
  config::SearchProducerLease lease_;
  SearchSamplingPolicy::Candidate selection_;
  config::SearchProducerSource source_;
  SearchFrameFence fence_;
  SearchFrameGeometry geometry_;
  SearchRawFrameProvenance provenance_;
  std::optional<Detection> detection_;
  std::optional<std::array<double,4>> raw_box_;
  SearchWorkBudget::Ticket ticket_; // Declared first: pixels release before their reservation.
  std::shared_ptr<const ainvr::Nv12Frame> pixels_;
  size_t retained_bytes_;
  bool bt709_, full_range_;
  friend SearchFrameAdmissionResult FreezeSearchFrame(const config::SearchProducerLease&, const SearchSamplingPolicy::Candidate&,
      const FrameResult&, const SearchFrameCapture&, const SearchFrameFence&, const std::shared_ptr<const ainvr::Nv12Frame>&,
      SearchWorkBudget::Ticket);
};
namespace search_frame_detail {
inline bool Measure(const std::optional<double>& value) { return !value || (std::isfinite(*value) && *value >= 0 && *value <= 1); }
inline bool Text(const std::string& value, size_t maximum) {
  return value.size() <= maximum && bson_utf8_validate(value.data(), value.size(), false) &&
    std::none_of(value.begin(), value.end(), [](unsigned char c) { return c < 32 || c == 127; });
}
inline bool Fingerprint(const std::string& value) {
  return value.empty() || (value.size() == 64 && std::all_of(value.begin(), value.end(), [](char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
  }));
}
// Caller supplies canonical paths from its actual frozen worker configuration.
// This exact local-authority binding verifies the URLs without stripping query,
// guessing a stream, normalizing dot segments or inventing another URI parser.
inline bool LocalUrlMatches(const std::string& url, const std::string& path) {
  if (path.empty() || url.size() <= path.size() || url.size() > 2048 || url.compare(url.size() - path.size(), path.size(), path) != 0)
    return false;
  auto authority = url.substr(0, url.size() - path.size());
  std::transform(authority.begin(), authority.end(), authority.begin(), [](unsigned char c) {
    return c >= 'A' && c <= 'Z' ? char(c + ('a' - 'A')) : char(c);
  });
  return authority == "rtmp://127.0.0.1:1935" || authority == "rtmp://127.0.0.1" ||
    authority == "rtmp://localhost:1935" || authority == "rtmp://localhost" ||
    authority == "rtmp://[::1]:1935" || authority == "rtmp://[::1]";
}
inline bool Box(const std::array<double,4>& box, int width, int height) {
  return std::all_of(box.begin(), box.end(), [](double n) { return std::isfinite(n); }) &&
    box[0] >= 0 && box[1] >= 0 && box[2] > 0 && box[3] > 0 && box[0] + box[2] <= width + 1e-6 && box[1] + box[3] <= height + 1e-6;
}
inline bool SameFrame(const SearchSamplingFrame& a, const SearchSamplingFrame& b) {
  return a.binding == b.binding && a.source_pts_ns == b.source_pts_ns && a.source_frame_index == b.source_frame_index &&
    a.captured_ms == b.captured_ms && a.analytics_status == b.analytics_status;
}
}  // namespace search_frame_detail
inline SearchFrameAdmissionResult FreezeSearchFrame(const config::SearchProducerLease& lease,
    const SearchSamplingPolicy::Candidate& selection, const FrameResult& result,
    const SearchFrameCapture& capture, const SearchFrameFence& current,
    const std::shared_ptr<const ainvr::Nv12Frame>& pixels, SearchWorkBudget::Ticket ticket) {
  using Error = SearchFrameAdmissionError; using Reason = SearchSamplingPolicy::Reason;
  const auto fail = [](Error error) { return SearchFrameAdmissionResult{nullptr, error}; };
  try {
    if (!lease.grant || !lease.IsCurrent()) return fail(Error::GrantUnavailable);
    const auto source = lease.grant->sources.find(result.channel_id);
    if (source == lease.grant->sources.end()) return fail(Error::SourceMismatch);
    const auto& mapping = source->second;
    if (mapping.input_path != capture.fence.input_path || mapping.output_path != capture.fence.output_path ||
        result.stream_url != capture.worker_input_url || !search_frame_detail::LocalUrlMatches(capture.worker_input_url, mapping.input_path) ||
        !search_frame_detail::LocalUrlMatches(capture.worker_output_url, mapping.output_path)) return fail(Error::SourceMismatch);
    if (!pixels) return fail(Error::InvalidPixels);
    const auto retained_bytes = SearchFrameRetainedPixelBytes(*pixels);
    if (!retained_bytes) return fail(Error::InvalidPixels);
    if (ticket.ReservedBytes() < retained_bytes) return fail(Error::BudgetMissing);
    const auto& fence = capture.fence;
    if (!fence.owner_allowed || !current.owner_allowed || !(fence == current) || fence.source_epoch < 0 ||
        !fence.stream_generation || *fence.stream_generation < 0) return fail(Error::FrameMismatch);
    if (fence.geometry != SearchFrameGeometryKind::FullFrameAxisScale || fence.projection != SearchSourceProjection::RawPlanar)
      return fail(Error::UnsupportedGeometry);
    if (pixels->width != fence.raw_width || pixels->height != fence.raw_height || result.frame_width != fence.observation_width ||
        result.frame_height != fence.observation_height || result.channel_id != fence.processor_id ||
        result.frame_pts_ns != capture.mapped_pts_ns || result.frame_index != capture.capture_sequence)
      return fail(Error::FrameMismatch);
    const long double capture_ms = static_cast<long double>(capture.captured_wall) * 1000;
    if (!std::isfinite(capture.captured_wall) || capture.captured_wall < 0 || capture_ms > std::numeric_limits<int64_t>::max())
      return fail(Error::InvalidCapture);
    const auto frame = SearchSamplingPolicy::FrameFromResult(result, mapping.input_stream_id, static_cast<int64_t>(capture_ms));
    if (!frame || !search_frame_detail::SameFrame(*frame, selection.frame) || frame->binding.stream_session_id != fence.stream_session_id ||
        (frame->analytics_status != "active" && frame->analytics_status != "detection_only")) return fail(Error::FrameMismatch);
    const auto& reset = result.model_extra.at("analytics").at("view_reset_epoch");
    if (!reset.is_number_integer() || reset < 0 || reset.get<uint64_t>() != fence.view_reset_epoch) return fail(Error::FrameMismatch);
    if (!selection.token || !search_frame_detail::Measure(selection.quality) || !search_frame_detail::Measure(selection.change) ||
        !search_frame_detail::Fingerprint(selection.expected_fingerprint)) return fail(Error::InvalidMetadata);
    if(SearchSamplingPolicy::IsProbe(selection)?!SearchSamplingPolicy::ProbeContractValid(selection):
        !selection.probe_reference_fingerprint.empty())return fail(Error::InvalidMetadata);
    std::optional<Detection> detection; std::optional<std::array<double,4>> raw_box;
    const SearchFrameGeometry geometry{result.frame_width, result.frame_height, pixels->width, pixels->height,
      double(pixels->width) / result.frame_width, double(pixels->height) / result.frame_height};
    if (selection.slot) {
      const auto slot = *selection.slot;
      if (!mapping.object || frame->analytics_status != "active") return fail(Error::ObjectNotEligible);
      if (slot >= 8 || (selection.reason == Reason::First ? slot != 0 : selection.reason == Reason::Best ? slot != 1 :
          (selection.reason == Reason::Change||selection.reason==Reason::ObjectProbe) ? slot < 2 : true)) return fail(Error::InvalidMetadata);
      const auto observation = SearchSamplingPolicy::ObjectFromResult(result, selection.track_id, true, selection.quality, selection.change);
      if (!observation || !observation->public_detection || observation->state != "confirmed" || observation->observation != "detected" ||
          observation->last_observed_pts_ns != frame->source_pts_ns || observation->source_frame_index != frame->source_frame_index ||
          observation->processor_id != frame->binding.processor_id || observation->stream_session_id != frame->binding.stream_session_id)
        return fail(Error::ObjectNotEligible);
      const auto actual = std::find_if(result.detections.begin(), result.detections.end(), [&](const auto& d) { return d.track_id == selection.track_id; });
      if (actual == result.detections.end() || !search_frame_detail::Box(actual->bbox, result.frame_width, result.frame_height) ||
          !std::isfinite(actual->confidence) || !search_frame_detail::Text(actual->class_name, 512) ||
          !search_frame_detail::Text(actual->label_id, 512) || !search_frame_detail::Text(actual->query_description, 4096))
        return fail(Error::InvalidMetadata);
      Detection bounded; bounded.class_id = actual->class_id; bounded.class_name = actual->class_name; bounded.label_id = actual->label_id;
      bounded.track_id = actual->track_id; bounded.confidence = actual->confidence; bounded.confidence_known = actual->confidence_known;
      bounded.query_description = actual->query_description; bounded.bbox = actual->bbox;
      FrameResult envelope; envelope.channel_id = result.channel_id; envelope.frame_pts_ns = result.frame_pts_ns;
      envelope.frame_index = result.frame_index; envelope.frame_width = result.frame_width; envelope.frame_height = result.frame_height;
      envelope.model_extra["analytics"] = {{"status", frame->analytics_status}, {"stream_session_id", fence.stream_session_id}};
      envelope.detections.push_back(std::move(bounded));
      auto bound = BindObservationEvidence(envelope); detection = bound.front();
      // Use the existing inverse axis rescaling, not a second crop/traversal or
      // association algorithm. Projection/cropping/encoding belongs downstream.
      raw_box = pipeline::rescale_detections(bound, geometry.observation_to_raw_x, geometry.observation_to_raw_y).front().bbox;
      if (!search_frame_detail::Box(*raw_box, pixels->width, pixels->height)) return fail(Error::InvalidMetadata);
    } else {
      if (!mapping.scene || !selection.track_id.empty() || selection.quality || !selection.expected_fingerprint.empty() ||
          (selection.reason != Reason::SceneFirst && selection.reason != Reason::SceneInterval && selection.reason != Reason::SceneChange&&selection.reason!=Reason::SceneProbe))
        return fail(Error::InvalidMetadata);
    }
    if (!lease.IsCurrent()) return fail(Error::GrantUnavailable);
    SearchRawFrameProvenance provenance{pixels->pts, capture.decoder_frame_index, capture.original_source_pts_ns};
    auto frozen = std::shared_ptr<const FrozenSearchFrame>(new FrozenSearchFrame(lease, selection, mapping, fence, geometry,
      std::move(provenance), std::move(detection), raw_box, pixels, retained_bytes, capture.bt709, capture.full_range, std::move(ticket)));
    return {std::move(frozen), Error::None};
  } catch (const std::bad_alloc&) { return fail(Error::Capacity); }
    catch (...) { return fail(Error::InvalidMetadata); }
}
}  // namespace ai_service::output
