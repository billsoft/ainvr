#include "model_migration_authorization.hpp"
#include <iostream>
using namespace ainvr::search;
using Json=nlohmann::json;
namespace {
int checks=0;
void Check(bool value){++checks;if(!value)throw std::runtime_error("migration grant contract failed");}
template<class F>void Reject(F operation){bool failed=false;try{operation();}catch(...){failed=true;}Check(failed);}
}
int main(){try{
  constexpr int64_t now=1800000000000LL;
  const std::string id="00000000-0000-4000-8000-000000000001",worker="00000000-0000-4000-8000-000000000002";
  const MigrationWriteProof proof{id,worker,"fixture-actor",std::string(64,'a'),2};
  const auto body=MigrationAuthorizationRequest(proof);
  Check(body.at("action")=="authorize_write"&&!body.contains("source"));
  MigrationSourceProof source{id,std::string(64,'b'),id,std::string(64,'c'),now-1000,3};
  Check(MigrationAuthorizationRequest(proof,source).at("source").at("ordinal")=="3");
  auto bad_source=source;bad_source.ordinal=0;Reject([&]{MigrationAuthorizationRequest(proof,bad_source);});
  bad_source=source;bad_source.fingerprint="bad";Reject([&]{MigrationAuthorizationRequest(proof,bad_source);});
  Json reply{{"grant",{{"job_id",id},{"worker",worker},{"generation",2},{"payload_fingerprint",std::string(64,'a')},
    {"source",{{"package_id","siglip-so400m-i18n-full-int8"},{"package_sha256",std::string(64,'b')},{"model_version","search-v1-"+std::string(64,'b')}}},
    {"target",{{"package_id","siglip2-base-full-int8"},{"package_sha256",std::string(64,'c')},{"model_version","search-v1-"+std::string(64,'c')}}},
    {"scope",{{"channel_ids",{id}},{"from_ms",now-5000},{"to_ms",now+1}}},
    {"source_high_watermark","9223372036854775807"},{"lease_until_ms",now+10000},
    {"job_expires_ms",now+60000},{"target_checkpoint","0"}}}};
  const auto first=ReadMigrationWriteGrant(reply,proof,now);Check(first&&first->source_high_watermark==INT64_MAX);
  Check(!ReadMigrationWriteGrant({{"grant",nullptr}},proof,now));
  auto changed=reply;changed["grant"]["lease_until_ms"]=now+999;Check(!ReadMigrationWriteGrant(changed,proof,now));
  for(const auto* key:{"job_id","worker","payload_fingerprint"}){
    changed=reply;changed["grant"][key]="broken";Reject([&]{ReadMigrationWriteGrant(changed,proof,now);});
  }
  changed=reply;changed["grant"]["generation"]=3;Reject([&]{ReadMigrationWriteGrant(changed,proof,now);});
  changed=reply;changed["grant"]["generation"]=2.5;Reject([&]{ReadMigrationWriteGrant(changed,proof,now);});
  changed=reply;changed["grant"]["lease_until_ms"]=std::to_string(now+10000);Reject([&]{ReadMigrationWriteGrant(changed,proof,now);});
  changed=reply;changed["grant"]["target"]["model_version"]="search-v1-"+std::string(64,'d');Reject([&]{ReadMigrationWriteGrant(changed,proof,now);});
  changed=reply;changed["grant"]["scope"]["channel_ids"].push_back(id);Reject([&]{ReadMigrationWriteGrant(changed,proof,now);});
  changed=reply;changed["grant"]["scope"]["to_ms"]=now-5000;Reject([&]{ReadMigrationWriteGrant(changed,proof,now);});
  changed=reply;changed["grant"]["scope"]["to_ms"]=now+32LL*86400000;Reject([&]{ReadMigrationWriteGrant(changed,proof,now);});
  for(const auto& ordinal:Json::array({"01","-1","9223372036854775808",3})){
    changed=reply;changed["grant"]["source_high_watermark"]=ordinal;Reject([&]{ReadMigrationWriteGrant(changed,proof,now);});
  }
  changed=reply;changed["grant"]["unexpected_path"]="/not-authorized";Reject([&]{ReadMigrationWriteGrant(changed,proof,now);});
  changed=reply;changed["grant"]["lease_until_ms"]=now+20000;auto renewed=ReadMigrationWriteGrant(changed,proof,now);Check(renewed&&SameMigrationWriteAuthority(*first,*renewed));
  changed["grant"]["source_high_watermark"]="3";renewed=ReadMigrationWriteGrant(changed,proof,now);Check(renewed&&!SameMigrationWriteAuthority(*first,*renewed));
  const MigrationReportReadProof read_proof{proof.job_id,proof.actor,proof.payload_fingerprint,proof.generation};
  auto read_reply=reply;auto& rg=read_reply["grant"];rg.erase("worker");rg.erase("lease_until_ms");rg["mode"]="report_read";rg["actor"]=proof.actor;
  Check(MigrationReportReadRequest(read_proof).at("action")=="authorize_report_read");
  const auto readonly=ReadMigrationReportReadGrant(read_reply,read_proof,now);Check(readonly&&readonly->source_high_watermark==first->source_high_watermark);
  Reject([&]{ReadMigrationWriteGrant(read_reply,proof,now);});
  Reject([&]{ReadMigrationReportReadGrant(reply,read_proof,now);});
  for(const auto& field:{"actor","job_id","payload_fingerprint","mode"}){auto bad=read_reply;bad["grant"][field]="wrong";Reject([&]{ReadMigrationReportReadGrant(bad,read_proof,now);});}
  auto expired=read_reply;expired["grant"]["job_expires_ms"]=now;Check(!ReadMigrationReportReadGrant(expired,read_proof,now));
  Check(!ReadMigrationReportReadGrant({{"grant",nullptr}},read_proof,now));
  std::cout<<"migration authorization: "<<checks<<" software checks passed; no PG, SDK or model load\n";
}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}}
