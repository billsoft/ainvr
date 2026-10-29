// Policy only: all marker/topology/bootstrap values are synthetic fixtures.
#include "source_writer_epoch.hpp"
#include <iostream>
using namespace ainvr::search;
namespace {int checks=0;void Check(bool v){++checks;if(!v)throw std::runtime_error("writer_epoch_policy");}}
int main(){try{
  const std::string first="10000000-0000-4000-8000-000000000001",second="10000000-0000-4000-8000-000000000002";
  const SourceWriterTopology standalone{std::string(64,'a'),std::string(24,'b'),true};
  auto p=PlanSourceWriterEpoch(std::nullopt,first,standalone,SourceWriterBootstrap::Denied);
  Check(!p.migration_safe&&p.next.dirty&&p.next.previous_unclean&&p.reason==SourceWriterReason::LegacyBootstrapRequired);
  p=PlanSourceWriterEpoch(std::nullopt,first,standalone,SourceWriterBootstrap::FreshNamespaceAuthority);
  Check(p.migration_safe&&p.next.dirty&&!p.next.previous_unclean);
  Check(SourceWriterCleanReason(p.next,first,false,false)!=SourceWriterReason::None);
  Check(SourceWriterCleanReason(p.next,first,true,true)==SourceWriterReason::UnknownWrite);
  Check(SourceWriterCleanReason(p.next,second,true,false)==SourceWriterReason::OwnerChanged);
  Check(SourceWriterCleanReason(p.next,first,true,false)==SourceWriterReason::None);
  auto closed=p.next;closed.dirty=false;
  Check(PlanSourceWriterEpoch(closed,second,standalone,SourceWriterBootstrap::Denied).migration_safe);
  auto crash=p.next;
  Check(!PlanSourceWriterEpoch(crash,second,standalone,SourceWriterBootstrap::FreshNamespaceAuthority).migration_safe);
  auto restarted=standalone;restarted.process_id=std::string(24,'c');
  Check(PlanSourceWriterEpoch(crash,second,restarted,SourceWriterBootstrap::Denied).migration_safe);
  auto changed_endpoint=restarted;changed_endpoint.connection_identity=std::string(64,'d');
  Check(!PlanSourceWriterEpoch(crash,second,changed_endpoint,SourceWriterBootstrap::Denied).migration_safe);
  const SourceWriterTopology replica{std::string(64,'a'),"",false};
  Check(!PlanSourceWriterEpoch(crash,second,replica,SourceWriterBootstrap::Denied).migration_safe);
  crash.topology=replica;Check(!PlanSourceWriterEpoch(crash,second,restarted,SourceWriterBootstrap::Denied).migration_safe);
  const auto retry=PlanSourceWriterEpoch(closed,first,restarted,SourceWriterBootstrap::FreshNamespaceAuthority);
  Check(retry.idempotent_owner&&!retry.next.dirty&&retry.next.topology.process_id==standalone.process_id);
  crash=closed;crash.previous_unclean=true;
  Check(SourceWriterCleanReason(crash,first,true,false)==SourceWriterReason::PreviousUnclean);
  bool rejected=false;try{auto fake=replica;fake.process_id=std::string(24,'b');PlanSourceWriterEpoch(std::nullopt,first,fake,SourceWriterBootstrap::Denied);}catch(...){rejected=true;}Check(rejected);
  const auto fresh_external=PlanSourceWriterEpoch(std::nullopt,first,replica,SourceWriterBootstrap::FreshNamespaceAuthority);
  Check(!fresh_external.migration_safe&&fresh_external.reason==SourceWriterReason::TopologyUnverified);
  closed.topology=replica;Check(SourceWriterCleanReason(closed,first,true,false)==SourceWriterReason::TopologyUnverified);
  std::cout<<checks<<" writer-epoch pure policy checks passed; no Mongo persistence or hardware claimed\n";
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
