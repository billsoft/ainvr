// Real isolated Mongo cursor/lineage persistence. PG authorization is tested
// separately; these internal storage calls intentionally do not grant a lease.
#pragma once
#include "migration_coverage.hpp"
inline void RunMigrationCoverageCases(const std::string& uri,const std::string& database){
  auto mongo=mongoc_client_new(uri.c_str());auto db=mongoc_client_get_database(mongo,database.c_str());
  const auto cleanup=[&]{bson_error_t error{};const bool ok=mongoc_database_drop(db,&error);
    mongoc_database_destroy(db);mongoc_client_destroy(mongo);Check(ok,"coverage fixture cleanup");};
  try{
    HistoryBudget budget;budget.max_samples=1000;auto history=std::make_unique<HistoryMongo>(uri,database,budget);history->Initialize();
    MigrationCoverageDefinition definition{std::string(64,'a'),
      {"siglip-so400m-i18n-full-int8",std::string(64,'b'),"search-v1-"+std::string(64,'b')},
      {"siglip2-base-full-int8",std::string(64,'c'),"search-v1-"+std::string(64,'c')},
      {{channel},Now()-6000,Now()+1000,20},0,0,Now()+86400000,1000};
    const auto at=definition.scope.from_ms+100;
    std::vector<Sample> sources;
    for(int i=0;i<41;++i){Sample source;source.record={Id(2000+i),channel,"processor","session","track-"+std::to_string(i),
        definition.source.model_version,at+i,false,{1,0}};
      source.expires_ms=Now()+60000;source.jpeg={255,216,255,217};source.evidence=SampleJson(at+i).at("evidence");
      source.evidence["stream_session_id"]="session";source.evidence["source_pts_ns"]=std::to_string((at+i)*1000000);
      source.evidence["source_frame_index"]=std::to_string(i+1);source.evidence["frame_id"]=Id(3000+i);
      if(i==40){source.track_slot=0;history->ReplaceTrackSlot(source,0,"","coverage-original");}else history->Put(source);
      sources.push_back(history->Get(source.record.id,true).value());
    }
    definition.source_high_watermark=history->MetadataWatermark(definition.source.model_version,definition.scope);
    const auto& spec=FindPackageSpec(definition.target.package_id);std::vector<float> vector(spec.dimensions,0);vector[0]=1;
    for(int i=0;i<41;++i)if(i%2==0){const auto& source=sources[size_t(i)];
      const auto sha=SampleSha256(source.jpeg.data(),source.jpeg.size());
      auto target=MakeReencodedSample(source,definition.source,definition.target,spec,vector,source.fingerprint,sha,Now());
      if(target.track_slot)history->ReplaceTrackSlot(target,0,"",source.fingerprint);else history->Put(target);
    }
    // Correctly hashed but wrong lineage must not count as a match.
    auto forged=MakeReencodedSample(sources[1],definition.source,definition.target,spec,vector,sources[1].fingerprint,
      SampleSha256(sources[1].jpeg.data(),sources[1].jpeg.size()),Now());
    forged.evidence["reencoded_from"]["source_fingerprint"]=std::string(64,'d');history->Put(forged);
    definition.minimum_target_checkpoint=history->MetadataWatermark(definition.target.model_version,definition.scope);
    const auto job=Id(4000);const auto first=history->BeginMigrationCoverage(job,1,"fixture-actor",definition);
    Check(first.at("checkpoint")=="0"&&first.at("state")=="building","report did work during begin");
    bool pending=false;try{history->ReadMigrationCoverage(job,1,"fixture-actor",definition);}catch(...){pending=true;}Check(pending,"unfinished report exposed final header");
    const auto partial=history->AdvanceMigrationCoverage(job,1,"fixture-actor",definition,0);
    Check(partial.at("checkpoint")=="32"&&partial.at("coverage_snapshot").at("required")==32,"report step exceeded/failed 32 metadata budget");
    Check(history->AdvanceMigrationCoverage(job,1,"fixture-actor",definition,0)==partial,"unknown step reply was recomputed");
    auto slot=sources.back();const auto expected=slot.fingerprint;++slot.record.captured_ms;slot.evidence["frame_id"]=Id(4999);
    slot.evidence["source_pts_ns"]=std::to_string(std::stoll(slot.evidence.at("source_pts_ns").get<std::string>())+1000000);
    slot.evidence["source_frame_index"]="100";history->ReplaceTrackSlot(slot,0,expected,"coverage-new-frame");
    history.reset();history=std::make_unique<HistoryMongo>(uri,database,budget);history->Initialize();
    const auto done=history->AdvanceMigrationCoverage(job,1,"fixture-actor",definition,32);
    Check(done.at("state")=="complete"&&done.at("checkpoint")==std::to_string(definition.source_high_watermark),"restart failed to finish traversal H");
    const auto report=history->ReadMigrationCoverage(job,1,"fixture-actor",definition);
    Check(report.at("scanned")==40&&report.at("encoded")==20&&report.at("unavailable")==20,"report used attempts or stale slot instead of live source<=H");
    Check(report.at("target_checkpoint")==std::to_string(definition.minimum_target_checkpoint)&&report.at("partitions")[0].at("records")==20,
      "processing watermark was confused with matched coverage");
    const auto prior_hash=report.at("coverage_sha256");
    history->DeleteRange(channel,sources[0].record.captured_ms,sources[0].record.captured_ms+1);
    const auto restarted=history->BeginMigrationCoverage(job,2,"fixture-actor",definition);Check(restarted.at("checkpoint")=="0","new PG generation reused old snapshot");
    auto step=history->AdvanceMigrationCoverage(job,2,"fixture-actor",definition,0);
    step=history->AdvanceMigrationCoverage(job,2,"fixture-actor",definition,std::stoll(step.at("checkpoint").get<std::string>()));
    const auto current=history->ReadMigrationCoverage(job,2,"fixture-actor",definition);
    Check(step.at("state")=="complete"&&current.at("scanned")==39&&current.at("encoded")==19&&current.at("coverage_sha256")!=prior_hash,
      "new pass failed to bind actual deletion/FP facts");
    bool stale=false;try{history->ReadMigrationCoverage(job,1,"fixture-actor",definition);}catch(...){stale=true;}Check(stale,"old report generation not fenced");
    stale=false;try{history->ReadMigrationCoverage(job,2,"different-actor",definition);}catch(...){stale=true;}Check(stale,"report actor not fenced");
    // Seed private malformed derived rows, then restart to discard usage cache.
    // The actual BSON-size/count aggregation must reject, never evict them or
    // the authoritative samples. No arbitrary directory or production DB used.
    auto reports=mongoc_client_get_collection(mongo,database.c_str(),"search_migration_reports");bson_error_t error{};
    bson_t* docs[1000]{};const bson_t* pointers[1000]{};
    for(int i=0;i<1000;++i){auto doc=bson_new();BSON_APPEND_UTF8(doc,"_id",("quota-"+std::to_string(i)).c_str());
      BSON_APPEND_DATE_TIME(doc,"expires_at",Now()+60000);docs[i]=doc;pointers[i]=doc;}
    const bool inserted=mongoc_collection_insert_many(reports,pointers,1000,nullptr,nullptr,&error);
    for(auto* doc:docs)bson_destroy(doc);
    Check(inserted,"report quota fixture");
    history.reset();history=std::make_unique<HistoryMongo>(uri,database,budget);history->Initialize();
    const auto samples_before=history->Usage().at("samples");bool capacity=false;
    try{history->BeginMigrationCoverage(Id(4001),1,"fixture-actor",definition);}catch(const std::runtime_error& failure){capacity=std::string(failure.what())=="migration_report_capacity";}
    Check(capacity&&history->Usage().at("samples")==samples_before,"report count quota evicted history or accepted overflow");
    mongoc_collection_destroy(reports);history.reset();cleanup();
  }catch(...){cleanup();throw;}
}
