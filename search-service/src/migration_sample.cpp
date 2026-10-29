#include "migration_sample.hpp"
#include <charconv>
#include <limits>
namespace ainvr::search {
namespace {
[[noreturn]] void Invalid(){throw std::invalid_argument("invalid_search_reencode_sample");}
bool Hash(const std::string& value) {
  return value.size()==64&&std::all_of(value.begin(),value.end(),[](char c){return(c>='0'&&c<='9')||(c>='a'&&c<='f');});
}
uint64_t Integer(const nlohmann::json& value) {
  if(!value.is_string())Invalid();
  const auto& text=value.get_ref<const std::string&>();uint64_t result=0;
  if(text.empty()||text.size()>20||(text.size()>1&&text.front()=='0'))Invalid();
  const auto parsed=std::from_chars(text.data(),text.data()+text.size(),result);
  if(parsed.ec!=std::errc()||parsed.ptr!=text.data()+text.size())Invalid();
  return result;
}
}
std::string ReencodedSampleStorageUuid(const Sample& source,const std::string& target_model_version) {
  const auto& old=source.record;
  if((old.scene&&source.track_slot)||(source.track_slot&&*source.track_slot>=8))Invalid();
  try {
    SearchSampleStorageIdentity identity{source.evidence.at("source_input_id").get<std::string>(),old.channel,
      old.processor,old.session,target_model_version,old.track,source.track_slot,
      Integer(source.evidence.at("source_pts_ns")),Integer(source.evidence.at("source_frame_index"))};
    if(old.scene||source.track_slot)return SearchSampleStorageUuid(identity);
    // Old immutable object records have no recoverable slot assignment. Keep
    // them immutable rather than guessing a slot or inventing a new tracker.
    return SampleStorageUuid("ainvr-search-reencode-legacy-v1",nlohmann::json::array({old.id,target_model_version}));
  } catch(const nlohmann::json::exception&) {Invalid();}
}
bool ReencodedMetadataMatches(const Sample& source,const Sample& target,
    const RuntimeModelPin& source_model,const RuntimeModelPin& target_model,const PackageSpec& target_spec,
    const std::string& source_jpeg_sha256,const std::string& target_jpeg_sha256,size_t target_dimensions) {
  const auto& before=source.record;const auto& after=target.record;
  if(!ValidRuntimeModelPin(source_model)||!ValidRuntimeModelPin(target_model)||
      before.model!=source_model.model_version||after.model!=target_model.model_version||before.model==after.model||
      target_spec.id!=target_model.package_id||target_spec.dimensions!=target_dimensions||target_spec.pruned||
      !Hash(source.fingerprint)||!Hash(target.fingerprint)||!Hash(source_jpeg_sha256)||source_jpeg_sha256!=target_jpeg_sha256||
      before.channel!=after.channel||before.processor!=after.processor||before.session!=after.session||before.track!=after.track||
      before.scene!=after.scene||source.track_slot!=target.track_slot||before.captured_ms!=after.captured_ms||
      source.expires_ms!=target.expires_ms||!source.evidence.is_object()||!target.evidence.is_object())return false;
  try {
    if(after.id!=ReencodedSampleStorageUuid(source,target_model.model_version))return false;
    const auto& provenance=target.evidence.at("reencoded_from");
    if(!provenance.is_object()||provenance.at("schema_version")!="search-retained-jpeg-reencode-v1"||
        provenance.at("source_sample_id")!=before.id||provenance.at("source_fingerprint")!=source.fingerprint||
        provenance.at("source_model")!=before.model||provenance.at("jpeg_sha256")!=source_jpeg_sha256||
        provenance.at("target_package_id")!=target_model.package_id||provenance.at("target_package_sha256")!=target_model.package_sha256||
        provenance.at("input_kind")!="retained-jpeg"||
        provenance.at("preprocessing_version")!=kRetainedJpegPreprocessingVersion||
        provenance.at("source_input_spec_version")!=source.evidence.value("input_spec_version",nlohmann::json()))return false;
    if(source.evidence.contains("appearance")&&provenance.at("source_appearance")!=source.evidence.at("appearance"))return false;
    auto expected=source.evidence;expected.erase("appearance");expected.erase("reencoded_from");
    expected["input_spec_version"]=target_spec.input_spec_version;
    auto actual=target.evidence;actual.erase("reencoded_from");
    return actual==expected;
  }catch(const std::exception&){return false;}
}
Sample MakeReencodedSample(const Sample& source,const RuntimeModelPin& source_model,
    const RuntimeModelPin& target_model,const PackageSpec& target_spec,
    const std::vector<float>& embedding,const std::string& expected_source_fingerprint,
    const std::string& expected_jpeg_sha256,int64_t now_ms) {
  const auto& old=source.record;
  if(!ValidRuntimeModelPin(source_model)||!ValidRuntimeModelPin(target_model)||
      source_model.model_version!=old.model||source_model.model_version==target_model.model_version||
      target_spec.id!=target_model.package_id||target_spec.pruned||target_spec.dimensions<1||target_spec.dimensions>4096||
      target_spec.input_spec_version.empty()||target_spec.input_spec_version.size()>512||
      !Hash(expected_source_fingerprint)||source.fingerprint!=expected_source_fingerprint||
      (!old.fingerprint.empty()&&old.fingerprint!=source.fingerprint)||!Hash(expected_jpeg_sha256)||
      now_ms<0||old.captured_ms<0||old.captured_ms>now_ms||source.expires_ms<=now_ms||
      source.jpeg.size()<4||source.jpeg.size()>8*1024*1024||source.jpeg[0]!=255||source.jpeg[1]!=216||
      source.jpeg[source.jpeg.size()-2]!=255||source.jpeg.back()!=217||
      SampleSha256(source.jpeg.data(),source.jpeg.size())!=expected_jpeg_sha256||
      !source.evidence.is_object()||source.evidence.dump().size()>16384||
      (old.scene&&source.track_slot)||(source.track_slot&&*source.track_slot>=8))Invalid();
  try {
    if(source.evidence.at("schema_version")!="1.0"||source.evidence.at("role")!="match"||
        source.evidence.at("stream_session_id")!=old.session||
        (!source.evidence.at("output_channel_id").is_null()&&source.evidence.at("output_channel_id")!=old.channel))Invalid();
    Sample out;
    // Deliberately do not read/copy the old vector. A verified JPEG is useful
    // even if that old representation is corrupt or its weights are gone.
    out.record.channel=old.channel;out.record.processor=old.processor;out.record.session=old.session;
    out.record.track=old.track;out.record.model=target_model.model_version;out.record.captured_ms=old.captured_ms;
    out.record.scene=old.scene;out.track_slot=source.track_slot;
    out.record.id=ReencodedSampleStorageUuid(source,target_model.model_version);
    out.record.vector=NormalizeVector(embedding,target_spec.dimensions);
    out.evidence=source.evidence;out.jpeg=source.jpeg;out.expires_ms=source.expires_ms;
    nlohmann::json provenance={{"schema_version","search-retained-jpeg-reencode-v1"},{"source_sample_id",old.id},
      {"source_fingerprint",source.fingerprint},{"source_model",old.model},{"jpeg_sha256",expected_jpeg_sha256},
      {"source_input_spec_version",source.evidence.value("input_spec_version",nlohmann::json())},
      {"target_package_id",target_model.package_id},{"target_package_sha256",target_model.package_sha256},
      {"input_kind","retained-jpeg"},{"preprocessing_version",kRetainedJpegPreprocessingVersion}};
    // A cosine change measurement belongs to its original feature space; do
    // not relabel it as a measurement made by the replacement encoder.
    if(out.evidence.contains("appearance")) {
      provenance["source_appearance"]=out.evidence.at("appearance");out.evidence.erase("appearance");
    }
    out.evidence["reencoded_from"]=std::move(provenance);
    out.evidence["input_spec_version"]=target_spec.input_spec_version;
    if(out.evidence.dump().size()>16384)Invalid();
    const auto digest=ComputeSampleContractDigest(out);
    out.fingerprint=out.record.fingerprint=digest.fingerprint;
    return out;
  } catch(const nlohmann::json::exception&) {Invalid();}
}
}  // namespace ainvr::search
