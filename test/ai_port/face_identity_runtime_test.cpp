#include "face_embedding_test_fixture.hpp"
#include "face_identity/runtime.hpp"
#include <gtest/gtest.h>
using namespace ainvr::face;
using namespace face_test;
namespace {
struct Fake:Extractor {
  std::function<Result(const Current&)> run;
  Result Extract(const std::vector<uint8_t>&,const Current& current) override{return run(current);}
};
struct Harness {
  std::atomic<int64_t> now{1000000};std::atomic<bool> authorized{true},budget_valid{true};
  std::atomic<int> loads{0},applies{0};
  const std::string token=std::string(32,'t');Peer peer{"127.0.0.1",token};
  std::function<Result(const Current&)> run=[&](const Current& current){
    if(!current())throw Error(409,"face_request_stale");
    Result r;r.status="extracted";r.space_hash=SpaceHash(Spec());r.quality.accepted=true;r.embedding[0]=1;return r;};
  std::unique_ptr<Runtime> runtime;
  Harness(bool admission=true) {
    Runtime::ApplyDemand apply;
    if(admission)apply=[&](const Settings& s){++applies;return s.enabled?BudgetLease{std::make_shared<int>(1),[&]{return budget_valid.load();}}:BudgetLease{};};
    runtime=std::make_unique<Runtime>("unused",[&]{return token;},[&]{return authorized.load();},apply,
      [&](const Settings&,BudgetLease lease,const Current& current){
        if(!lease.Valid()||!current())throw Error(503,"face_budget_unavailable");
        ++loads;
        auto fake=std::make_unique<Fake>();fake->run=[&](const Current& c){return run(c);};return fake;},
      [](const std::string& id,bool e){return Spec(id,e);},[&]{return now.load();});
  }
  Json Config(bool enabled=true,int shift=0) {
    return {{"action","configure"},{"enabled",enabled},{"detector_model","face-det-scrfd-500m"},
      {"embedding_model","face-embed-mbf"},{"model_space_hash",SpaceHash(Spec())},
      {"detector_sha256",std::string(64,'b')},{"issued_ms",now.load()+shift},{"expires_ms",now.load()+60000}};
  }
  // Header-only JPEG fixture. The fake never decodes pixels; production uses JPU.
  std::string Jpeg(){const unsigned char b[]{255,216,255,192,0,8,8,0,112,0,112,3,255,217};return std::string((const char*)b,sizeof b);}
  Json Request(){return {{"action","extract"},{"request_id","test-1"},{"model_space_hash",SpaceHash(Spec())},
    {"detector_sha256",std::string(64,'b')},{"jpeg_sha256",Sha256(Jpeg())},{"expires_ms",now.load()+30000}};}
  Json Call(){return runtime->Call(Request(),Jpeg(),peer);}
  void Enable(){runtime->Call(Config(),"",peer);}
};
template<class F>void Code(F f,int status,const char* code){try{f();FAIL()<<"expected error";}catch(const Error& e){EXPECT_EQ(e.status,status);EXPECT_STREQ(e.what(),code);}}
}
TEST(FaceRuntime,RequiresLoopbackAndNonemptyDedicatedToken) {
  Harness h;auto input=Json{{"action","status"}};
  Code([&]{h.runtime->Call(input,"",{"192.168.100.1",h.token});},403,"face_not_authorized");
  Code([&]{h.runtime->Call(input,"",{"127.0.0.1",""});},403,"face_not_authorized");
  EXPECT_FALSE(LocalPeer({"127.0.0.1",""},""));EXPECT_EQ(h.loads,0);
}
TEST(FaceRuntime,ConfigurationIsLazyAndMissingAdmissionFailsClosed) {
  Harness h;h.Enable();EXPECT_EQ(h.loads,0);auto status=h.runtime->Call({{"action","status"}},"",h.peer);
  EXPECT_FALSE(status.at("loaded"));EXPECT_FALSE(status.at("ready"));EXPECT_TRUE(status.at("can_extract"));
  EXPECT_EQ(status.at("reason"),"lazy_not_loaded");EXPECT_EQ(status.at("embedding_model"),"face-embed-mbf");
  Harness absent(false);Code([&]{absent.Enable();},503,"face_budget_not_connected");EXPECT_EQ(absent.loads,0);
}
TEST(FaceRuntime,RejectsUnconfiguredAndStaleSpaceBeforeHardware) {
  Harness h;Code([&]{h.Call();},503,"face_not_configured");h.Enable();auto request=h.Request();request["model_space_hash"]=std::string(64,'f');
  Code([&]{h.runtime->Call(request,h.Jpeg(),h.peer);},409,"face_model_space_changed");EXPECT_EQ(h.loads,0);
}
TEST(FaceRuntime,ExtractsInternalVectorWithExactInputBinding) {
  Harness h;h.Enable();auto out=h.Call();EXPECT_EQ(h.loads,1);EXPECT_EQ(out.at("status"),"extracted");
  EXPECT_EQ(out.at("embedding").size(),512);EXPECT_EQ(out.at("jpeg_sha256"),Sha256(h.Jpeg()));
  EXPECT_EQ(out.at("visibility"),"internal_only");
  auto status=h.runtime->Call({{"action","status"}},"",h.peer);EXPECT_TRUE(status.at("ready"));
  h.Call();EXPECT_EQ(h.loads,1); // Same-generation requests share one affine wrapper.
}
TEST(FaceRuntime,RejectsClientLandmarksAndImageHashMismatch) {
  Harness h;h.Enable();auto r=h.Request();r["landmarks"]={};Code([&]{h.runtime->Call(r,h.Jpeg(),h.peer);},422,"invalid_face_request");
  r=h.Request();r["jpeg_sha256"]=std::string(64,'0');Code([&]{h.runtime->Call(r,h.Jpeg(),h.peer);},422,"face_image_hash_mismatch");EXPECT_EQ(h.loads,0);
}
TEST(FaceRuntime,RejectsLargeDimensionsBeforeHardware) {
  Harness h;h.Enable();auto image=h.Jpeg();image[9]=32;image[10]=0;auto r=h.Request();r["jpeg_sha256"]=Sha256(image);
  Code([&]{h.runtime->Call(r,image,h.peer);},422,"unsupported_face_image");EXPECT_EQ(h.loads,0);
}
TEST(FaceRuntime,RejectedQualityReturnsNoEmbeddingAndNoStrangerDecision) {
  Harness h;h.Enable();h.run=[](const Current&){Result r;r.status="quality_rejected";r.space_hash=SpaceHash(Spec());r.quality.reason="alignment_residual";return r;};
  auto r=h.Call();EXPECT_FALSE(r.contains("embedding"));EXPECT_FALSE(r.contains("identity"));EXPECT_EQ(r.at("status"),"quality_rejected");
}
TEST(FaceRuntime,BusyRejectsWithoutAdditionalModelOrQueue) {
  Harness h;h.Enable();std::promise<void> entered,release;auto released=release.get_future().share();
  h.run=[&](const Current&){entered.set_value();released.wait();Result r;r.status="no_face";r.space_hash=SpaceHash(Spec());return r;};
  auto call=std::async(std::launch::async,[&]{return h.Call();});entered.get_future().wait();
  Code([&]{h.Call();},429,"face_busy");release.set_value();EXPECT_EQ(call.get().at("status"),"no_face");EXPECT_EQ(h.loads,1);
}
TEST(FaceRuntime,RevocationDuringWorkCannotPublishEmbedding) {
  Harness h;h.Enable();std::promise<void> entered,release;auto released=release.get_future().share();
  h.run=[&](const Current&){entered.set_value();released.wait();Result r;r.status="extracted";r.space_hash=SpaceHash(Spec());r.quality.accepted=true;r.embedding[0]=1;return r;};
  auto call=std::async(std::launch::async,[&]{return h.Call();});entered.get_future().wait();h.authorized=false;release.set_value();
  Code([&]{call.get();},409,"face_request_stale");
}
TEST(FaceRuntime,ConfigurationChangeFencesInFlightResult) {
  Harness h;h.Enable();std::promise<void> entered,release;auto released=release.get_future().share();
  h.run=[&](const Current&){entered.set_value();released.wait();Result r;r.status="no_face";r.space_hash=SpaceHash(Spec());return r;};
  auto call=std::async(std::launch::async,[&]{return h.Call();});entered.get_future().wait();h.runtime->Call(h.Config(false,1),"",h.peer);release.set_value();
  Code([&]{call.get();},409,"face_request_stale");
}
TEST(FaceRuntime,ExpiredGrantCannotExecute) {
  Harness h;h.Enable();h.now+=60001;Code([&]{h.Call();},503,"face_not_configured");EXPECT_EQ(h.loads,0);
}
TEST(FaceRuntime,InvalidBudgetNeverConstructsHardware) {
  Harness h;h.budget_valid=false;Code([&]{h.Enable();},503,"face_budget_unavailable");EXPECT_EQ(h.loads,0);
}
TEST(FaceRuntime,ConflictingSameTimestampGrantRejected) {
  Harness h;h.Enable();Code([&]{h.runtime->Call(h.Config(false),"",h.peer);},409,"conflicting_face_grant");EXPECT_TRUE(h.runtime->Configured().enabled);
}
TEST(FaceRuntime,BudgetRevocationPreventsReadinessAndInference) {
  Harness h;h.Enable();h.budget_valid=false;
  auto status=h.runtime->Call({{"action","status"}},"",h.peer);
  EXPECT_FALSE(status.at("can_extract"));EXPECT_FALSE(status.at("ready"));EXPECT_EQ(status.at("reason"),"budget_unavailable");
  Code([&]{h.Call();},409,"face_request_stale");EXPECT_EQ(h.loads,0);
}
TEST(FaceRuntime,HardwareFailureIsSanitizedAndBackedOff) {
  Harness h;h.Enable();h.run=[](const Current&)->Result{throw std::runtime_error("private hardware details");};
  Code([&]{h.Call();},503,"face_hardware_unavailable");
  Code([&]{h.Call();},503,"face_hardware_backoff");
  auto status=h.runtime->Call({{"action","status"}},"",h.peer);EXPECT_FALSE(status.at("ready"));EXPECT_EQ(status.at("reason"),"hardware_backoff");
}
