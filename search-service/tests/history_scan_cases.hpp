// Included after the history fixture helpers. Synthetic, isolated Mongo only.
#include "history_scan_plan.hpp"

bool ScanPlanHasStage(const Json& plan, const char* stage) {
  if (plan.is_object() && plan.value("stage", "") == stage) return true;
  if (plan.is_structured()) for (const auto& child : plan)
    if (ScanPlanHasStage(child, stage)) return true;
  return false;
}

void ScanPlans(const std::string& uri, const std::string& database, int64_t at,
               mongoc_client_t* client) {
  HistoryMongo history(uri, database); history.Initialize();
  std::vector<Sample> written;
  for (int n=0; n<36; ++n) {
    auto sample=Make(40000+n, at-(n%5==0?20000:0));
    sample.record.channel=Id(41000+n%3);
    for(const auto* field:{"source_input_id","output_channel_id","recording_channel_id"})
      sample.evidence[field]=sample.record.channel;
    if(n%7==0)sample.record.model="other-model";
    // Larger than metadata, but deliberately small enough for a lightweight fixture.
    // Built as a new buffer: GCC 11 reports a false stringop-overflow for a mid-vector fill insert under -Werror.
    std::vector<uint8_t> padded(sample.jpeg.begin(),sample.jpeg.begin()+2);
    padded.resize(2+16384,17); padded.insert(padded.end(),sample.jpeg.begin()+2,sample.jpeg.end());
    sample.jpeg=std::move(padded);
    history.Put(sample);written.push_back(std::move(sample));
  }
  // Expiry and durable deletion intent must still exclude rows under the hint.
  const auto date=[](int64_t value){return Json{{"$date",{{"$numberLong",std::to_string(value)}}}};};
  Command(client,database,{{"update","search_samples"},{"updates",Json::array({
    {{"q",{{"_id",written[1].record.id}}},{"u",{{"$set",{{"expires_at",date(Now()-1000)}}}}}}
  })}});
  Command(client,database,{{"insert","search_deletions"},{"documents",Json::array({
    {{"_id","scan-intent"},{"channel",written[2].record.channel},
     {"from",at-1},{"to",at+1},{"expires_at",date(at+60000)}}
  })}});
  for(size_t count:{size_t(1),size_t(3),size_t(100)}) {
    Scope scope;scope.from_ms=at-1;scope.to_ms=at+1;scope.limit=20;
    for(size_t n=0;n<count;++n)scope.channels.insert(Id(41000+n));
    std::vector<std::string> expected,actual;
    for(size_t n=0;n<written.size();++n) {
      const auto& r=written[n].record;
      if(n!=1&&r.model=="pair-v1"&&scope.channels.count(r.channel)&&
          r.captured_ms==at&&r.channel!=written[2].record.channel)expected.push_back(r.id);
    }
    int64_t checkpoint=0;bool exhausted=false;
    for(size_t page=0;page<=written.size();++page) {
      const auto batch=history.Scan("pair-v1",scope,checkpoint,2);
      for(const auto& sample:batch.samples){actual.push_back(sample.record.id);Check(sample.jpeg.empty());}
      Check(batch.checkpoint>=checkpoint);
      if(batch.exhausted){exhausted=true;break;}
      // A page containing only deleted rows still advances its ordinal fence.
      Check(batch.checkpoint>checkpoint);checkpoint=batch.checkpoint;
    }
    Check(exhausted&&actual==expected);
    const auto options=nlohmann::ordered_json{{"find","search_samples"},
      {"filter",{{"model","pair-v1"},{"channel",{{"$in",scope.channels}}},
        {"captured_ms",{{"$gte",scope.from_ms},{"$lt",scope.to_ms}}},
        {"ordinal",{{"$gt",0}}},{"expires_at",{{"$gt",date(Now())}}}}},
      {"sort",{{"ordinal",1}}},{"projection",{{"jpeg",0}}},{"limit",2},
      {"hint",kHistoryScanChannelIndex}};
    const nlohmann::ordered_json command{{"explain",options},{"verbosity","executionStats"}};
    const auto text=command.dump();bson_error_t error{};
    auto* input=bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()),text.size(),&error);
    Check(input!=nullptr);bson_t reply;
    const bool ok=mongoc_client_command_simple(client,database.c_str(),input,nullptr,&reply,&error);
    bson_destroy(input);Check(ok);
    char* raw=bson_as_relaxed_extended_json(&reply,nullptr);
    const auto plan=Json::parse(raw);bson_free(raw);bson_destroy(&reply);
    Check(!ScanPlanHasStage(plan.at("queryPlanner").at("winningPlan"),"SORT"));
    const auto& stats=plan.at("executionStats");
    Check(stats.at("totalDocsExamined")==stats.at("nReturned"));
  }
  Scope oversized;oversized.from_ms=at-1;oversized.to_ms=at+1;oversized.limit=20;
  for(int n=0;n<101;++n)oversized.channels.insert(Id(41000+n));
  Reject([&]{history.Scan("pair-v1",oversized,0,2);});
  std::cout<<"history Scan: single/multi-channel ordered pagination, expiry, deletion intent and bounded FETCH passed\n";
}
