// Real owned Mongo control-document/failure/restart checks. No hardware/PG.
#include "history_mongo.hpp"
#include <mongoc/mongoc.h>
#include <atomic>
#include <chrono>
#include <iostream>
#include <thread>
#include <unistd.h>
using namespace ainvr::search;using Json=nlohmann::json;
namespace {
int checks=0;void Check(bool ok,const char*why){++checks;if(!ok)throw std::runtime_error(why);}
template<class F>void Reject(F action){bool failed=false;try{action();}catch(...){failed=true;}Check(failed,"unknown_or_invalid_write_reported_success");}
std::string Id(int n){char out[37];snprintf(out,sizeof(out),"10000000-0000-4000-8000-%012d",n);return out;}
int64_t Now(){return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();}
Sample Make(int n){
  const auto at=Now();const auto channel=Id(900);
  return {{Id(n),channel,"processor","session","track"+std::to_string(n),"pair-v1",at,false,{1.f,0.f}},
    {{"role","match"},{"input_path","/live/input"},{"output_path","/live/output"},
     {"source_input_id",channel},{"output_channel_id",channel},{"recording_channel_id",channel},
     {"schema_version","1.0"},{"stream_session_id","session"},{"source_pts_ns",std::to_string(at*1000000LL)},
     {"source_frame_index",std::to_string(n)},{"frame_id",Id(n)},{"frame_width",1920},{"frame_height",1080}},
    {255,216,255,217},at+60000};
}
constexpr const char* uri="mongodb://127.0.0.1:25440/?serverSelectionTimeoutMS=1000&retryWrites=false";
Json Command(mongoc_client_t*client,const std::string&db,const nlohmann::ordered_json&json){
  bson_error_t error{};const auto text=json.dump();auto command=bson_new_from_json(reinterpret_cast<const uint8_t*>(text.data()),-1,&error);
  Check(command,"fixture_command_parse");bson_t reply;const bool ok=mongoc_client_command_simple(client,db.c_str(),command,nullptr,&reply,&error);bson_destroy(command);
  char*raw=bson_as_relaxed_extended_json(&reply,nullptr);const auto result=raw?Json::parse(raw):Json();bson_free(raw);bson_destroy(&reply);
  if(!ok)throw std::runtime_error("fixture_mongo_command_failed");
  return result;
}
Json Marker(mongoc_client_t*c,const std::string&db){
  const auto rows=Command(c,db,{{"find","search_control"},{"filter",{{"_id","source_writer_epoch"}}},{"limit",2}}).at("cursor").at("firstBatch");
  Check(rows.size()<=1,"marker_not_singleton");return rows.empty()?Json():rows.at(0);
}
int Fail(mongoc_client_t*c,Json data){
  const auto reply=Command(c,"admin",{{"configureFailPoint","failCommand"},{"mode",{{"times",1}}},{"data",std::move(data)}});
  return reply.at("count").get<int>();
}
}
int main(){
  if(!std::getenv("AINVR_SEARCH_TEST_MONGO")||!std::getenv("AINVR_SEARCH_TEST_WRITER_RESTART"))return 77;
  try{
    mongoc_init();auto client=mongoc_client_new(uri);Check(client,"fixture_client");
    const auto prefix="ainvr_source_writer_"+std::to_string(getpid());std::vector<std::string> databases;
    const auto db=[&](const char*s){const auto value=prefix+"_"+s;databases.push_back(value);return value;};
    const auto cleanup=[&]{for(const auto&name:databases)(void)Command(client,name,{{"dropDatabase",1}});mongoc_client_destroy(client);};
    try{
      const auto legacy_db=db("legacy");HistoryMongo legacy(uri,legacy_db);legacy.Initialize();
      const auto actual=legacy.ReadSourceWriterTopology();Check(actual.standalone_verified&&actual.process_id.size()==24,"actual_standalone_hello_not_verified");
      Check(!legacy.ReadSourceWriterEpoch(),"new_namespace_marker_existed");
      const auto conservative=legacy.BeginSourceWriterEpoch(Id(1));
      Check(conservative.durable&&!conservative.migration_safe&&conservative.epoch.dirty&&conservative.reason==SourceWriterReason::LegacyBootstrapRequired,
        "legacy_absent_marker_was_assumed_clean");
      Check(!legacy.CleanSourceWriterEpoch(Id(1),true).durable,"legacy_marker_cleared_without_authority");
      Check(!legacy.BeginSourceWriterEpoch(Id(2),SourceWriterBootstrap::FreshNamespaceAuthority).migration_safe,"fresh_claim_erased_existing_poison");
      const auto clean_db=db("clean");HistoryMongo clean(uri,clean_db);clean.Initialize();
      auto known=clean.BeginSourceWriterEpoch(Id(10),SourceWriterBootstrap::FreshNamespaceAuthority);
      Check(known.durable&&known.migration_safe&&known.epoch.dirty,"explicit_fixture_fresh_bootstrap_failed");
      const auto first=Marker(client,clean_db);Check(first.dump().size()<4096&&!first.contains("expires_at"),"marker_budget_or_TTL_violation");
      known=clean.BeginSourceWriterEpoch(Id(10));const auto confirmed=Marker(client,clean_db);
      Check(known.durable&&known.migration_safe&&first.at("mutation_nonce")!=confirmed.at("mutation_nonce"),"recovery_used_read_or_noop_as_durability_proof");
      const auto inflight=clean.CleanSourceWriterEpoch(Id(10));Check(!inflight.durable&&inflight.reason==SourceWriterReason::CallsActive,"undrained_writer_cleaned");
      Check(Marker(client,clean_db)==confirmed,"rejected_clean_mutated_marker");
      const auto closed=clean.CleanSourceWriterEpoch(Id(10),true);Check(closed.durable&&closed.migration_safe&&!closed.epoch.dirty,"drained_known_writer_not_cleaned");
      const auto closed_doc=Marker(client,clean_db);Check(clean.CleanSourceWriterEpoch(Id(10),true).durable&&Marker(client,clean_db).at("mutation_nonce")!=closed_doc.at("mutation_nonce"),"clean_ACK_recovery_was_noop");
      Reject([&]{clean.BeginSourceWriterEpoch(Id(10));});
      Check(clean.BeginSourceWriterEpoch(Id(11)).migration_safe,"clean_previous_owner_not_reusable_by_new_owner");
      clean.DeleteRange(Id(90),0,1000);Check(clean.ReadSourceWriterEpoch().has_value(),"history_delete_removed_control_marker");
      Check(clean.Usage().at("samples")==0,"marker_created_history_samples");
      const auto insert_db=db("insert_unknown");HistoryMongo unknown_insert(uri,insert_db);unknown_insert.Initialize();
      Fail(client,{{"failCommands",{"insert"}},{"closeConnection",true}});
      Reject([&]{unknown_insert.BeginSourceWriterEpoch(Id(20),SourceWriterBootstrap::FreshNamespaceAuthority);});
      Check(!unknown_insert.CleanSourceWriterEpoch(Id(20),true).durable,"unknown_Begin_opened_durability");
      Check(unknown_insert.BeginSourceWriterEpoch(Id(20),SourceWriterBootstrap::FreshNamespaceAuthority).durable,"explicit_Begin_recovery_failed");
      const auto wc_db=db("write_concern");HistoryMongo write_concern(uri,wc_db);write_concern.Initialize();
      Check(write_concern.BeginSourceWriterEpoch(Id(30),SourceWriterBootstrap::FreshNamespaceAuthority).durable,"wc_setup");
      Fail(client,{{"failCommands",{"update"}},{"writeConcernError",{{"code",64},{"errmsg","owned fixture write concern unknown"}}}});
      Reject([&]{write_concern.BeginSourceWriterEpoch(Id(30));});
      const auto visible=Marker(client,wc_db);Check(!visible.is_null(),"wc_unknown_not_visible_for_receipt_test");
      Check(!write_concern.CleanSourceWriterEpoch(Id(30),true).durable,"visible_marker_mistaken_for_durable_Begin");
      const auto wc_recovered=write_concern.BeginSourceWriterEpoch(Id(30));
      Check(wc_recovered.durable&&wc_recovered.migration_safe&&Marker(client,wc_db).at("mutation_nonce")!=visible.at("mutation_nonce"),"wc_unknown_not_resolved_by_real_journalled_CAS");
      const auto poison_db=db("poison");HistoryMongo poisoned(uri,poison_db);poisoned.Initialize();
      Check(poisoned.BeginSourceWriterEpoch(Id(40),SourceWriterBootstrap::FreshNamespaceAuthority).durable,"poison_setup");
      Fail(client,{{"failCommands",{"update"}},{"closeConnection",true}});
      Reject([&]{poisoned.MarkSourceWriterUnknown(Id(40));});
      Check(poisoned.ReadSourceWriterEpoch()->uncertainty==false,"closeConnection_fixture_unexpectedly_committed");
      const auto memory_poison=poisoned.CleanSourceWriterEpoch(Id(40),true);
      Check(!memory_poison.durable&&memory_poison.reason==SourceWriterReason::UnknownWrite,"failed_persistence_forgot_memory_Unknown");
      Check(!poisoned.BeginSourceWriterEpoch(Id(40)).migration_safe&&poisoned.ReadSourceWriterEpoch()->uncertainty,"same_owner_retry_erased_Unknown");
      HistoryMongo replacement(uri,poison_db);replacement.Initialize();
      const auto inherited=replacement.BeginSourceWriterEpoch(Id(41));Check(inherited.durable&&!inherited.migration_safe&&inherited.epoch.previous_unclean,"reopen_forgot_dirty_previous_writer");
      const auto replacement_doc=Marker(client,poison_db);
      Check(!poisoned.MarkSourceWriterUnknown(Id(40))&&poisoned.CleanSourceWriterEpoch(Id(40),true).reason==SourceWriterReason::OwnerChanged,"late_old_owner_changed_current_owner");
      Check(Marker(client,poison_db)==replacement_doc,"late_old_marker_mutated_new_owner");
      HistoryMongo same_owner_new_object(uri,poison_db);same_owner_new_object.Initialize();
      Check(!same_owner_new_object.BeginSourceWriterEpoch(Id(41)).migration_safe,"reconstructed_same_UUID_forgot_local_Unknown");
      const auto race_db=db("late_clean");HistoryMongo old_owner(uri,race_db),new_owner(uri,race_db);old_owner.Initialize();new_owner.Initialize();
      Check(old_owner.BeginSourceWriterEpoch(Id(50),SourceWriterBootstrap::FreshNamespaceAuthority).migration_safe,"race_setup");
      const int entered=Fail(client,{{"failCommands",{"update"}},{"blockConnection",true},{"blockTimeMS",1500}});
      std::atomic<bool> late_failed{false};std::thread late([&]{try{old_owner.CleanSourceWriterEpoch(Id(50),true);}catch(...){late_failed=true;}});
      try{
        (void)Command(client,"admin",{{"waitForFailPoint","failCommand"},{"timesEntered",entered+1},{"maxTimeMS",2000}});
        const auto newer=new_owner.BeginSourceWriterEpoch(Id(51));Check(newer.durable&&!newer.migration_safe,"new_owner_did_not_inherit_inflight_old_epoch");
      }catch(...){late.join();throw;}late.join();
      Check(late_failed&&old_owner.ReadSourceWriterEpoch()->owner_uuid==Id(51),"late_clean_CAS_overwrote_new_owner");
      Check(!new_owner.CleanSourceWriterEpoch(Id(51),true).durable,"late_clean_lost_inherited_poison");
      // Real standalone process restart, inside this runner's private tmpfs
      // container. PID1 supervisor preserves Mongo files but replaces mongod.
      const auto before_restart=replacement.ReadSourceWriterTopology();
      try{(void)Command(client,"admin",{{"shutdown",1},{"force",true},{"timeoutSecs",1}});}catch(...){/* server closes the test socket */}
      SourceWriterTopology restarted;const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(20);
      while(std::chrono::steady_clock::now()<deadline){try{restarted=replacement.ReadSourceWriterTopology();if(restarted.standalone_verified&&restarted.process_id!=before_restart.process_id)break;}catch(...){}
        std::this_thread::sleep_for(std::chrono::milliseconds(100));}
      Check(restarted.standalone_verified&&restarted.process_id!=before_restart.process_id&&restarted.connection_identity==before_restart.connection_identity,"owned_standalone_process_did_not_restart");
      Check(replacement.ReadSourceWriterEpoch()->previous_unclean,"restart_did_not_retain_control_document");
      const auto after_restart=replacement.BeginSourceWriterEpoch(Id(42));
      Check(after_restart.durable&&after_restart.migration_safe&&!after_restart.epoch.previous_unclean,"confirmed_standalone_restart_did_not_discharge_old_operations");
      Check(replacement.CleanSourceWriterEpoch(Id(42),true).durable,"restarted_writer_could_not_clean");
      // Exercise actual source submission, not only the explicit marker API.
      // A clean fence cannot accept a late producer, and dispatched failures
      // must poison migration even when a read later finds a committed sample.
      const auto source_db=db("actual_source");HistoryMongo source(uri,source_db);source.Initialize();
      Check(source.BeginSourceWriterEpoch(Id(70),SourceWriterBootstrap::FreshNamespaceAuthority).migration_safe,"source_setup");
      const auto first_source=Make(701);source.Put(first_source);
      Check(source.Get(first_source.record.id).has_value(),"acknowledged_source_not_stored");
      auto invalid_source=Make(702);invalid_source.jpeg.clear();Reject([&]{source.Put(invalid_source);});
      Check(source.CleanSourceWriterEpoch(Id(70),true).durable,"validation_rejection_poisoned_writer");
      Reject([&]{source.Put(Make(703));});
      Check(!source.Get(Id(703)),"clean_epoch_accepted_late_source");
      const auto resume_at=Now();
      Check(source.BeginSourceWriterEpoch(Id(71),SourceWriterBootstrap::Denied,resume_at).migration_safe,"explicit_source_resume_failed");
      auto replay=Make(705);replay.record.captured_ms=resume_at-1;
      Reject([&]{source.Put(replay);});
      Check(!source.Get(replay.record.id),"old_source_frame_replayed_after_resume");
      Check(source.ReadSourceWriterEpoch()->resume_after_ms==resume_at,"resume_boundary_not_persisted");
      Fail(client,{{"failCommands",{"insert"}},{"writeConcernError",{{"code",64},{"errmsg","owned source WC unknown"}}}});
      const auto uncertain_source=Make(704);Reject([&]{source.Put(uncertain_source);});
      const auto poisoned_source=source.CleanSourceWriterEpoch(Id(71),true);
      Check(!poisoned_source.durable&&poisoned_source.reason==SourceWriterReason::UnknownWrite,"actual_source_WC_unknown_cleaned");
      Check(source.ReadSourceWriterEpoch()->uncertainty,"actual_source_unknown_not_persisted");
      Check(source.Get(uncertain_source.record.id).has_value(),"WC_fixture_did_not_commit_source_before_lost_ack");
      Check(!source.CleanSourceWriterEpoch(Id(71),true).durable,"source_receipt_read_cleared_uncertainty");
      const auto socket_db=db("actual_socket");HistoryMongo socket_source(uri,socket_db);socket_source.Initialize();
      Check(socket_source.BeginSourceWriterEpoch(Id(80),SourceWriterBootstrap::FreshNamespaceAuthority).migration_safe,"socket_source_setup");
      Fail(client,{{"failCommands",{"insert"}},{"closeConnection",true}});
      Reject([&]{socket_source.Put(Make(801));});
      Check(!socket_source.CleanSourceWriterEpoch(Id(80),true).durable&&socket_source.ReadSourceWriterEpoch()->uncertainty,
        "actual_source_socket_unknown_cleaned");
      const auto clean_unknown_db=db("clean_WC_unknown");HistoryMongo clean_unknown(uri,clean_unknown_db);clean_unknown.Initialize();
      Check(clean_unknown.BeginSourceWriterEpoch(Id(81),SourceWriterBootstrap::FreshNamespaceAuthority).migration_safe,"unknown_clean_setup");
      Fail(client,{{"failCommands",{"update"}},{"writeConcernError",{{"code",64},{"errmsg","owned Clean WC unknown"}}}});
      Reject([&]{clean_unknown.CleanSourceWriterEpoch(Id(81),true);});
      Reject([&]{clean_unknown.Put(Make(811));});
      Check(!clean_unknown.Get(Id(811)),"unknown_Clean_accepted_late_source");
      Check(clean_unknown.CleanSourceWriterEpoch(Id(81),true).durable,"unknown_Clean_retry_failed");
      Check(clean_unknown.BeginSourceWriterEpoch(Id(82),SourceWriterBootstrap::Denied,resume_at).migration_safe,"unknown_Clean_resume_failed");
      clean_unknown.Put(Make(812));
      Check(clean_unknown.CleanSourceWriterEpoch(Id(82),true).durable,"resume_writer_not_cleanable");
      Check(clean_unknown.BeginSourceWriterEpoch(Id(83)).epoch.resume_after_ms==resume_at,"new_epoch_decreased_persistent_resume_boundary");
      const auto target_db=db("target_isolation");HistoryMongo target_history(uri,target_db);target_history.Initialize();
      Check(target_history.BeginSourceWriterEpoch(Id(84),SourceWriterBootstrap::FreshNamespaceAuthority).migration_safe,"target_isolation_setup");
      const auto original=Make(841);target_history.Put(original);
      const auto retained=target_history.Get(original.record.id);Check(retained.has_value(),"target_source_not_retained");
      const Scope source_scope{{original.record.channel},original.record.captured_ms-1,original.record.captured_ms+1,20};
      const auto source_row=target_history.ReadReencodeSource(original.record.id,retained->fingerprint,original.record.model,source_scope);
      Check(source_row.has_value(),"target_source_metadata_missing");
      Check(target_history.CleanSourceWriterEpoch(Id(84),true).durable,"target_isolation_clean_setup");
      auto derivative=source_row->sample;derivative.record.id=Id(842);derivative.record.model="pair-v2";
      derivative.record.vector={1.f,0.f}; // Explicit software oracle for the NEW target, not an old-space vector.
      Fail(client,{{"failCommands",{"insert"}},{"writeConcernError",{{"code",64},{"errmsg","owned target WC unknown"}}}});
      bool target_wc_unknown=false;
      try{target_history.WriteReencodedSample(derivative,*source_row);}catch(const std::runtime_error& error){
        target_wc_unknown=std::string(error.what())=="search_history_error_16_64";
      }
      Check(target_wc_unknown,"target_fixture_did_not_reach_WC_failure");
      Check(target_history.Get(derivative.record.id).has_value(),"target_WC_fixture_did_not_commit_before_unknown_ack");
      Check(!target_history.ReadSourceWriterEpoch()->uncertainty&&target_history.CleanSourceWriterEpoch(Id(84),true).durable,
        "target_unknown_poisoned_source_epoch");
      Reject([&]{target_history.Put(Make(843));});
      Check(!target_history.Get(Id(843)),"target_failure_reopened_source_writer");
      std::cerr<<"source-writer phase: slot WC setup\n";
      const auto slot_db=db("slot_WC_unknown");HistoryMongo slot_history(uri,slot_db);slot_history.Initialize();
      Check(slot_history.BeginSourceWriterEpoch(Id(85),SourceWriterBootstrap::FreshNamespaceAuthority).migration_safe,"slot_setup");
      const auto slot_first=Make(851);const auto slot_fp=slot_history.ReplaceTrackSlot(slot_first,0,"","first");
      auto slot_next=slot_first;slot_next.record.captured_ms+=1;slot_next.evidence["frame_id"]=Id(852);
      slot_next.evidence["source_frame_index"]="852";
      slot_next.evidence["source_pts_ns"]=std::to_string(slot_next.record.captured_ms*1000000LL);
      Fail(client,{{"failCommands",{"update"}},{"writeConcernError",{{"code",64},{"errmsg","owned slot WC unknown"}}}});
      Reject([&]{slot_history.ReplaceTrackSlot(slot_next,0,slot_fp,"second");});
      std::cerr<<"source-writer phase: slot WC rejected\n";
      Check(slot_history.Get(slot_first.record.id)->fingerprint!=slot_fp,"slot_WC_fixture_did_not_commit_before_unknown_ack");
      Check(!slot_history.CleanSourceWriterEpoch(Id(85),true).durable&&slot_history.ReadSourceWriterEpoch()->uncertainty,
        "slot_WC_unknown_not_poisoned");
      std::cerr<<"source-writer phase: slot socket setup\n";
      const auto slot_socket_db=db("slot_socket_unknown");HistoryMongo slot_socket(uri,slot_socket_db);slot_socket.Initialize();
      Check(slot_socket.BeginSourceWriterEpoch(Id(86),SourceWriterBootstrap::FreshNamespaceAuthority).migration_safe,"slot_socket_setup");
      const auto socket_fp=slot_socket.ReplaceTrackSlot(slot_first,0,"","first");
      Fail(client,{{"failCommands",{"update"}},{"closeConnection",true}});
      Reject([&]{slot_socket.ReplaceTrackSlot(slot_next,0,socket_fp,"second");});
      std::cerr<<"source-writer phase: slot socket rejected\n";
      Check(!slot_socket.CleanSourceWriterEpoch(Id(86),true).durable&&slot_socket.ReadSourceWriterEpoch()->uncertainty,
        "slot_socket_unknown_not_poisoned");
      const auto corrupt_db=db("corrupt");HistoryMongo corrupt(uri,corrupt_db);corrupt.Initialize();
      (void)Command(client,corrupt_db,{{"insert","search_control"},{"documents",Json::array({{{"_id","source_writer_epoch"},{"padding",std::string(5000,'x')}}})}});
      Reject([&]{corrupt.ReadSourceWriterEpoch();});Reject([&]{corrupt.BeginSourceWriterEpoch(Id(60),SourceWriterBootstrap::FreshNamespaceAuthority);});
      Check(Marker(client,corrupt_db).at("padding").get<std::string>().size()==5000,"malformed_marker_overwritten_as_fresh");
    }catch(...){cleanup();throw;}cleanup();
    std::cout<<checks<<" real Mongo writer-marker checks passed, including writeConcern Unknown, failed poison CAS, late owner CAS and actual standalone process restart; no PG/BPU/production\n";
  }catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}
}
