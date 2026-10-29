// Runtime orchestration of the existing source admission and Mongo writer
// marker. Called by the managed config loop; no thread, queue or config store.
#pragma once
#include "history_mongo.hpp"
#include "source_admission.hpp"
#include <openssl/rand.h>
#include <functional>
#include <set>
namespace ainvr::search {
class SourceIngestionRuntime {
 public:
  using Json=nlohmann::json;
  using Report=std::function<Json(const Json&)>;
  SourceIngestionRuntime(HistoryMongo& history,std::shared_ptr<SourceAdmission> admission,
      std::set<std::string> channels,Report report)
      :history_(history),admission_(std::move(admission)),channels_(std::move(channels)),report_(std::move(report)){
    if(!admission_||channels_.empty()||channels_.size()>1024||!report_)
      throw std::invalid_argument("invalid_source_ingestion_runtime");
    admission_->Seal();
  }
  SourceIngestionRuntime(const SourceIngestionRuntime&)=delete;
  SourceIngestionRuntime&operator=(const SourceIngestionRuntime&)=delete;
  // The trusted runtime may remove a gate even after its PG owner has expired.
  // A new dirty+journalled writer epoch and persistent capture boundary MUST
  // precede reopening; local deadline expiry alone never invokes this branch.
  void Observe(const std::optional<RuntimeIngestionGate>& gate,int64_t wall_ms){
    if(gate){
      admission_->Apply(gate,wall_ms);
      if(!gate_||gate_->epoch!=gate->epoch){pending_report_=Json();reported_=false;}
      gate_=gate;resume_required_=true;
      if(!started_)Begin(wall_ms,false);
      if(reported_)return;
      const auto drained=admission_->DrainedGate();
      if(!drained)return;
      if(pending_report_.is_null()){
        const auto clean=history_.CleanSourceWriterEpoch(owner_,true);
        Json report={{"plan_id",gate->plan_id},{"worker",gate->worker},{"generation",gate->generation},{"epoch",gate->epoch}};
        if(!clean.durable||!clean.migration_safe){
          report["action"]="pause_rejected";
          const auto reason=clean.reason==SourceWriterReason::PreviousUnclean&&begin_reason_==SourceWriterReason::LegacyBootstrapRequired?
            begin_reason_:clean.reason;
          switch(reason){
            case SourceWriterReason::LegacyBootstrapRequired:
            case SourceWriterReason::PreviousUnclean:
            case SourceWriterReason::UnknownWrite:
            case SourceWriterReason::TopologyUnverified:report["error_code"]=SourceWriterReasonCode(reason);break;
            default:report["error_code"]="source_admission_unavailable";break;
          }
        }else{
          // Clean preceded this exact extent under a closed writer. This is
          // real Mongo H, not a counter or a browser-submitted high watermark.
          const auto extent=history_.MetadataExtent(gate->source.model_version,channels_);
          report["action"]="acknowledge_pause";
          report["observed_extent"]={{"from_ms",extent.at("from_ms")},{"to_ms",extent.at("to_ms")},
            {"high_watermark",extent.at("high_watermark")}};
        }
        pending_report_=std::move(report);
      }
      // Unknown transport retries keep the exact frozen report. A read/no-op
      // never converts an Unknown source mutation into a positive fence.
      const auto reply=report_(pending_report_);
      const auto field=pending_report_.at("action")=="acknowledge_pause"?"acknowledged":"rejected";
      reported_=reply.is_object()&&reply.contains(field)&&reply.at(field).is_boolean()&&reply.at(field).get<bool>();
      return;
    }
    if(!started_||resume_required_){
      admission_->Seal();
      if(!admission_->Drained())return;
      Begin(wall_ms,true);
      admission_->Apply(std::nullopt,wall_ms);
      gate_.reset();resume_required_=false;pending_report_=Json();reported_=false;
    }
  }
  // The owner calls this only after HTTP handlers and maintenance have drained.
  // Failure retains dirty/unknown state for the next process; never fake clean.
  void Stop()noexcept{
    admission_->Seal();
    if(started_&&admission_->Drained())try{(void)history_.CleanSourceWriterEpoch(owner_,true);}catch(...){}
  }
 private:
  static std::string Owner(){
    unsigned char bytes[16];if(RAND_bytes(bytes,sizeof(bytes))!=1)throw std::runtime_error("source_writer_entropy_unavailable");
    bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
    static const char hex[]="0123456789abcdef";std::string out;
    for(size_t i=0;i<sizeof(bytes);++i){if(i==4||i==6||i==8||i==10)out+='-';out+=hex[bytes[i]>>4];out+=hex[bytes[i]&15];}
    return out;
  }
  void Begin(int64_t wall_ms,bool resuming){
    if(candidate_.empty())candidate_=Owner();
    const auto begin=history_.BeginSourceWriterEpoch(candidate_,SourceWriterBootstrap::Denied,resuming?wall_ms:0);
    if(!begin.durable)throw std::runtime_error("source_writer_begin_unconfirmed");
    owner_=candidate_;candidate_.clear();started_=true;begin_reason_=begin.reason;
  }
  HistoryMongo& history_;std::shared_ptr<SourceAdmission> admission_;std::set<std::string> channels_;Report report_;
  std::string owner_,candidate_;bool started_=false,resume_required_=false,reported_=false;
  SourceWriterReason begin_reason_=SourceWriterReason::PreviousUnclean;
  std::optional<RuntimeIngestionGate> gate_;Json pending_report_;
};
}  // namespace ainvr::search
