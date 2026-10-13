// Copyright AINVR. Original worker business with a TEST-ONLY model double.
// Real VPU/GLES input; no model inference claim, production history or AI output.
#include "pipeline/reused_channel_worker.hpp"
#include "api/control_server.hpp"
#include "adapters/factory.hpp"
#include <gtest/gtest.h>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <limits>
#include <thread>
#include <unistd.h>
using namespace ai_service;
namespace {
using Clock=std::chrono::steady_clock;
struct ModelEvidence {
  std::thread::id loaded_on;std::atomic<bool> load_fail=false,run_fail=false;
  std::atomic<int> active=0;std::atomic<bool> async_fail=false,destroyed_active=false;
  std::atomic<int> runs=0,destroyed=0;std::atomic<bool> same_thread=true;
};
class ModelDouble : public adapters::BpuChannelAdapter {
 public:
  ModelDouble(const config::ModelConfig& c,std::shared_ptr<ModelEvidence> e):BpuChannelAdapter(c),e_(std::move(e)){}
  ~ModelDouble(){e_->destroyed_active=e_->active.load()!=0;if(e_->loaded_on!=std::thread::id{})e_->same_thread=e_->same_thread&&std::this_thread::get_id()==e_->loaded_on;++e_->destroyed;}
  void Load(const std::string&,const std::string&,const std::string&) override {e_->loaded_on=std::this_thread::get_id();if(e_->load_fail)throw std::runtime_error("Test-only model load failure");}
  pipeline::PreprocessConfig DefaultPreprocess() const override {return {};}
  std::string ActualProvider() const override {return "test-double";}
  nlohmann::json ResultMetadata() const override {return {{"test_only",true},{"model_inference_executed",false}};}
  ainvr::BpuImageResult RunFrame(const ainvr::Nv12Frame& f,const pipeline::PreprocessConfig&,bool,bool) override{
    e_->same_thread=e_->same_thread&&std::this_thread::get_id()==e_->loaded_on;++e_->runs;
    if(e_->run_fail)throw std::runtime_error("Test-only execution failure");
    if(f.width!=3840||f.height!=1920||f.pixels.size()!=size_t(3840)*1920*3/2)throw std::runtime_error("Invalid real VPU input");
    ainvr::BpuImageResult r;r.outputs={{0}};r.image_backend="test-double";return r;
  }
  std::future<ainvr::BpuImageResult> RunFrameAsync(const ainvr::Nv12Frame& f,const pipeline::PreprocessConfig& p,bool bt,bool full) override {
    auto result=RunFrame(f,p,bt,full);
    return std::async(std::launch::async,[result=std::move(result),e=e_]() mutable {
      ++e->active;
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
      --e->active;
      if(e->async_fail)throw std::runtime_error("Test-only asynchronous execution failure");
      return std::move(result);
    });
  }
  std::vector<Detection> Postprocess(const std::vector<float>&,const pipeline::ScaleInfo&,double,double,int) override{
    Detection d;d.bbox={200,100,63,47};d.confidence=.9;return {d};
  }
 private:std::shared_ptr<ModelEvidence> e_;
};
class WorkerDouble : public pipeline::ReusedChannelWorker {
 public:
  WorkerDouble(config::ChannelConfig c,std::shared_ptr<ModelEvidence> e):ReusedChannelWorker(std::move(c)),e_(std::move(e)){}
  void ValidateStart() const override {} // Only this compiled test class bypasses a user-model manifest.
 protected:
  std::unique_ptr<adapters::BpuChannelAdapter> CreatePlatformAdapter(const config::ModelConfig& c) override{return std::make_unique<ModelDouble>(c,e_);}
 private:std::shared_ptr<ModelEvidence> e_;
};
class SnapshotDouble : public pipeline::SnapshotSink {
 public:
  std::atomic<int> downloads=0;std::atomic<bool> valid=true;
  void Offer(const FrameProvider& f,const std::string&,const std::string&,int64_t,double,
      const std::string&,const std::string&,const std::vector<Detection>&,const std::vector<Detection>&,bool,
      const config::SnapshotConfig& cfg) override {
    if(!cfg.enabled||f.cancelled())return;
    cv::Mat pixels;f.download({200,100,63,47},pixels);
    bool ok=pixels.type()==CV_8UC4&&pixels.cols==63&&pixels.rows==47;
    if(f.owned_download){
      auto future=std::async(std::launch::async,[download=f.owned_download]{
        cv::Mat owned;download({200,100,63,47},owned);return owned;
      });
      auto owned=future.get();
      ok=ok&&owned.size()==pixels.size()&&owned.type()==pixels.type()&&cv::norm(owned,pixels,cv::NORM_INF)==0;
    }

    if(ok)for(int y=0;y<pixels.rows;++y)for(int x=0;x<pixels.cols;++x)ok=ok&&pixels.ptr(y)[x*4+3]==255;
    valid=valid&&ok;++downloads;
  }
};
config::ChannelConfig Config(){
  config::ChannelConfig c;c.id="isolated-worker-business-test";c.name="TEST ONLY";
  c.stream.url="rtmp://127.0.0.1:1935/live/xm";c.stream.reconnect.enabled=false;
  c.publish.enabled=false;c.inference_fps=15;c.model.adapter="yolo26_bpu";c.model.provider="bpu";
  c.model.path="intentionally-no-user-model.hbm";c.snapshot.enabled=false;c.max_consecutive_failures=2;return c;
}
template<class Predicate> bool Wait(Predicate pred,int ms=5000){auto deadline=Clock::now()+std::chrono::milliseconds(ms);
  while(!pred()&&Clock::now()<deadline)std::this_thread::sleep_for(std::chrono::milliseconds(10));return pred();}
}
TEST(ReusedWorker,ProductionRejectsCpuAndMissingHbmBeforeOpeningStream){
  auto c=Config();pipeline::ReusedChannelWorker w(c);EXPECT_THROW(w.Start(),std::runtime_error);
  EXPECT_EQ(w.State(),pipeline::ChannelState::kIdle);EXPECT_EQ(w.GetStats()["frame_count"],0);
  c.model.provider="cpu";c.model.path="models/yolo26m.onnx";pipeline::ReusedChannelWorker cpu(c);
  EXPECT_THROW(cpu.ValidateStart(),std::runtime_error);
}
namespace {
// Contract parsing only: the payload is deliberately not a compiled model.
struct ContractFixture {
  std::filesystem::path directory;
  config::ModelConfig model=Config().model;
  nlohmann::json manifest;
  ContractFixture(){
    char path[]="/home/sunrise/ainvr/test/results/worker-contract-XXXXXX";
    const auto created=mkdtemp(path);if(!created)throw std::runtime_error("Cannot create contract fixture");
    directory=created;model.path=(directory/"invalid-test-only.hbm").string();model.class_names=std::vector<std::string>{"person"};
    std::ofstream(model.path,std::ios::binary)<<"AINVR test-only invalid HBM\n";
    manifest={{"schema_version",1},{"target","rdk_s100p"},{"adapter",model.adapter},
      {"hbm_sha256","1e5e968179f28f4564aedb27bc250990dff7999b197c54b136e1386d02c2ad06"},
      {"input_size",model.input_size},{"input_contract","float_nchw"},
      {"output_contract","end2end_xyxy_score_class"},{"class_names",{"person"}},
      {"outputs",nlohmann::json::array({{{"name","test"},{"shape",{1,1,6}}}})},
      {"preprocess",{{"rgb_order",true},{"normalize",true},{"mean",{0,0,0}},{"std",{255,255,255}}}}};
    Write();
  }
  void Write(){std::ofstream(model.path+".ainvr.json")<<manifest.dump();}
  ~ContractFixture(){std::error_code e;std::filesystem::remove(model.path,e);std::filesystem::remove(model.path+".ainvr.json",e);std::filesystem::remove(directory,e);}
};
}
TEST(BpuContract,MetadataPreflightDoesNotLoadOrClaimCompiledModel){
  ContractFixture f;EXPECT_EQ(adapters::BpuChannelAdapter::ValidateModel(f.model),f.manifest);
  RecordProperty("model_loaded","false");RecordProperty("valid_compiled_hbm","false");
}
TEST(BpuOutputSignature, RejectsUnsupportedYoloMatricesNamesAndDimensionTypes) {
  ContractFixture f;const auto original=f.manifest;
  for(const nlohmann::json& shape:{nlohmann::json::array({1,84,8400}),nlohmann::json::array({2,300,6}),
      nlohmann::json::array({1,0,6}),nlohmann::json::array({1,-1,6}),nlohmann::json::array({1,300,5}),
      nlohmann::json::array({1,300,6,1}),nlohmann::json::array({300,6.5}),
      nlohmann::json::array({"300",6}),nlohmann::json::array({true,6}),
      nlohmann::json::array({std::numeric_limits<uint64_t>::max(),6}),
      nlohmann::json::array({std::numeric_limits<int64_t>::max(),6})}){
    SCOPED_TRACE(shape.dump());f.manifest=original;f.manifest["outputs"][0]["shape"]=shape;f.Write();
    EXPECT_THROW(adapters::BpuChannelAdapter::ValidateModel(f.model),std::exception);
  }
  for(const nlohmann::json& name:{nlohmann::json(""),nlohmann::json(nullptr),nlohmann::json(17)}){
    f.manifest=original;f.manifest["outputs"][0]["name"]=name;f.Write();
    EXPECT_THROW(adapters::BpuChannelAdapter::ValidateModel(f.model),std::exception);
  }
  for(const nlohmann::json& shape:{nlohmann::json::array({300,6}),nlohmann::json::array({1,300,6})}){
    f.manifest=original;f.manifest["outputs"][0]["shape"]=shape;f.Write();
    EXPECT_NO_THROW(adapters::BpuChannelAdapter::ValidateModel(f.model));
  }
  RecordProperty("valid_compiled_hbm","false");RecordProperty("inference_executed","false");
}
TEST(BpuOutputSignature, ScrfdHeadShapesMatchInputAndPermitUnorderedCompilerNames) {
  ContractFixture f;f.model.adapter="scrfd_bpu";f.model.class_names=std::vector<std::string>{"face"};
  f.model.input_size={512,768};f.manifest["adapter"]="scrfd_bpu";f.manifest["input_size"]=f.model.input_size;
  f.manifest["class_names"]={"face"};f.manifest["output_contract"]="scrfd_9_heads";
  f.manifest["outputs"]=nlohmann::json::array();
  for(int stride:{32,8,16})for(int columns:{10,1,4}){
    const int count=(512/stride)*(768/stride)*2;
    f.manifest["outputs"].push_back({{"name","head_"+std::to_string(stride)+"_"+std::to_string(columns)},
      {"shape",columns==1?nlohmann::json::array({count,columns}):nlohmann::json::array({1,count,columns})}});
  }
  f.Write();EXPECT_NO_THROW(adapters::BpuChannelAdapter::ValidateModel(f.model));const auto original=f.manifest;
  for(const nlohmann::json& shape:{nlohmann::json::array({1,999,10}),nlohmann::json::array({1,768,11}),
      nlohmann::json::array({2,768,10})}){
    f.manifest=original;f.manifest["outputs"][0]["shape"]=shape;f.Write();
    EXPECT_THROW(adapters::BpuChannelAdapter::ValidateModel(f.model),std::exception);
  }
  f.manifest=original;f.manifest["outputs"][1]["name"]=f.manifest["outputs"][0]["name"];f.Write();
  EXPECT_THROW(adapters::BpuChannelAdapter::ValidateModel(f.model),std::exception);
  f.manifest=original;f.manifest["outputs"][1]["shape"]=f.manifest["outputs"][0]["shape"];f.Write();
  EXPECT_THROW(adapters::BpuChannelAdapter::ValidateModel(f.model),std::exception);
  f.model.input_size={510,768};f.manifest=original;f.manifest["input_size"]=f.model.input_size;f.Write();
  EXPECT_THROW(adapters::BpuChannelAdapter::ValidateModel(f.model),std::exception);
  RecordProperty("valid_compiled_hbm","false");RecordProperty("inference_executed","false");
}
TEST(BpuOutputSignature, MalformedMatrixFailsStartPreflightWithoutOpeningInput) {
  ContractFixture f;f.manifest["outputs"][0]["shape"]={1,84,8400};f.Write();
  auto c=Config();c.model=f.model;pipeline::ReusedChannelWorker worker(c);
  try{worker.ValidateStart();FAIL()<<"Bad compiled output contract passed preflight";}
  catch(const api::ApiError& error){EXPECT_EQ(error.status_code(),422);EXPECT_EQ(error.code(),"bpu_model_not_ready");}
  EXPECT_EQ(worker.State(),pipeline::ChannelState::kIdle);
  EXPECT_EQ(worker.GetStats()["frame_count"],0);EXPECT_EQ(worker.GetStats()["inference_count"],0);
  RecordProperty("valid_compiled_hbm","false");RecordProperty("inference_executed","false");
}
TEST(BpuContract,MismatchedDigestDimensionsLabelsTargetAndLayoutAreRejected){
  ContractFixture f;const auto original=f.manifest;
  auto invalid=[&](const char* key,nlohmann::json value){f.manifest=original;f.manifest[key]=value;f.Write();EXPECT_THROW(adapters::BpuChannelAdapter::ValidateModel(f.model),std::exception);};
  invalid("hbm_sha256",std::string(64,'0'));invalid("input_size",{320,320});
  invalid("class_names",{"car"});invalid("target","jetson");
  invalid("adapter","scrfd_bpu");invalid("output_contract","unknown");invalid("input_contract","unknown");
  f.manifest=original;f.manifest["preprocess"]["std"]={0,255,255};f.Write();
  EXPECT_THROW(adapters::BpuChannelAdapter::ValidateModel(f.model),std::exception);
}
TEST(BpuContract,MissingMalformedAndOversizedManifestsAreRejected){
  ContractFixture f;std::filesystem::remove(f.model.path+".ainvr.json");
  EXPECT_THROW(adapters::BpuChannelAdapter::ValidateModel(f.model),std::exception);
  std::ofstream(f.model.path+".ainvr.json")<<"{";
  EXPECT_THROW(adapters::BpuChannelAdapter::ValidateModel(f.model),std::exception);
  std::ofstream(f.model.path+".ainvr.json")<<std::string(1024*1024+1,' ');
  EXPECT_THROW(adapters::BpuChannelAdapter::ValidateModel(f.model),std::exception);
}
TEST(BpuContract,RelativeModelRootPreflightPreservesStoredConfig){
  ContractFixture f;auto c=Config();c.model=f.model;c.model.path=std::filesystem::path(f.model.path).filename().string();
  pipeline::ReusedChannelWorker w(c,{},f.directory.string());EXPECT_NO_THROW(w.ValidateStart());
  EXPECT_EQ(w.Config()->model.path,c.model.path);EXPECT_EQ(w.State(),pipeline::ChannelState::kIdle);
  EXPECT_EQ(w.GetStats()["frame_count"],0);
}
namespace {
config::ChannelConfig FaceConfig(ContractFixture& f) {
  f.model.adapter="yoloface_bpu";f.model.name="face_detector";
  f.model.class_names=std::vector<std::string>{"face"};
  f.manifest["adapter"]=f.model.adapter;f.manifest["class_names"]={"face"};f.Write();
  auto c=Config();c.model=f.model;c.snapshot.enabled=true;c.snapshot.face_enhance_model="gpen";
  return c;
}
}
TEST(FaceSnapshotPreflight, MissingEnhancementMustFailBeforeOpeningSource) {
  ContractFixture f;auto c=FaceConfig(f);config::SnapshotStoreConfig store;
  store.face_enhance_engine="intentionally-missing-gpen.hbm";
  pipeline::ReusedChannelWorker w(c,store,f.directory.string());
  EXPECT_THROW(w.ValidateStart(),api::ApiError);
  EXPECT_EQ(w.State(),pipeline::ChannelState::kIdle);
  EXPECT_EQ(w.GetStats()["frame_count"],0);EXPECT_EQ(w.GetStats()["inference_count"],0);
  RecordProperty("compiled_detector_used","false");
}
TEST(FaceTaskIdentity, DedicatedAdaptersMatchReferenceWithoutFilenameOrLabelHints) {
  auto c=Config();c.model.name="detector_001";c.model.path="opaque-model.hbm";
  c.model.class_names=std::vector<std::string>{"localized-label"};
  for(const auto& kind:{"yoloface_bpu","scrfd_bpu","yolo26_bpu"}){
    SCOPED_TRACE(kind);c.model.adapter=kind;
    adapters::BpuChannelAdapter native(c.model);auto metadata=adapters::CreateAdapter(c.model);
    const bool specialized=std::string(kind)!="yolo26_bpu";
    const bool square=std::string(kind)=="yoloface_bpu",multi=std::string(kind)=="scrfd_bpu";
    for(const adapters::BaseModelAdapter* adapter:{static_cast<const adapters::BaseModelAdapter*>(&native),static_cast<const adapters::BaseModelAdapter*>(metadata.get())}){
      EXPECT_EQ(adapter->TaskType(),specialized?"face_detection":"object_detection");
      EXPECT_EQ(adapter->SquareSnapshotCrop(),square);EXPECT_EQ(adapter->IsMultiOutput(),multi);
    }
    EXPECT_EQ(metadata->ActualProvider(),"unavailable");
    EXPECT_THROW(metadata->Load(c.model.path,"bpu",""),std::runtime_error);
  }
  RecordProperty("model_inference_executed","false");
}
TEST(FaceTaskIdentity, GeneralAdapterKeepsExistingExplicitFaceHintAndRectangularCrop) {
  auto c=Config();c.model.name="detector_001";c.model.path="opaque-model.hbm";
  c.model.class_names=std::vector<std::string>{"FACE"};
  adapters::BpuChannelAdapter native(c.model);auto metadata=adapters::CreateAdapter(c.model);
  EXPECT_EQ(native.TaskType(),"face_detection");EXPECT_EQ(metadata->TaskType(),"face_detection");
  EXPECT_FALSE(native.SquareSnapshotCrop());EXPECT_FALSE(metadata->SquareSnapshotCrop());
  EXPECT_FALSE(native.IsMultiOutput());EXPECT_FALSE(metadata->IsMultiOutput());
}
TEST(FaceSnapshotPreflight, RenamedDedicatedFaceModelCannotBypassEnhancementValidation) {
  ContractFixture f;f.model.adapter="yoloface_bpu";f.model.name="detector_001";
  f.model.class_names=std::vector<std::string>{"localized-label"};
  f.manifest["adapter"]=f.model.adapter;f.manifest["class_names"]={"localized-label"};f.Write();
  ASSERT_NO_THROW(adapters::BpuChannelAdapter::ValidateModel(f.model));
  auto c=Config();c.model=f.model;c.snapshot.enabled=true;c.snapshot.face_enhance_model="gpen";
  config::SnapshotStoreConfig store;store.face_enhance_engine="missing-restoration.hbm";
  pipeline::ReusedChannelWorker worker(c,store,f.directory.string());
  try{worker.ValidateStart();FAIL()<<"Renamed face detector skipped missing enhancement validation";}
  catch(const api::ApiError& error){EXPECT_EQ(error.code(),"face_model_not_ready");EXPECT_EQ(error.status_code(),422);}
  EXPECT_EQ(worker.State(),pipeline::ChannelState::kIdle);
  EXPECT_EQ(worker.GetStats()["frame_count"],0);EXPECT_EQ(worker.GetStats()["inference_count"],0);
  RecordProperty("valid_compiled_hbm","false");RecordProperty("model_inference_executed","false");
}
TEST(FaceSnapshotPreflight, DisabledArchiveAndGeneralDetectionDoNotRequireRestoration) {
  ContractFixture f;auto c=FaceConfig(f);config::SnapshotStoreConfig store;
  store.face_enhance_engine="intentionally-missing-gpen.hbm";c.snapshot.enabled=false;
  pipeline::ReusedChannelWorker disabled(c,store,f.directory.string());
  EXPECT_NO_THROW(disabled.ValidateStart());
  c.snapshot.enabled=true;c.model.adapter="yolo26_bpu";c.model.name="general_detector";
  c.model.class_names=std::vector<std::string>{"person"};
  f.manifest["adapter"]=c.model.adapter;f.manifest["class_names"]={"person"};f.Write();
  pipeline::ReusedChannelWorker general(c,store,f.directory.string());
  EXPECT_NO_THROW(general.ValidateStart());
  RecordProperty("bpu_execution","false");
}
TEST(FaceSnapshotPreflight, RestorationSignatureValidationDoesNotLoadSdkOrOpenSource) {
  ContractFixture f;auto c=FaceConfig(f);config::SnapshotStoreConfig store;
  store.face_enhance_engine="restoration-test-only.hbm";
  const auto path=f.directory/store.face_enhance_engine;
  std::filesystem::copy_file(f.model.path,path);
  nlohmann::json manifest={{"schema_version",1},{"target","rdk_s100p"},
    {"adapter","gpen_bpu"},{"role","face_restoration"},{"input_size",{256,256}},
    {"input_contract","float_nchw_rgb_minus1_1_cubic_gray128"},
    {"output_contract","float_nchw_rgb_minus1_1"},{"hbm_sha256",f.manifest["hbm_sha256"]},
    {"inputs",nlohmann::json::array({{{"name","input"},{"shape",{1,3,256,256}}}})},
    {"outputs",nlohmann::json::array({{{"name","output"},{"shape",{1,3,256,256}}}})}};
  std::ofstream(path.string()+".ainvr.json")<<manifest.dump();
  pipeline::ReusedChannelWorker valid(c,store,f.directory.string());
  EXPECT_NO_THROW(valid.ValidateStart());
  manifest["role"]="detection";
  std::ofstream(path.string()+".ainvr.json")<<manifest.dump();
  EXPECT_THROW(valid.ValidateStart(),api::ApiError);
  std::filesystem::remove(path);std::filesystem::remove(path.string()+".ainvr.json");
  RecordProperty("artifacts_are_intentionally_invalid_hbm","true");
  RecordProperty("sdk_model_loaded","false");
}
TEST(ReusedWorker,RealVpuHotConfigGpuSnapshotAndModelThreadOwnership){
  auto c=Config();c.snapshot.enabled=true;auto e=std::make_shared<ModelEvidence>();WorkerDouble w(c,e);
  auto sink=std::make_shared<SnapshotDouble>();w.SetSnapshotSink(sink);w.Start();
  ASSERT_EQ(w.State(),pipeline::ChannelState::kRunning);ASSERT_TRUE(Wait([&]{return sink->downloads>=3;},15000));
  EXPECT_TRUE(sink->valid);EXPECT_NE(e->loaded_on,std::this_thread::get_id());
  auto next=*w.Config();next.name="TEST RENAMED";next.inference_fps=5;next.result_buffer.max_frames=2;next.snapshot.enabled=false;
  const auto before=e->runs.load();w.ApplyHotPatch(next,{"name","inference_fps","result_buffer","snapshot"});
  ASSERT_TRUE(Wait([&]{return e->runs>before;}));EXPECT_EQ(w.Config()->name,"TEST RENAMED");
  EXPECT_EQ(w.Config()->inference_fps,5);EXPECT_LE(w.GetResultBuffer().Size(),2);
  const auto begin=Clock::now();w.Stop();const double stop_ms=std::chrono::duration<double,std::milli>(Clock::now()-begin).count();
  EXPECT_LT(stop_ms,1500);EXPECT_TRUE(e->same_thread);EXPECT_EQ(e->destroyed,1);
  auto result=w.GetResultBuffer().Latest();ASSERT_TRUE(result.has_value());EXPECT_EQ(result->model_provider,"test-double");
  EXPECT_TRUE(result->model_extra["test_only"].get<bool>());
  RecordProperty("hardware_snapshot_downloads",sink->downloads.load());RecordProperty("model_inference_executed","false");
}
TEST(ReusedWorker,LoadFailureStopsSourceAndDestroysAdapterOnInferenceThread){
  auto e=std::make_shared<ModelEvidence>();e->load_fail=true;WorkerDouble w(Config(),e);w.Start();
  EXPECT_EQ(w.State(),pipeline::ChannelState::kError);EXPECT_EQ(e->runs,0);EXPECT_EQ(e->destroyed,1);EXPECT_TRUE(e->same_thread);
  EXPECT_FALSE(w.GetStats()["last_error"].is_null());w.Stop();
  e->load_fail=false;w.Start();ASSERT_EQ(w.State(),pipeline::ChannelState::kRunning);
  ASSERT_TRUE(Wait([&]{return e->runs>=2;}));w.Stop();EXPECT_EQ(e->destroyed,2);EXPECT_TRUE(e->same_thread);
}
TEST(ReusedWorker,ConsecutiveExecutionFailureStopsBothThreadsAndCanRestart){
  auto e=std::make_shared<ModelEvidence>();e->run_fail=true;WorkerDouble w(Config(),e);w.Start();
  ASSERT_TRUE(Wait([&]{return w.State()==pipeline::ChannelState::kError;}));w.Stop();
  EXPECT_GE(e->runs,2);EXPECT_TRUE(e->same_thread);EXPECT_EQ(e->destroyed,1);
  e->run_fail=false;w.Start();ASSERT_EQ(w.State(),pipeline::ChannelState::kRunning);
  const auto before=e->runs.load();ASSERT_TRUE(Wait([&]{return e->runs>=before+2;}));w.Stop();EXPECT_TRUE(e->same_thread);
}
TEST(ReusedWorker,LicenseRevocationEndsGenerationAndRequiresFreshStart){
  auto e=std::make_shared<ModelEvidence>();WorkerDouble w(Config(),e);std::atomic<bool> licensed=false;
  w.SetLicenseCheck([&]{return licensed.load();});EXPECT_THROW(w.Start(),std::runtime_error);
  licensed=true;w.Start();ASSERT_TRUE(Wait([&]{return e->runs>=2;}));licensed=false;
  ASSERT_TRUE(Wait([&]{return w.State()==pipeline::ChannelState::kIdle;}));w.Stop();
  const auto stopped=e->runs.load();licensed=true;std::this_thread::sleep_for(std::chrono::milliseconds(150));
  EXPECT_EQ(e->runs,stopped);w.Start();ASSERT_TRUE(Wait([&]{return e->runs>stopped;}));w.Stop();EXPECT_TRUE(e->same_thread);
}
TEST(ReusedWorker,OriginalPublisherReceivesMatchingGenerationSeiOnlyOnIsolatedStream){
  auto c=Config();c.id="ainvr-worker-test-"+std::to_string(getpid());c.publish.enabled=true;
  c.publish.target_url="rtmp://127.0.0.1:1935/live/"+c.id;
  auto e=std::make_shared<ModelEvidence>();WorkerDouble w(c,e);w.Start();
  ASSERT_EQ(w.State(),pipeline::ChannelState::kRunning);
  ASSERT_TRUE(Wait([&]{const auto s=w.GetStats();return s.contains("publish")&&s["publish"]["sei_injected"].get<int64_t>()>=3&&s["publish"]["au_pushed"].get<int64_t>()>=3;},8000));
  const auto stats=w.GetStats();EXPECT_GE(stats["publish"]["au_pushed"].get<int64_t>(),3);
  EXPECT_EQ(stats["publish"]["buffer"]["unknown"],0);
  RecordProperty("isolated_sei_injected",stats["publish"]["sei_injected"].get<int>());
  w.Stop();EXPECT_TRUE(e->same_thread);
}

TEST(ReusedWorker,StopJoinsActualAsyncWorkAndFailureCanRestart) {
  auto evidence=std::make_shared<ModelEvidence>();
  WorkerDouble worker(Config(),evidence);
  worker.Start();
  EXPECT_TRUE(Wait([&]{return evidence->active.load()>0;}));
  worker.Stop();
  EXPECT_EQ(evidence->active.load(),0);
  EXPECT_FALSE(evidence->destroyed_active.load());
  evidence->async_fail=true;
  worker.Start();
  EXPECT_TRUE(Wait([&]{return worker.State()==pipeline::ChannelState::kError;}));
  worker.Stop();
  EXPECT_EQ(evidence->active.load(),0);
  EXPECT_FALSE(evidence->destroyed_active.load());
  evidence->async_fail=false;
  const auto before=evidence->runs.load();
  worker.Start();
  EXPECT_TRUE(Wait([&]{return evidence->runs.load()>before+2;}));
  worker.Stop();
  EXPECT_TRUE(evidence->same_thread.load());
  EXPECT_FALSE(evidence->destroyed_active.load());
}
