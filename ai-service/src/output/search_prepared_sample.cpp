#include "output/search_prepared_sample.hpp"
#include "output/search_sampling_metrics.hpp"
#include "../../../search-service/src/model_package.hpp"
#include <algorithm>
#include <cmath>
namespace ai_service::output {
namespace {
bool FiniteBox(const std::array<double,4>& box) {
  return std::all_of(box.begin(),box.end(),[](double v) {return std::isfinite(v)&&std::abs(v)<=131072;}) && box[2]>0&&box[3]>0;
}
}
std::shared_ptr<const SearchPreparedSample> BuildSearchPreparedSample(const FrozenSearchFrame& frame,
    const SearchEmbeddingSpace& space,const config::SearchProducerLease& lease,SearchHardwareProduct product,
    std::optional<SearchAppearanceAudit> appearance) {
  const auto& spec = ainvr::search::FindPackageSpec(space.package_id);
  if (spec.pruned || spec.input_spec_version != space.input_spec_version)
    throw std::runtime_error("search_prepared_model_contract_invalid");
  const auto& selection=frame.Selection(); const auto& source=frame.Source(); const auto& geometry=frame.Geometry();
  const auto& identity=selection.frame;
  if(!lease.IsCurrent()||!lease.grant||lease.grant->package_id!=space.package_id||
      product.plan.perspective||!FiniteBox(product.plan.source_rectangle)||
      product.plan.width<18||product.plan.height<18||product.plan.width>8192||product.plan.height>8192||
      product.plan.width%2||product.plan.height%2||product.encoder_backend!="jpu"||product.vision_backend!="gles"||
      product.render_backend.find("cpu")!=std::string::npos||product.render_backend.empty()||
      product.jpeg.size()<4||product.jpeg.size()>size_t(lease.grant->limits.image_max_bytes)||
      product.jpeg.front()!=255||product.jpeg[1]!=216||product.jpeg[product.jpeg.size()-2]!=255||product.jpeg.back()!=217||
      product.embedding.size()!=spec.dimensions||identity.captured_ms<0||space.model_version.empty()||space.input_spec_version.empty())
    throw std::runtime_error("search_prepared_sample_invalid");
  const auto permitted=lease.grant->sources.find(source.processor_id);
  if(permitted==lease.grant->sources.end()||permitted->second.processor_id!=source.processor_id||permitted->second.channel_id!=source.channel_id||
      permitted->second.input_stream_id!=source.input_stream_id||permitted->second.recording_channel_id!=source.recording_channel_id||
      permitted->second.input_path!=source.input_path||permitted->second.output_path!=source.output_path||
      (selection.slot?!permitted->second.object:!permitted->second.scene)) throw std::runtime_error("search_prepared_scope_changed");
  const auto common=nlohmann::json::array({source.input_stream_id,source.channel_id,source.processor_id,identity.binding.stream_session_id});
  auto canonical_frame=common;canonical_frame.push_back(identity.source_pts_ns);canonical_frame.push_back(identity.source_frame_index);
  canonical_frame.push_back(geometry.observation_width);canonical_frame.push_back(geometry.observation_height);
  const auto frame_id=ainvr::search::SampleStorageUuid("ainvr-search-frame-v1",canonical_frame);
  auto sample=std::make_shared<ainvr::search::Sample>();auto& record=sample->record;
  record.channel=source.channel_id;record.processor=source.processor_id;record.session=identity.binding.stream_session_id;
  record.track=selection.track_id;record.model=space.model_version;record.captured_ms=identity.captured_ms;record.scene=!selection.slot;
  record.id=ainvr::search::SearchSampleStorageUuid({source.input_stream_id,source.channel_id,source.processor_id,
    identity.binding.stream_session_id,space.model_version,selection.track_id,selection.slot,
    static_cast<uint64_t>(identity.source_pts_ns),static_cast<uint64_t>(identity.source_frame_index)});
  record.vector=ainvr::search::NormalizeVector(std::move(product.embedding),spec.dimensions);
  const int64_t days=lease.grant->limits.retention_days;
  if(days<1||days>365||record.captured_ms>INT64_MAX-days*86400000)throw std::runtime_error("search_prepared_expiry_invalid");
  sample->expires_ms=record.captured_ms+days*86400000;sample->track_slot=selection.slot;sample->jpeg=std::move(product.jpeg);
  auto& evidence=sample->evidence;
  evidence={{"schema_version","1.0"},{"role","match"},{"source_input_id",source.input_stream_id},
    {"output_channel_id",source.channel_id},{"recording_channel_id",source.recording_channel_id},
    {"input_path",source.input_path},{"output_path",source.output_path},{"stream_session_id",record.session},
    {"source_pts_ns",std::to_string(identity.source_pts_ns)},{"source_frame_index",std::to_string(identity.source_frame_index)},
    {"frame_id",frame_id},{"frame_width",geometry.observation_width},{"frame_height",geometry.observation_height},
    {"raw_frame_width",geometry.raw_width},{"raw_frame_height",geometry.raw_height},
    {"captured_ms",record.captured_ms},{"image_width",product.plan.width},{"image_height",product.plan.height},
    {"raw_source_rectangle",product.plan.source_rectangle},{"image_space","raw-nv12-crop"},{"projection_mode","raw_planar"},
    {"input_spec_version",space.input_spec_version},{"model_input",{{"width",256},{"height",256},{"color","RGB"},
      {"interpolation","INTER_AREA"},{"aspect","squash"},{"mean",127.5},{"divisor",127.5}}},
    {"source_yuv",{{"bt709",frame.Bt709()},{"full_range",frame.FullRange()}}},
    {"render_backend",product.render_backend},{"encoder_backend",product.encoder_backend},{"vision_backend",product.vision_backend}};
  if(frame.SourceDetection()){
    const auto& target=*frame.SourceDetection();evidence["target"]={{"track_id",record.track},{"label_id",target.label_id},
      {"class_name",target.class_name},{"observation_bbox",target.bbox},{"raw_bbox",*frame.RawTargetBox()}};
    const auto support=SearchObjectPixelSupport(target.bbox,geometry.observation_width,geometry.observation_height,
      geometry.raw_width,geometry.raw_height);
    if(support)evidence["target"][kSearchPixelSupportMetric]=*support;
  }
  if(appearance){
    const auto& a=*appearance;
    if(!SearchSamplingPolicy::ProbeContractValid(selection)||a.reference_fingerprint!=selection.probe_reference_fingerprint||
      a.reference_fingerprint.size()!=64||!std::all_of(a.reference_fingerprint.begin(),a.reference_fingerprint.end(),
        [](char c){return(c>='0'&&c<='9')||(c>='a'&&c<='f');})||
      !std::isfinite(a.distance)||a.distance<0||a.distance>2||!std::isfinite(a.threshold)||a.threshold<0||a.threshold>1||
      a.threshold!=selection.probe_threshold||a.distance<a.threshold)throw std::runtime_error("search_appearance_audit_invalid");
    evidence["appearance"]={{"metric",kSearchAppearanceMetric},{"reference_fingerprint",a.reference_fingerprint},
      {"distance",a.distance},{"threshold",a.threshold},{"threshold_experimental",true}};
  }else if(SearchSamplingPolicy::IsProbe(selection))throw std::runtime_error("search_appearance_audit_required");
  if(evidence.dump().size()>16384)throw std::runtime_error("search_prepared_metadata_too_large");
  return std::make_shared<const SearchPreparedSample>(SearchPreparedSample{std::move(sample),source,space,selection});
}
} // namespace ai_service::output
