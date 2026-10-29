// Pure policy for the one bounded search_control source-writer epoch document.
// No database operation or process/admission authority is created by this type.
// Every Begin/recovery/clean still needs a genuinely state-changing, exact-CAS
// acknowledged w:1+j:true before opening admission or sending pause ACK. An
// exact read or a no-op update is not a durability proof after an unknown write.
#pragma once
#include <cstdint>
#include <optional>
#include <regex>
#include <stdexcept>
#include <string>
namespace ainvr::search {
struct SourceWriterTopology {
  std::string connection_identity,process_id;
  bool standalone_verified=false;
};
struct SourceWriterEpoch {
  std::string owner_uuid;
  bool dirty=true,previous_unclean=false,uncertainty=false;
  SourceWriterTopology topology;
  // A controller-established resume boundary survives process/generation
  // reconstruction. Old queued frames never become new-space evidence.
  int64_t resume_after_ms=0;
};
enum class SourceWriterBootstrap { Denied, FreshNamespaceAuthority };
enum class SourceWriterReason { None, LegacyBootstrapRequired, PreviousUnclean, UnknownWrite, OwnerChanged, TopologyUnverified, CallsActive };
struct SourceWriterPlan {
  SourceWriterEpoch next;
  bool migration_safe=false,idempotent_owner=false;
  SourceWriterReason reason=SourceWriterReason::None;
};
inline bool ValidSourceWriterTopology(const SourceWriterTopology&t){
  if(!std::regex_match(t.connection_identity,std::regex("[a-f0-9]{64}")))return false;
  // Unknown/external topologies never acquire standalone restart authority.
  return t.standalone_verified?std::regex_match(t.process_id,std::regex("[a-f0-9]{24}")):t.process_id.empty();
}
inline bool ValidSourceWriterOwner(const std::string&s){return std::regex_match(s,std::regex("[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"));}
inline SourceWriterPlan PlanSourceWriterEpoch(const std::optional<SourceWriterEpoch>&previous,
    const std::string&owner,const SourceWriterTopology&topology,SourceWriterBootstrap bootstrap){
  if(!ValidSourceWriterOwner(owner)||!ValidSourceWriterTopology(topology)||
      (previous&&(!ValidSourceWriterOwner(previous->owner_uuid)||!ValidSourceWriterTopology(previous->topology))))
    throw std::invalid_argument("invalid_source_writer_epoch");
  SourceWriterPlan result;result.next={owner,true,false,false,topology};
  if(previous&&previous->owner_uuid==owner){
    // Lost marker ACK: reconcile this exact owner, never manufacture a fresh
    // ownership decision or silently reopen an already closed writer epoch.
    result.next=*previous;result.idempotent_owner=true;
    result.migration_safe=!previous->previous_unclean&&!previous->uncertainty;
    result.reason=result.migration_safe?SourceWriterReason::None:SourceWriterReason::PreviousUnclean;
    if(!topology.standalone_verified){result.migration_safe=false;result.reason=SourceWriterReason::TopologyUnverified;}
    return result;
  }
  bool poisoned=false;
  if(!previous){
    poisoned=bootstrap!=SourceWriterBootstrap::FreshNamespaceAuthority;
    if(poisoned)result.reason=SourceWriterReason::LegacyBootstrapRequired;
  }else{
    poisoned=previous->dirty||previous->previous_unclean||previous->uncertainty;
    const bool terminated=poisoned&&previous->topology.standalone_verified&&topology.standalone_verified&&
      previous->topology.connection_identity==topology.connection_identity&&previous->topology.process_id!=topology.process_id;
    if(terminated)poisoned=false;
    if(poisoned)result.reason=SourceWriterReason::PreviousUnclean;
  }
  result.next.previous_unclean=poisoned;result.migration_safe=!poisoned;
  if(!topology.standalone_verified){result.migration_safe=false;result.reason=SourceWriterReason::TopologyUnverified;}
  return result;
}
inline SourceWriterReason SourceWriterCleanReason(const SourceWriterEpoch&epoch,const std::string&owner,
    bool known_calls_drained,bool local_unknown_write){
  if(!ValidSourceWriterOwner(owner)||epoch.owner_uuid!=owner)return SourceWriterReason::OwnerChanged;
  if(!epoch.topology.standalone_verified)return SourceWriterReason::TopologyUnverified;
  if(local_unknown_write||epoch.uncertainty)return SourceWriterReason::UnknownWrite;
  if(epoch.previous_unclean)return SourceWriterReason::PreviousUnclean;
  if(!known_calls_drained)return SourceWriterReason::CallsActive;
  return SourceWriterReason::None;
}
inline const char* SourceWriterReasonCode(SourceWriterReason reason){
  switch(reason){
    case SourceWriterReason::None:return "source_writer_clean";
    case SourceWriterReason::LegacyBootstrapRequired:return "legacy_bootstrap_required";
    case SourceWriterReason::PreviousUnclean:return "source_writer_previous_unclean";
    case SourceWriterReason::UnknownWrite:return "source_writer_uncertain";
    case SourceWriterReason::OwnerChanged:return "source_writer_owner_changed";
    case SourceWriterReason::TopologyUnverified:return "source_writer_topology_unverified";
    case SourceWriterReason::CallsActive:return "source_writer_inflight";
  }
  return "source_writer_uncertain";
}
}  // namespace ainvr::search
