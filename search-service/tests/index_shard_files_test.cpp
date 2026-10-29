#include "index_shard_files.hpp"
#include <nlohmann/json.hpp>
#include <openssl/evp.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <limits>
#include <sstream>

using namespace ainvr::search;
using Json = nlohmann::json;
namespace fs = std::filesystem;
namespace {
size_t cases = 0;
void Check(bool value,const char* message) { if (!value) throw std::runtime_error(message); }
void Reject(const std::function<void()>& fn) {
  try { fn(); } catch (const std::exception&) { ++cases; return; }
  throw std::runtime_error("unsafe_shard_operation_accepted");
}
struct Temp {
  fs::path base, root;
  Temp() {
    char name[] = "/tmp/ainvr-shard-files-XXXXXX"; auto* created = mkdtemp(name);
    Check(created != nullptr,"temporary_directory_failed"); base = created; root = base/"index";
    Check(mkdir(root.c_str(),0700) == 0,"private_directory_failed");
  }
  ~Temp() { std::error_code error; fs::remove_all(base,error); }
};
std::string Read(const fs::path& path) { std::ifstream file(path,std::ios::binary); Check(bool(file),"fixture_missing"); return {std::istreambuf_iterator<char>(file),{}}; }
void Write(const fs::path& path,const std::string& text) { std::ofstream file(path,std::ios::binary|std::ios::trunc); file.write(text.data(),text.size()); Check(bool(file),"fixture_write_failed"); }
std::string Sha(const std::string& bytes) {
  unsigned char hash[EVP_MAX_MD_SIZE]; unsigned int length = 0;
  Check(EVP_Digest(bytes.data(),bytes.size(),hash,&length,EVP_sha256(),nullptr) == 1,"hash_failed");
  std::ostringstream out; out << std::hex << std::setfill('0');
  for (unsigned int i = 0; i < length; ++i) out << std::setw(2) << unsigned(hash[i]);
  return out.str();
}
IndexShardIdentity Identity(IndexShardFiles& store,uint64_t revision = 1) {
  return {"11111111-1111-4111-8111-111111111111",revision,"22222222-2222-4222-8222-222222222222",
    "search-v1-"+std::string(64,'a'),"1970-01-02",3,7,store.StorageGeneration()};
}
std::vector<Record> Records(const IndexShardIdentity& identity) {
  return {{"record-b",identity.channel_id,"processor","session","track-b",identity.model_version,86401000,false,{0,3,4},std::string(64,'b')},
          {"record-a",identity.channel_id,"processor","session","track-a",identity.model_version,86402000,false,{1,0,0},std::string(64,'a')}};
}
fs::path Manifest(const Temp& tmp,const IndexShardIdentity& id) { return tmp.root/id.id/(std::to_string(id.revision)+".manifest.json"); }
fs::path Data(const Temp& tmp,const IndexShardIdentity& id) { return tmp.root/id.id/(std::to_string(id.revision)+".records.f32le"); }
uint32_t U32(const std::string& bytes,size_t at) {
  uint32_t value = 0; for (size_t i = 0; i < 4; ++i) value |= uint32_t(static_cast<unsigned char>(bytes.at(at+i))) << (8*i); return value;
}
void Put32(std::string& bytes,size_t at,uint32_t value) { for (size_t i = 0; i < 4; ++i) bytes.at(at+i) = char((value>>(8*i))&255); }
void Rehash(const Temp& tmp,const IndexShardIdentity& id,ShardPublication& publication) {
  auto manifest = Json::parse(Read(Manifest(tmp,id))); const auto data = Read(Data(tmp,id));
  manifest["data"]["bytes"] = data.size(); manifest["data"]["sha256"] = Sha(data);
  const auto text = manifest.dump(); Write(Manifest(tmp,id),text);
  publication.manifest_sha256 = Sha(text); publication.byte_count = data.size()+text.size();
}
void RewriteRow(const Temp& tmp,const IndexShardIdentity& id,ShardPublication& publication,size_t row,const std::function<void(Json&)>& edit) {
  auto data = Read(Data(tmp,id)); size_t at = 24;
  for (size_t i = 0; i < row; ++i) at += 4+U32(data,at)+id.dimensions*4;
  const auto length = U32(data,at); auto metadata = Json::parse(data.substr(at+4,length)); edit(metadata);
  const auto changed = metadata.dump(); data.replace(at+4,length,changed); Put32(data,at,uint32_t(changed.size()));
  Write(Data(tmp,id),data); Rehash(tmp,id,publication);
}
void NoTemporary(const Temp& tmp) {
  for (const auto& entry : fs::recursive_directory_iterator(tmp.root))
    Check(entry.path().filename().string().rfind(".tmp-",0) != 0,"temporary_file_leaked");
}
}  // namespace
int main() {
  try {
    {
      Temp tmp; auto store = IndexShardFiles::OpenForTesting(tmp.root); auto id = Identity(*store); auto records = Records(id);
      const auto publication = store->Publish(id,records); ++cases;
      Check(publication.manifest_key == id.id+"/1.manifest.json","wrong_catalog_key");
      Check(publication.byte_count == fs::file_size(Data(tmp,id))+fs::file_size(Manifest(tmp,id)),"wrong_publication_bytes");
      auto loaded = store->Load(id,publication); Check(loaded.size() == 2 && loaded[0].id == "record-a","restart_order");
      const auto raw = Read(Data(tmp,id)); const auto vector_at = 28+U32(raw,24);
      Check(U32(raw,8) == 1 && U32(raw,12) == 3 && U32(raw,16) == 2 && U32(raw,vector_at) == 0x3f800000,"f32le_layout");
      VectorIndex baseline(id.model_version,3,10), restored(id.model_version,3,10);
      for (const auto& record : records) baseline.Upsert(record);
      for (const auto& record : loaded) restored.Upsert(record);
      Scope scope{{id.channel_id},86400000,172800000,10}; const auto a = baseline.Query({1,0,0},scope), b = restored.Query({1,0,0},scope);
      Check(a.size() == b.size(),"exact_baseline_size");
      for (size_t i = 0; i < a.size(); ++i) Check(a[i].id == b[i].id && a[i].fingerprint == b[i].fingerprint && std::abs(a[i].score-b[i].score)<1e-6,"exact_baseline_changed");
      ++cases;
      std::reverse(records.begin(),records.end()); const auto retry = store->Publish(id,records);
      Check(retry.manifest_sha256 == publication.manifest_sha256 && retry.byte_count == publication.byte_count,"retry_not_idempotent"); ++cases;
      records[0].vector = {0,1,0}; Reject([&] { store->Publish(id,records); });
      records = Records(id); auto newer = id; newer.revision = 2; auto next = store->Publish(newer,records);
      store->DeleteAuthorized(newer,next); store->DeleteAuthorized(newer,next); Check(store->Load(id,publication).size()==2,"old_generation_deleted"); ++cases;
      store.reset(); store = IndexShardFiles::OpenForTesting(tmp.root); Check(store->Load(id,publication).size()==2,"restart_restore_failed"); ++cases;
      for (const auto& mutate : std::vector<std::function<void(IndexShardIdentity&)>>{
        [](auto& x){ x.storage_generation = std::string(64,'f'); }, [](auto& x){ x.model_version="other-model"; },
        [](auto& x){ x.utc_day="1970-01-03"; }, [](auto& x){ x.dimensions=2; }, [](auto& x){ x.checkpoint=8; },
        [](auto& x){ x.channel_id="33333333-3333-4333-8333-333333333333"; }, [](auto& x){ x.id="../outside"; },
        [](auto& x){ x.revision=0; }, [](auto& x){ x.revision=9007199254740992ULL; }, [](auto& x){x.utc_day="2025-02-29";}}) {
        auto wrong = id; mutate(wrong); Reject([&] { store->Load(wrong,publication); });
      }
      auto wrong = publication; wrong.manifest_key = "../../outside"; Reject([&] { store->Load(id,wrong); });
      Reject([&] { store->DeleteAuthorized(id,wrong); });Check(store->Load(id,publication).size()==2,"wrong_key_deleted_index");++cases;
      Reject([&] { store->DiscardUnpublished(id); });
      auto orphan = id; orphan.revision=3; fs::copy_file(Data(tmp,id),Data(tmp,orphan));
      auto recovered = store->Publish(orphan,Records(id)); Check(store->Load(orphan,recovered).size()==2,"orphan_data_not_reused"); ++cases;
      auto cancelled=id; cancelled.revision=4; fs::copy_file(Data(tmp,id),Data(tmp,cancelled));
      store->DiscardUnpublished(cancelled); store->DiscardUnpublished(cancelled); Check(!fs::exists(Data(tmp,cancelled)),"orphan_not_removed"); ++cases;
      auto retired=id;retired.revision=5;const auto retired_publication=store->Publish(retired,Records(id));
      auto reference=retired;reference.dimensions=0;reference.checkpoint=0;
      Reject([&]{store->DeleteRetired(reference,"../outside");});Check(store->Load(retired,retired_publication).size()==2,"wrong retired key deleted files");
      auto other_volume=reference;other_volume.storage_generation=std::string(64,'f');
      Reject([&]{store->DeleteRetired(other_volume,retired_publication.manifest_key);});Check(store->Load(retired,retired_publication).size()==2,"wrong retired storage deleted files");
      store->DeleteRetired(reference,retired_publication.manifest_key);store->DeleteRetired(reference,retired_publication.manifest_key);
      Check(!fs::exists(Data(tmp,retired))&&!fs::exists(Manifest(tmp,retired))&&store->Load(id,publication).size()==2,"retired cleanup affected another revision");++cases;
      auto empty = id; empty.revision=6; const auto empty_publication=store->Publish(empty,{});
      Check(store->Load(empty,empty_publication).empty(),"empty_shard_restore_failed"); ++cases;
      auto interrupted = id; interrupted.revision=7; const auto deleting=store->Publish(interrupted,Records(id));
      fs::remove(Manifest(tmp,interrupted)); store->DeleteAuthorized(interrupted,deleting);
      Check(!fs::exists(Data(tmp,interrupted)),"interrupted_delete_not_completed"); ++cases;
      Write(tmp.root/id.id/(".tmp-5-data-"+std::string(16,'a')),"crashed-private-temporary");
      store.reset(); store=IndexShardFiles::OpenForTesting(tmp.root); NoTemporary(tmp); ++cases;
      fs::create_hard_link(Data(tmp,id),tmp.root/id.id/(".tmp-9-data-"+std::string(16,'b')));
      Check(store->Load(id,publication).size()==2,"rename_fallback_alias_not_recovered");NoTemporary(tmp);++cases;
      const int lock = open((tmp.root/".writer.lock").c_str(),O_RDWR|O_CLOEXEC); Check(lock>=0 && flock(lock,LOCK_EX|LOCK_NB)==0,"test_lock_failed");
      Reject([&] { store->Load(id,publication); }); close(lock); Check(store->Load(id,publication).size()==2,"io_lock_not_released"); ++cases;
      fs::rename(tmp.root/".writer.lock",tmp.root/".writer-replaced"); Write(tmp.root/".writer.lock","");
      Reject([&]{store->Load(id,publication);});fs::remove(tmp.root/".writer.lock");fs::rename(tmp.root/".writer-replaced",tmp.root/".writer.lock");
      Check(store->Load(id,publication).size()==2,"writer_identity_restore_failed"); ++cases;
      const auto owner=Read(tmp.root/".owner.json");auto foreign=Json::parse(owner);foreign["volume_id"]="other-volume";Write(tmp.root/".owner.json",foreign.dump());
      Reject([&]{store->Load(id,publication);});Write(tmp.root/".owner.json",owner);Check(store->Load(id,publication).size()==2,"owner_restore_failed");++cases;
      fs::rename(tmp.root,tmp.base/"detached"); Check(mkdir(tmp.root.c_str(),0700)==0,"replacement_root_failed");
      Write(tmp.root/"untouched","system-disk-sentinel"); Reject([&] { store->Publish(Identity(*store,9),Records(id)); });
      Check(Read(tmp.root/"untouched")=="system-disk-sentinel" && !fs::exists(tmp.root/".owner.json"),"rebound_root_was_written"); ++cases;
    }
    {
      // Even copied, byte-identical files cannot make an old catalog adopt a
      // different selected directory on the same filesystem.
      Temp previous, selected;
      auto old_store=IndexShardFiles::OpenForTesting(previous.root);
      auto old_id=Identity(*old_store);const auto old_publication=old_store->Publish(old_id,Records(old_id));
      auto current=IndexShardFiles::OpenForTesting(selected.root);
      Check(current->StorageGeneration()!=old_store->StorageGeneration(),"selected_directory_generation_unchanged");++cases;
      fs::copy(previous.root/old_id.id,selected.root/old_id.id,fs::copy_options::recursive);
      Reject([&]{current->Load(old_id,old_publication);});
      current.reset();current=IndexShardFiles::OpenForTesting(selected.root);
      Check(current->StorageGeneration()!=old_id.storage_generation,"directory_generation_not_stable");++cases;
      Reject([&]{current->Load(old_id,old_publication);});
    }
    for (const auto& mutation : std::vector<std::function<void(const Temp&,const IndexShardIdentity&,ShardPublication&)>>{
      [](const auto& t,const auto& id,auto&){ Write(Manifest(t,id),Read(Manifest(t,id))+" "); },
      [](const auto& t,const auto& id,auto&){ auto bytes=Read(Data(t,id));bytes.back()^=1;Write(Data(t,id),bytes); },
      [](const auto& t,const auto& id,auto& p){ RewriteRow(t,id,p,0,[](auto& j){j["captured_ms"]=0;}); },
      [](const auto& t,const auto& id,auto& p){ RewriteRow(t,id,p,0,[](auto& j){j["model"]="other-model";}); },
      [](const auto& t,const auto& id,auto& p){ RewriteRow(t,id,p,0,[](auto& j){j["fingerprint"]="bad";}); },
      [](const auto& t,const auto& id,auto& p){ RewriteRow(t,id,p,1,[](auto& j){j["id"]="record-a";}); },
      [](const auto& t,const auto& id,auto& p){auto data=Read(Data(t,id));Put32(data,28+U32(data,24),0x7fc00000);Write(Data(t,id),data);Rehash(t,id,p);},
      [](const auto& t,const auto& id,auto& p){auto data=Read(Data(t,id));Put32(data,24,0xffffffff);Write(Data(t,id),data);Rehash(t,id,p);},
      [](const auto& t,const auto& id,auto& p){auto j=Json::parse(Read(Manifest(t,id)));j["unexpected"]=true;auto text=j.dump();Write(Manifest(t,id),text);p.manifest_sha256=Sha(text);p.byte_count=fs::file_size(Data(t,id))+text.size();},
      [](const auto& t,const auto& id,auto& p){auto text=std::string("{\"schema_version\":1,")+Read(Manifest(t,id)).substr(1);Write(Manifest(t,id),text);p.manifest_sha256=Sha(text);p.byte_count=fs::file_size(Data(t,id))+text.size();},
    }) {
      Temp tmp; auto store=IndexShardFiles::OpenForTesting(tmp.root);auto id=Identity(*store);auto publication=store->Publish(id,Records(id));
      mutation(tmp,id,publication);Reject([&]{store->Load(id,publication);});
      // Represents a separate catalog-authorized hide/delete action; loading
      // corrupt derived bytes must fail while exact-key garbage remains reclaimable.
      store->DeleteAuthorized(id,publication);Check(!fs::exists(Manifest(tmp,id))&&!fs::exists(Data(tmp,id)),"corrupt_shard_not_reclaimable");++cases;
    }
    {
      Temp tmp; Temp outside; auto store=IndexShardFiles::OpenForTesting(tmp.root);auto id=Identity(*store);auto publication=store->Publish(id,Records(id));
      Write(outside.root/"protected","protected-original");fs::remove(Data(tmp,id));fs::create_symlink(outside.root/"protected",Data(tmp,id));
      Reject([&]{store->Load(id,publication);});Reject([&]{store->Publish(Identity(*store,2),Records(id));});
      Reject([&]{store->DeleteAuthorized(id,publication);});Check(fs::exists(Manifest(tmp,id)),"nonregular_cleanup_partially_deleted_manifest");
      Check(Read(outside.root/"protected")=="protected-original","symlink_target_modified"); ++cases;
    }
    {
      Temp tmp;auto store=IndexShardFiles::OpenForTesting(tmp.root);auto id=Identity(*store);auto publication=store->Publish(id,Records(id));
      fs::rename(tmp.root/id.id,tmp.root/"33333333-3333-4333-8333-333333333333");
      fs::create_directory_symlink(tmp.root/"33333333-3333-4333-8333-333333333333",tmp.root/id.id);
      Reject([&]{store->Load(id,publication);});
    }
    {
      Temp tmp;IndexShardFileLimits limits;limits.max_files=5;auto store=IndexShardFiles::OpenForTesting(tmp.root,limits);
      auto id=Identity(*store);auto publication=store->Publish(id,Records(id));Reject([&]{store->Publish(Identity(*store,2),Records(id));});
      Check(store->Load(id,publication).size()==2,"quota_damaged_old_publish");NoTemporary(tmp); ++cases;
    }
    for(int kind=0;kind<4;++kind) {
      Temp tmp;IndexShardFileLimits limits;
      if(kind==0)limits.max_records=1;
      if(kind==1)limits.max_shard_bytes=64;
      if(kind==2)limits.max_total_bytes=limits.max_shard_bytes=1024;
      if(kind==3)limits.max_temporary_bytes=1024;
      auto store=IndexShardFiles::OpenForTesting(tmp.root,limits);auto id=Identity(*store);
      Reject([&]{store->Publish(id,Records(id));});NoTemporary(tmp);
    }
    {
      Temp tmp;auto store=IndexShardFiles::OpenForTesting(tmp.root);auto id=Identity(*store);auto publication=store->Publish(id,Records(id));store.reset();
      IndexShardFileLimits smaller;smaller.max_records=1;smaller.max_shard_bytes=64;
      store=IndexShardFiles::OpenForTesting(tmp.root,smaller);Reject([&]{store->Load(id,publication);});
      store->DeleteAuthorized(id,publication);Check(!fs::exists(Manifest(tmp,id))&&!fs::exists(Data(tmp,id)),"quota_reduction_blocked_cleanup");++cases;
    }
    {
      Temp tmp;Reject([&]{IndexShardFiles::OpenProduction({"USB-id-is-not-a-fixed-UUID","child",(tmp.root/"child").string(),std::string(64,'a')});});
      Check(fs::is_empty(tmp.root),"production_fell_back_to_ordinary_directory"); ++cases;
      auto store=IndexShardFiles::OpenForTesting(tmp.root);auto id=Identity(*store);auto rows=Records(id);
      rows[0].fingerprint.clear();Reject([&]{store->Publish(id,rows);});rows=Records(id);rows.push_back(rows.front());Reject([&]{store->Publish(id,rows);});
      rows=Records(id);rows[0].vector={0,0,0};Reject([&]{store->Publish(id,rows);});
    }
    std::cout<<Json{{"software_cases",cases},{"production_ssd_accessed",false},{"bpu_tasks",0}}<<'\n';
  } catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
