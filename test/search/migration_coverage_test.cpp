// Pure metadata/hash-chain oracle. No Mongo connection, images decoded or SDK.
#include "migration_coverage.hpp"
#include "migration_sample.hpp"
#include <iostream>
using namespace ainvr::search;
using Json=nlohmann::json;
namespace {
int checks=0;void Check(bool value){++checks;if(!value)throw std::runtime_error("coverage contract failed");}
template<class F>void Reject(F operation){bool failed=false;try{operation();}catch(...){failed=true;}Check(failed);}
std::string Id(int i){return "00000000-0000-4000-8000-"+std::to_string(100000000000LL+i);}
constexpr int64_t day=86400000,begin=1788220800001LL,now=begin+32*day;
MigrationCoverageDefinition Definition(){return{std::string(64,'a'),
  {"siglip-so400m-i18n-full-int8",std::string(64,'b'),"search-v1-"+std::string(64,'b')},
  {"siglip2-base-full-int8",std::string(64,'c'),"search-v1-"+std::string(64,'c')},
  {{Id(1)},begin,begin+31*day,20},100,1000,now+7*day,1000000};}
MigrationCoverageObservation Observation(const MigrationCoverageDefinition& d,int i,const std::string& channel,int64_t captured){
  Sample source;source.record={Id(1000+i),channel,"processor","session","track-"+std::to_string(i),d.source.model_version,captured,false,{1,0}};
  source.expires_ms=now+60000;source.jpeg={255,216,255,217};
  source.evidence={{"schema_version","1.0"},{"role","match"},{"source_input_id",Id(2)},
    {"output_channel_id",channel},{"recording_channel_id",nullptr},{"stream_session_id","session"},
    {"source_pts_ns",std::to_string(uint64_t(captured)*1000000)},{"source_frame_index",std::to_string(i+1)},
    {"frame_id",Id(10000+i)},{"frame_width",1920},{"frame_height",1080},
    {"input_path","/live/raw"},{"output_path","/live/ai"},{"appearance",{{"version","old"}}}};
  source.fingerprint=source.record.fingerprint=ComputeSampleContractDigest(source).fingerprint;
  const auto jpeg=SampleSha256(source.jpeg.data(),source.jpeg.size());const auto& spec=FindPackageSpec(d.target.package_id);
  std::vector<float> vector(spec.dimensions,0);vector[0]=1;
  auto target=MakeReencodedSample(source,d.source,d.target,spec,vector,source.fingerprint,jpeg,now);
  source.jpeg.clear();source.record.vector.clear();target.jpeg.clear();target.record.vector.clear();
  return{{source,i+1,jpeg,2,"f32le"},HistoryMetadataRow{target,500+i,jpeg,spec.dimensions,"f32le"},true};
}
}
int main(){try{
  auto d=Definition();const auto one=Observation(d,0,Id(1),begin+1000);const auto& spec=FindPackageSpec(d.target.package_id);
  Check(ReencodedMetadataMatches(one.source.sample,one.target->sample,d.source,d.target,spec,
    one.source.jpeg_sha256,one.target->jpeg_sha256,one.target->dimensions));
  for(const auto* field:{"source_fingerprint","source_sample_id","source_model","jpeg_sha256","target_package_sha256","input_kind"}){
    auto bad=one;bad.target->sample.evidence["reencoded_from"][field]="wrong";
    Check(!ReencodedMetadataMatches(bad.source.sample,bad.target->sample,d.source,d.target,spec,
      bad.source.jpeg_sha256,bad.target->jpeg_sha256,bad.target->dimensions));
  }
  for(const auto* field:{"frame_id","input_path","source_pts_ns","input_spec_version"}){
    auto bad=one;bad.target->sample.evidence[field]="wrong";
    Check(!ReencodedMetadataMatches(bad.source.sample,bad.target->sample,d.source,d.target,spec,
      bad.source.jpeg_sha256,bad.target->jpeg_sha256,bad.target->dimensions));
  }
  MigrationCoveragePass pass(d);Reject([&]{pass.Page();});
  pass.Observe({{one},1,true},now);const auto page=pass.Page();
  Check(page.at("scanned")==1&&page.at("encoded")==1&&page.at("unavailable")==0);
  Check(page.at("target_checkpoint")=="1000"&&page.at("partitions")[0].at("checkpoint")=="500");
  Check(page.at("source_completed_through")=="100"&&pass.Checkpoint()==100&&pass.Complete());
  Check(MigrationCoveragePass::Restore(d,pass.State()).Page()==page);
  auto low=d;low.minimum_target_checkpoint=0;MigrationCoveragePass discovered(low);discovered.Observe({{one},1,true},now);
  low.minimum_target_checkpoint=500;Check(MigrationCoveragePass::Restore(low,discovered.State()).Page()==discovered.Page());
  low.minimum_target_checkpoint=501;Reject([&]{MigrationCoveragePass::Restore(low,discovered.State());});
  auto state=pass.State();state["state"]["matched"]=0;Reject([&]{MigrationCoveragePass::Restore(d,state);});
  auto other=d;other.source_high_watermark=99;Reject([&]{MigrationCoveragePass::Restore(other,pass.State());});
  Reject([&]{pass.Page(Id(1)+"/2026-09-99");});
  Reject([&]{pass.Observe({{},100,true},now);});
  auto missing=one;missing.target.reset();MigrationCoveragePass absent(d);absent.Observe({{missing},1,true},now);
  Check(absent.Page().at("scanned")==1&&absent.Page().at("encoded")==0&&absent.Page().at("unavailable")==1);
  auto expired=one;expired.source.sample.expires_ms=now;MigrationCoveragePass expiry(d);expiry.Observe({{expired},1,true},now);
  Check(expiry.Page().at("scanned")==0&&expiry.Page().at("partitions").empty());
  auto replaced=one;replaced.source_current=false;MigrationCoveragePass replacement(d);replacement.Observe({{replaced},1,true},now);
  Check(replacement.Page().at("scanned")==0&&replacement.Page().at("coverage_sha256")!=page.at("coverage_sha256"));
  auto different=one;different.target->ordinal=501;MigrationCoveragePass changed(d);changed.Observe({{different},1,true},now);
  Check(changed.Page().at("encoded")==1&&changed.Page().at("coverage_sha256")!=page.at("coverage_sha256"));
  // An empty post-TTL traversal can still finish processing H, without claiming
  // any source/scene coverage or resetting the acknowledged target watermark.
  MigrationCoveragePass empty(d);empty.Observe({{},0,true},now);Check(empty.Page().at("scanned")==0&&empty.Checkpoint()==100);
  MigrationCoveragePass bounded(d);const auto initial=bounded.State();
  Reject([&]{bounded.Observe({std::vector<MigrationCoverageObservation>(33,one),33,false},now);});
  Reject([&]{bounded.Observe({{one,one},2,false},now);});
  Reject([&]{bounded.Observe({{},0,false},now);});
  Reject([&]{bounded.Observe({{one},1,true},d.expires_ms);});Check(bounded.State()==initial);
  auto incomplete=one;incomplete.target->dimensions=2;MigrationCoveragePass dimensions(d);dimensions.Observe({{incomplete},1,true},now);
  Check(dimensions.Page().at("encoded")==0);
  // Arbitrary 31-day, non-midnight window legitimately touches 32 UTC days.
  auto large=Definition();large.scope.channels.clear();for(int c=0;c<100;++c)large.scope.channels.insert(Id(1+c));
  large.source_high_watermark=3200;MigrationCoveragePass all(large);int ordinal=0;
  for(const auto& channel:large.scope.channels){MigrationCoverageBatch batch;
    for(int i=0;i<32;++i){const auto captured=i==31?large.scope.to_ms-1:large.scope.from_ms+int64_t(i)*day;
      batch.rows.push_back(Observation(large,ordinal++,channel,captured));}
    batch.checkpoint=ordinal;batch.exhausted=ordinal==3200;all.Observe(batch,now);
  }
  std::optional<std::string> cursor;size_t records=0,pages=0;
  do{const auto part=all.Page(cursor);Check(part.dump().size()<=32768&&part.at("partitions").size()==32);
    records+=part.at("partitions").size();++pages;cursor=part.at("next_cursor").is_null()?std::nullopt:
      std::optional<std::string>(part.at("next_cursor").get<std::string>());}while(cursor);
  Check(records==3200&&pages==100&&all.Page().at("encoded")==3200);
  Check(MigrationCoveragePass::Restore(large,all.State()).Page()==all.Page());
  auto small=Definition();small.max_records=1;MigrationCoveragePass capacity(small);auto second=Observation(small,1,Id(1),begin+2000);
  Reject([&]{capacity.Observe({{one,second},2,true},now);});Check(capacity.State()==MigrationCoveragePass(small).State());
  std::cout<<"coverage: "<<checks<<" pure metadata checks passed; no Mongo, SDK, vector/image read or model inference\n";
}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}}
