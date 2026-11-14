#include "index_shard_files.hpp"
#include "index_int8.hpp"
#include <nlohmann/json.hpp>
#include <cstring>
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
const std::string kRecordA = "aaaaaaaa-0000-4000-8000-000000000001", kRecordB = "bbbbbbbb-0000-4000-8000-000000000002";
std::vector<Record> Records(const IndexShardIdentity& identity) {
  return {{kRecordB,identity.channel_id,"processor","session","track-b",identity.model_version,86401000,false,{0,3,4},std::string(64,'b')},
          {kRecordA,identity.channel_id,"processor","session","track-a",identity.model_version,86402000,false,{1,0,0},std::string(64,'a')}};
}
fs::path Manifest(const Temp& tmp,const IndexShardIdentity& id) { return tmp.root/id.id/(std::to_string(id.revision)+".manifest.json"); }
fs::path Data(const Temp& tmp,const IndexShardIdentity& id) { return tmp.root/id.id/(std::to_string(id.revision)+".records.i8"); }
fs::path DataV1(const Temp& tmp,const IndexShardIdentity& id) { return tmp.root/id.id/(std::to_string(id.revision)+".records.f32le"); }
// v2 layout of the two 3-d fixture records: columns start at 64-byte boundaries.
constexpr size_t kScalesAt = 448, kCountAt = 24;
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
// Same-length edit of the stored metadata, rehashed so only the content checks can catch it.
void RewriteMeta(const Temp& tmp,const IndexShardIdentity& id,ShardPublication& publication,const std::string& from,const std::string& to) {
  auto data = Read(Data(tmp,id)); const auto at = data.rfind(from);
  Check(at != std::string::npos && from.size() == to.size(),"fixture_metadata_missing");
  data.replace(at,from.size(),to); Write(Data(tmp,id),data); Rehash(tmp,id,publication);
}
// A file in the previous float32 format, as the boards still hold it.
ShardPublication WriteV1(const Temp& tmp,const IndexShardIdentity& id,const std::vector<Record>& sorted,const std::string& volume) {
  std::string data = "AINVRSH1"; const auto u = [&](uint64_t v,size_t n){ for(size_t i=0;i<n;++i) data.push_back(char((v>>(8*i))&255)); };
  u(1,4); u(id.dimensions,4); u(sorted.size(),8);
  for (const auto& r : sorted) {
    const auto meta = Json{{"id",r.id},{"channel",r.channel},{"processor",r.processor},{"session",r.session},{"track",r.track},
      {"model",r.model},{"captured_ms",r.captured_ms},{"scene",r.scene},{"fingerprint",r.fingerprint}}.dump();
    u(meta.size(),4); data += meta;
    double norm = 0; for (float v : r.vector) norm += double(v)*v; norm = std::sqrt(norm);
    for (float v : r.vector) { const float x = float(v/norm); uint32_t bits; std::memcpy(&bits,&x,4); u(bits,4); }
  }
  fs::create_directories(tmp.root/id.id); fs::permissions(tmp.root/id.id,fs::perms::owner_all,fs::perm_options::replace);
  Write(DataV1(tmp,id),data); fs::permissions(DataV1(tmp,id),fs::perms::owner_read|fs::perms::owner_write,fs::perm_options::replace);
  const auto manifest = Json{{"schema_version",1},{"shard_id",id.id},{"revision",id.revision},{"channel_id",id.channel_id},
      {"model_version",id.model_version},{"utc_day",id.utc_day},{"dimensions",id.dimensions},
      {"checkpoint",id.checkpoint},{"storage_generation",id.storage_generation},{"volume_id",volume},
      {"record_count",sorted.size()},{"dtype","F32LE"},{"normalization","l2-f32-v1"},
      {"data",{{"file",std::to_string(id.revision)+".records.f32le"},{"bytes",data.size()},{"sha256",Sha(data)}}}}.dump();
  Write(Manifest(tmp,id),manifest); fs::permissions(Manifest(tmp,id),fs::perms::owner_read|fs::perms::owner_write,fs::perm_options::replace);
  return {id.id+"/"+std::to_string(id.revision)+".manifest.json",Sha(manifest),id.checkpoint,sorted.size(),data.size()+manifest.size()};
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
      auto loaded = store->Load(id,publication); Check(loaded.size() == 2 && loaded[0].id == kRecordA,"restart_order");
      const auto raw = Read(Data(tmp,id));
      Check(raw.substr(0,8) == "AINVRSH2" && U32(raw,8) == 2 && U32(raw,12) == 3 && U32(raw,16) == 1 && U32(raw,kCountAt) == 2,"i8_layout");
      VectorIndex baseline(id.model_version,3,10), restored(id.model_version,3,10);
      for (const auto& record : records) baseline.Upsert(record);
      for (const auto& record : loaded) restored.Upsert(record);
      Scope scope{{id.channel_id},86400000,172800000,10}; const auto a = baseline.Query({1,0,0},scope), b = restored.Query({1,0,0},scope);
      Check(a.size() == b.size(),"exact_baseline_size");
      // int8 per view: scores within quantization error, identity and order unchanged.
      for (size_t i = 0; i < a.size(); ++i) Check(a[i].id == b[i].id && a[i].fingerprint == b[i].fingerprint && std::abs(a[i].score-b[i].score)<0.01,"exact_baseline_changed");
      ++cases;
      // Columns served from the mapping: no per-record parsing, the same rows.
      const auto view = store->Open(id,publication);
      Check(view && view->count == 2 && !view->converted && view->views == 1 && view->Id(0) == kRecordA && view->Id(1) == kRecordB,"mapped_columns");
      Check(view->Fingerprint(0) == std::string(64,'a') && view->captured_ms[1] == 86401000 && view->scene[0] == 0,"mapped_metadata");
      Check(view->Find(kRecordB) == std::optional<size_t>(1) && !view->Find("cccccccc-0000-4000-8000-000000000003"),"mapped_lookup");
      Check(std::memcmp(view->groups, RecordGroup(loaded[0]).data(), 16) == 0,"mapped_group");
      const float q[3] = {1,0,0};
      Check(std::abs(CoarseBestView(view->vectors,view->scales,1,3,q,nullptr) - 1.0f) < 0.01f &&
            std::abs(CoarseBestView(view->vectors+3,view->scales+1,1,3,q,nullptr)) < 0.01f,"mapped_scores");
      ++cases;
      // A v1 (float32) file from before this format still loads and opens (converted).
      auto legacy = id; legacy.revision = 20;
      auto sorted = Records(legacy); std::reverse(sorted.begin(),sorted.end());
      const auto legacy_publication = WriteV1(tmp,legacy,sorted,"test-only");
      const auto legacy_rows = store->Load(legacy,legacy_publication);
      Check(legacy_rows.size() == 2 && legacy_rows[0].id == kRecordA && std::abs(legacy_rows[1].vector[2]-0.8f) < 1e-6,"v1_load");
      const auto converted = store->Open(legacy,legacy_publication);
      Check(converted->converted && converted->count == 2 && converted->Id(1) == kRecordB &&
            std::abs(CoarseBestView(converted->vectors,converted->scales,1,3,q,nullptr) - 1.0f) < 0.01f,"v1_open");
      store->DeleteAuthorized(legacy,legacy_publication);
      Check(!fs::exists(DataV1(tmp,legacy)) && !fs::exists(Manifest(tmp,legacy)),"v1_reclaimable");
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
      [](const auto& t,const auto& id,auto& p){ RewriteMeta(t,id,p,"\"captured_ms\":86401000","\"captured_ms\":86401001"); },
      [](const auto& t,const auto& id,auto& p){ RewriteMeta(t,id,p,"\"model\":\"search-v1-a","\"model\":\"search-v1-b"); },
      [](const auto& t,const auto& id,auto& p){ RewriteMeta(t,id,p,"\"fingerprint\":\"bbbb","\"fingerprint\":\"cbbb"); },
      [](const auto& t,const auto& id,auto& p){ RewriteMeta(t,id,p,"\"id\":\"bbbbbbbb","\"id\":\"aaaaaaaa"); },
      [](const auto& t,const auto& id,auto& p){auto data=Read(Data(t,id));Put32(data,kScalesAt,0x7fc00000);Write(Data(t,id),data);Rehash(t,id,p);},
      [](const auto& t,const auto& id,auto& p){auto data=Read(Data(t,id));Put32(data,kCountAt,0xffffffff);Write(Data(t,id),data);Rehash(t,id,p);},
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
