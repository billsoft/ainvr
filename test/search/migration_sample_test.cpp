// Pure metadata and synthetic bytes. No database, image codec, model or SDK.
#include "migration_sample.hpp"
#include <iostream>
#include <limits>
#include <set>
using namespace ainvr::search;
namespace {
size_t checks=0;
void Check(bool value,const char* message){++checks;if(!value)throw std::runtime_error(message);}
template<class F>void Reject(F run){bool rejected=false;try{run();}catch(const std::exception&){rejected=true;}Check(rejected,"invalid migration accepted");}
RuntimeModelPin Pin(char hash){return {"siglip2-base-full-int8",std::string(64,hash),"search-v1-"+std::string(64,hash)};}
Sample Source(){
  Sample value;auto& r=value.record;
  r.id="b0000000-0000-4000-8000-000000000001";r.channel="b0000000-0000-4000-8000-000000000002";
  r.processor="b0000000-0000-4000-8000-000000000003";r.session="source-session";r.track="track-7";
  r.model=Pin('a').model_version;r.captured_ms=1000;r.scene=false;r.vector={std::numeric_limits<float>::quiet_NaN()};
  r.fingerprint=value.fingerprint=std::string(64,'c');value.track_slot=0;value.jpeg={255,216,7,8,255,217};value.expires_ms=100000;
  value.evidence={{"schema_version","1.0"},{"role","match"},{"source_input_id","b0000000-0000-4000-8000-000000000004"},
    {"output_channel_id",r.channel},{"recording_channel_id",r.channel},{"stream_session_id",r.session},
    {"source_pts_ns","1000000000"},{"source_frame_index","100"},{"frame_id","b0000000-0000-4000-8000-000000000005"},
    {"input_path","live/input"},{"output_path","live/derived"},{"input_spec_version","old-input-spec"},
    {"raw_source_rectangle",{10,20,60,80}},{"frame_width",1920},{"frame_height",1080},
    {"appearance",{{"metric","old-model-distance"},{"distance",.4}}}};
  return value;
}
}
int main(){try{
  const auto source_pin=Pin('a'),target_pin=Pin('b');PackageSpec spec;spec.id=target_pin.package_id;spec.dimensions=3;spec.input_spec_version="new-input-spec";
  const auto source=Source();const auto jpeg_sha=SampleSha256(source.jpeg.data(),source.jpeg.size());
  const auto make=[&](const Sample& row){return MakeReencodedSample(row,source_pin,target_pin,spec,{2,0,0},row.fingerprint,jpeg_sha,2000);};
  const auto migrated=make(source);
  Check(migrated.record.id==ReencodedSampleStorageUuid(source,target_pin.model_version),"receipt/submit key differs");
  Check(migrated.record.vector==std::vector<float>({1,0,0}),"old corrupt vector used or new vector not normalized");
  Check(migrated.jpeg==source.jpeg&&migrated.expires_ms==source.expires_ms,"evidence changed or retention extended");
  Check(migrated.record.captured_ms==source.record.captured_ms&&migrated.record.channel==source.record.channel&&
    migrated.record.processor==source.record.processor&&migrated.record.track==source.record.track,"source identity changed");
  for(const auto* key:{"frame_id","recording_channel_id","input_path","output_path","raw_source_rectangle"})
    Check(migrated.evidence.at(key)==source.evidence.at(key),"frame or playback provenance changed");
  Check(migrated.record.model==target_pin.model_version&&migrated.evidence.at("input_spec_version")==spec.input_spec_version,"wrong target model");
  Check(!migrated.evidence.contains("appearance")&&migrated.evidence.at("reencoded_from").at("source_appearance")==source.evidence.at("appearance"),"old-space metric relabeled");
  Check(migrated.fingerprint==ComputeSampleContractDigest(migrated).fingerprint&&migrated.record.fingerprint==migrated.fingerprint,"target digest not frozen");
  Check(migrated.evidence.at("reencoded_from").at("preprocessing_version")==kRetainedJpegPreprocessingVersion,"retained JPEG preprocessing identity missing");
  Check(ReencodedMetadataMatches(source,migrated,source_pin,target_pin,spec,jpeg_sha,jpeg_sha,3),"valid retained JPEG lineage refused");
  for(int change=0;change<2;++change){auto bad=migrated;
    if(change)bad.evidence["reencoded_from"]["preprocessing_version"]="other-path";
    else bad.evidence["reencoded_from"].erase("preprocessing_version");
    Check(!ReencodedMetadataMatches(source,bad,source_pin,target_pin,spec,jpeg_sha,jpeg_sha,3),"unproven preprocessing accepted as same lineage");
  }
  Check(source.evidence.at("input_spec_version")=="old-input-spec"&&source.evidence.contains("appearance"),"source mutated");
  std::set<std::string> slots;
  for(size_t slot=0;slot<8;++slot){
    auto row=source;row.track_slot=slot;const auto target=make(row);
    const auto key=nlohmann::json::array({row.evidence.at("source_input_id"),row.record.channel,row.record.processor,row.record.session,
      target_pin.model_version,row.record.track,slot});
    Check(target.record.id==SampleStorageUuid("ainvr-search-slot-v1",key),"live/migration slot key differs");
    Check(target.track_slot==slot&&slots.insert(target.record.id).second,"slot collision");
    row.fingerprint=row.record.fingerprint=std::string(64,'d');row.record.captured_ms=1500;
    row.evidence["source_pts_ns"]="2000000000";row.evidence["source_frame_index"]="101";
    Check(make(row).record.id==target.record.id,"new frame created another slot document");
    Check(make(row).fingerprint!=target.fingerprint,"new frame reused old evidence digest");
  }
  auto scene=source;scene.record.scene=true;scene.record.track.clear();scene.track_slot.reset();
  const auto scene_target=make(scene);
  Check(scene_target.record.id==SampleStorageUuid("ainvr-search-scene-v1",nlohmann::json::array({scene.evidence.at("source_input_id"),
    scene.record.channel,scene.record.processor,scene.record.session,target_pin.model_version,uint64_t(1000000000),uint64_t(100)})),"live/migration scene key differs");
  scene.evidence["source_frame_index"]="101";Check(make(scene).record.id!=scene_target.record.id,"distinct scene frames merged");
  auto legacy=source;legacy.track_slot.reset();const auto legacy_target=make(legacy);
  Check(!legacy_target.track_slot&&!legacy_target.record.scene,"legacy object assigned a fake slot/scene");
  Check(legacy_target.record.id==SampleStorageUuid("ainvr-search-reencode-legacy-v1",nlohmann::json::array({legacy.record.id,target_pin.model_version})),"legacy deterministic key changed");
  legacy.evidence["output_channel_id"]=nullptr;legacy.evidence["recording_channel_id"]=nullptr;
  Check(make(legacy).evidence.at("recording_channel_id").is_null(),"legacy unknown recording fabricated or refused");
  for(int change=0;change<14;++change){auto bad=source;
    switch(change){case 0:bad.fingerprint=std::string(64,'e');break;case 1:bad.jpeg[2]^=1;break;
      case 2:bad.expires_ms=2000;break;case 3:bad.record.captured_ms=2001;break;case 4:bad.evidence["stream_session_id"]="other";break;
      case 5:bad.evidence["source_pts_ns"]="01";break;case 6:bad.evidence["source_frame_index"]="18446744073709551616";break;
      case 7:bad.track_slot=8;break;case 8:bad.record.scene=true;break;case 9:bad.evidence["output_channel_id"]="other";break;
      case 10:bad.evidence["role"]="context";break;case 11:bad.evidence["source_input_id"]="";break;
      case 12:bad.evidence["oversized"]=std::string(16384,'x');break;case 13:bad.jpeg={0,1,2,3};break;}
    Reject([&]{make(bad);});
  }
  Reject([&]{MakeReencodedSample(source,source_pin,source_pin,spec,{1,0,0},source.fingerprint,jpeg_sha,2000);});
  Reject([&]{MakeReencodedSample(source,source_pin,target_pin,spec,{1,0},source.fingerprint,jpeg_sha,2000);});
  Reject([&]{MakeReencodedSample(source,source_pin,target_pin,spec,{1,std::numeric_limits<float>::infinity(),0},source.fingerprint,jpeg_sha,2000);});
  auto pruned=spec;pruned.pruned=true;Reject([&]{MakeReencodedSample(source,source_pin,target_pin,pruned,{1,0,0},source.fingerprint,jpeg_sha,2000);});
  // Shared key preserves numeric uint64 JSON for the full identity range.
  SearchSampleStorageIdentity maximum{"in","out","processor","session","model","",{},UINT64_MAX,UINT64_MAX};
  Check(SearchSampleStorageUuid(maximum)==SampleStorageUuid("ainvr-search-scene-v1",nlohmann::json::array({"in","out","processor","session","model",UINT64_MAX,UINT64_MAX})),"uint64 key truncated");
  std::cout<<"migration sample pure checks: "<<checks<<" passed; no database, codec or model access\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
