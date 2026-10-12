// Copyright AINVR. OpenCV is an explicit test oracle, never an execution fallback.
#include <gtest/gtest.h>
#include <opencv2/imgproc.hpp>
#include <hobot/dnn/hb_dnn.h>
#include <openssl/evp.h>
#include <algorithm>
#include <cmath>
#include <chrono>
#include <cstring>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <future>
#include <iomanip>
#include <limits>
#include <sstream>
#include <unistd.h>
#include "platform/face_restore_gles.hpp"
#include "platform/gles_preprocess.hpp"
#include "output/face_enhancer_bpu.hpp"
using namespace ainvr;
using nlohmann::json;
namespace {
FaceRestoreInput ReferencePrepare(const cv::Mat& rgba,int size){
  cv::Mat rgb;cv::cvtColor(rgba,rgb,cv::COLOR_RGBA2RGB);
  const double scale=std::min(double(size)/rgba.cols,double(size)/rgba.rows);
  int w=std::max(1,int(std::nearbyint(rgba.cols*scale)));
  int h=std::max(1,int(std::nearbyint(rgba.rows*scale)));
  FaceRestoreInput in{size,{(size-w)/2,(size-h)/2,w,h},std::vector<float>(size_t(size)*size*3)};
  cv::Mat resized;cv::resize(rgb,resized,{w,h},0,0,cv::INTER_CUBIC);
  cv::Mat canvas(size,size,CV_8UC3,cv::Scalar::all(128));resized.copyTo(canvas(in.valid));
  cv::Mat norm;canvas.convertTo(norm,CV_32FC3,1./127.5,-1.);
  std::vector<cv::Mat> channels;cv::split(norm,channels);
  for(int c=0;c<3;++c)std::memcpy(in.nchw.data()+c*size*size,channels[c].data,size_t(size)*size*4);
  return in;
}
cv::Mat ReferenceFinish(const FaceRestoreInput& in,const std::vector<float>& output,double blend){
  std::vector<cv::Mat> originals,restored;
  const size_t plane=size_t(in.size)*in.size;
  for(int c=0;c<3;++c){
    originals.emplace_back(in.size,in.size,CV_32F,const_cast<float*>(in.nchw.data())+c*plane);
    restored.emplace_back(in.size,in.size,CV_32F,const_cast<float*>(output.data())+c*plane);
  }
  cv::Mat orig,out,mixed;cv::merge(originals,orig);cv::merge(restored,out);
  const double a=std::clamp(blend,0.,1.);
  cv::addWeighted(out,a,orig,1.-a,0,mixed,CV_32F);
  cv::Mat scaled=(mixed+1.)*127.5;
  cv::Mat rgba(in.size,in.size,CV_8UC4);
  for(int y=0;y<in.size;++y)for(int x=0;x<in.size;++x){
    auto v=scaled.at<cv::Vec3f>(y,x);auto& p=rgba.at<cv::Vec4b>(y,x);
    for(int c=0;c<3;++c)p[c]=in.valid.contains({x,y})?uint8_t(std::clamp(v[c],0.f,255.f)):128;
    p[3]=255;
  }
  return rgba;
}
json Descriptor(int size){
  const int64_t row=size*4+64,plane=row*size+128,total=plane*3;
  return { {"dtype_id",HB_DNN_TENSOR_TYPE_F32},{"quantization",NONE},
    {"shape",{1,3,size,size}},{"byte_strides",{total,plane,row,4}},
    {"aligned_bytes",total},{"name","restored"} };
}
std::vector<unsigned char> Pack(const std::vector<float>& values,const json& d,int size){
  auto s=d["byte_strides"].get<std::vector<int64_t>>();
  std::vector<unsigned char> bytes(d["aligned_bytes"].get<size_t>(),0xd7);
  for(int c=0;c<3;++c)for(int y=0;y<size;++y)
    std::memcpy(bytes.data()+c*s[1]+y*s[2],values.data()+(c*size+y)*size,size*4);
  return bytes;
}
}
TEST(FaceRestoreGles, OriginalCubicLetterboxNormalizationAndPaddedOutputMatch){
  cv::RNG rng(539);double max_input=0,max_output=0;int cases=0,preparations=0;
  const auto before=GetFaceRestoreStats();
  for(int size:{256,512})for(auto crop:{cv::Size(1,1),cv::Size(17,31),cv::Size(63,47),cv::Size(127,127),
      cv::Size(size-1,size-1),cv::Size(1,size-1),cv::Size(size-1,1),cv::Size(size-3,size-5)}){
    cv::Mat backing(crop.height+2,crop.width+2,CV_8UC4);rng.fill(backing,cv::RNG::UNIFORM,0,256);
    auto input=backing(cv::Rect(1,1,crop.width,crop.height));
    auto ref=ReferencePrepare(input,size);auto actual=PrepareFaceRestoreGles(input,size);
    ++preparations;
    EXPECT_EQ(actual.valid,ref.valid);
    double difference=0;
    for(size_t i=0;i<ref.nchw.size();++i)difference=std::max(difference,double(std::abs(ref.nchw[i]-actual.nchw[i])));
    max_input=std::max(max_input,difference);
    EXPECT_LE(difference,2./127.5+1e-6);
    auto output=ref.nchw;
    // Simulated model values exercise image layout/blending only. No inference
    // occurs in this quality test and it is not an enhancement-accuracy result.
    for(size_t i=0;i<output.size();++i)output[i]=output[i]*.7f+float(int(i%17)-8)*.02f;
    auto d=Descriptor(size);auto bytes=Pack(output,d,size);
    for(double blend:{-1.,0.,.25,.5,1.,2.}){
      auto got=FinishFaceRestoreGles(actual,bytes,d,blend);
      auto expected=ReferenceFinish(ref,output,blend);
      double error=cv::norm(got,expected,cv::NORM_INF);max_output=std::max(max_output,error);
      EXPECT_LE(error,2.)<<crop<<" size="<<size<<" blend="<<blend;
      for(int y=0;y<size;++y)for(int x=0;x<size;++x){
        const auto p=got.at<cv::Vec4b>(y,x);EXPECT_EQ(p[3],255);
        if(!ref.valid.contains({x,y}))EXPECT_EQ(p,cv::Vec4b(128,128,128,255));
      }
      ++cases;
    }
  }
  const auto after=GetFaceRestoreStats();
  EXPECT_EQ(after.prepared,before.prepared+preparations);EXPECT_EQ(after.blended,before.blended+cases);
  EXPECT_EQ(after.cpu_runs,0u);
  RecordProperty("pixel_cases",cases);RecordProperty("maximum_input_float_error",std::to_string(max_input));
  RecordProperty("maximum_output_code_value_error",max_output);
  RecordProperty("user_model_inference_verified","false");
}
TEST(FaceRestoreGles, RGBOrderTruncationAndGrayBordersArePreserved){
  cv::Mat crop(31,17,CV_8UC4,cv::Scalar(255,64,3,19));
  auto in=PrepareFaceRestoreGles(crop,256);auto out=in.nchw;
  const size_t plane=256*256;
  for(size_t i=0;i<plane;++i){out[i]=-.5f;out[i+plane]=0.f;out[i+2*plane]=.5f;}
  auto d=Descriptor(256);auto got=FinishFaceRestoreGles(in,Pack(out,d,256),d,1);
  EXPECT_EQ(got.at<cv::Vec4b>(128,128),cv::Vec4b(63,127,191,255));
  EXPECT_EQ(got.at<cv::Vec4b>(0,0),cv::Vec4b(128,128,128,255));
  EXPECT_NEAR(in.nchw[128*256+128],1.f,1e-6);
}
TEST(FaceRestoreGles, InvalidAndNonfiniteModelOutputsFailVisibly){
  EXPECT_THROW(PrepareFaceRestoreGles(cv::Mat(),256),std::invalid_argument);
  EXPECT_THROW(PrepareFaceRestoreGles(cv::Mat(256,8,CV_8UC4),256),std::invalid_argument);
  EXPECT_THROW(PrepareFaceRestoreGles(cv::Mat(32,32,CV_8UC3),256),std::invalid_argument);
  auto in=PrepareFaceRestoreGles(cv::Mat(31,17,CV_8UC4,cv::Scalar::all(80)),256);
  auto d=Descriptor(256);auto bytes=Pack(in.nchw,d,256);
  auto wrong=d;wrong["dtype_id"]=HB_DNN_TENSOR_TYPE_S8;
  EXPECT_THROW(FinishFaceRestoreGles(in,bytes,wrong,.5),std::invalid_argument);
  wrong=d;wrong["byte_strides"][1]=4;
  EXPECT_THROW(FinishFaceRestoreGles(in,bytes,wrong,.5),std::invalid_argument);
  EXPECT_THROW(FinishFaceRestoreGles(in,bytes,d,std::numeric_limits<double>::quiet_NaN()),std::invalid_argument);
  const float bad=std::numeric_limits<float>::infinity();std::memcpy(bytes.data(),&bad,4);
  EXPECT_THROW(FinishFaceRestoreGles(in,bytes,d,.5),std::runtime_error);
  EXPECT_EQ(GetFaceRestoreStats().cpu_runs,0u);
}
TEST(FaceRestoreGles, CallerContextAndConcurrentArchiveWorkersRemainUsable){
  GlesPreprocessor other;ImageTransform t;t.width=32;t.height=32;t.letterbox=false;
  std::vector<uint8_t> pixels(32*32*4,80);auto before=other.Run(pixels,32,32,t);
  cv::Mat crop(47,31,CV_8UC4,cv::Scalar(40,90,130,87));
  auto in=PrepareFaceRestoreGles(crop,256);auto d=Descriptor(256);
  FinishFaceRestoreGles(in,Pack(in.nchw,d,256),d,.5);
  EXPECT_EQ(other.Run(pixels,32,32,t),before);
  std::vector<std::future<cv::Mat>> workers;
  for(int i=0;i<4;++i)workers.push_back(std::async(std::launch::async,[crop]{
    auto in=PrepareFaceRestoreGles(crop,256);auto d=Descriptor(256);
    return FinishFaceRestoreGles(in,Pack(in.nchw,d,256),d,.5);
  }));
  auto reference=ReferencePrepare(crop,256);auto expected=ReferenceFinish(reference,reference.nchw,.5);
  for(auto& worker:workers)EXPECT_LE(cv::norm(worker.get(),expected,cv::NORM_INF),1.);
}
TEST(FaceRestoreGles, UnavailableRenderNodeNeverUsesCPUAndCanRecover){
  const auto prior=std::getenv("AINVR_DRM_RENDER_NODE");const std::string old=prior?prior:"";
  cv::Mat crop(31,17,CV_8UC4,cv::Scalar::all(80));PrepareFaceRestoreGles(crop,256);
  setenv("AINVR_DRM_RENDER_NODE","/nonexistent/ainvr-face-restore-test",1);
  EXPECT_THROW(PrepareFaceRestoreGles(crop,256),std::runtime_error);
  if(prior)setenv("AINVR_DRM_RENDER_NODE",old.c_str(),1);else unsetenv("AINVR_DRM_RENDER_NODE");
  EXPECT_NO_THROW(PrepareFaceRestoreGles(crop,256));EXPECT_EQ(GetFaceRestoreStats().cpu_runs,0u);
}
TEST(FaceRestoreGles, WarmPixelPipelinePerformanceExcludesInference){
  cv::Mat crop(127,95,CV_8UC4,cv::Scalar(45,90,170,255));
  for(int size:{256,512}){
    auto in=PrepareFaceRestoreGles(crop,size);auto d=Descriptor(size);
    auto bytes=Pack(in.nchw,d,size);
    FinishFaceRestoreGles(in,bytes,d,.5);
    std::vector<double> times;
    for(int i=0;i<20;++i){
      const auto start=std::chrono::steady_clock::now();
      auto input=PrepareFaceRestoreGles(crop,size);
      auto output=FinishFaceRestoreGles(input,bytes,d,.5);
      times.push_back(std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count());
      ASSERT_EQ(output.size(),cv::Size(size,size));
    }
    std::sort(times.begin(),times.end());double total=0;
    for(double value:times)total+=value;
    const auto prefix="size_"+std::to_string(size);
    RecordProperty(prefix+"_mean_ms",std::to_string(total/times.size()));
    RecordProperty(prefix+"_p50_ms",std::to_string(times[10]));
    RecordProperty(prefix+"_p95_ms",std::to_string(times[18]));
    RecordProperty(prefix+"_pixel_pipeline_fps",std::to_string(1000.*times.size()/total));
  }
  RecordProperty("model_inference_verified","false");
  EXPECT_EQ(GetFaceRestoreStats().cpu_runs,0u);
}
TEST(BpuFaceRestore, MissingHBMAndUnverifiedArtifactsCannotExecute){
  using namespace ai_service::output;
  EXPECT_THROW(CreateFaceEnhancerBpu("other","missing.hbm"),std::invalid_argument);
  auto path=std::filesystem::temp_directory_path()/("ainvr-face-manifest-"+std::to_string(getpid())+".hbm");
  auto model=CreateFaceEnhancerBpu("gpen",path.string());
  EXPECT_THROW(model->EnsureLoaded(),std::runtime_error);
  {std::ofstream file(path);file<<"manifest test fixture, not an executable HBM";}
  EXPECT_THROW(model->EnsureLoaded(),std::runtime_error);
  std::filesystem::remove(path);
  EXPECT_THROW(CreateFaceEnhancerBpu("gpen","model.engine")->EnsureLoaded(),std::runtime_error);
}
TEST(BpuFaceRestore, ManifestRequiresExactTaskTensorAndImageContracts){
  using namespace ai_service::output;
  const auto path=std::filesystem::temp_directory_path()/
    ("ainvr-face-contract-"+std::to_string(getpid())+".hbm");
  const auto sidecar=path.string()+".ainvr.json";
  struct Cleanup {
    std::filesystem::path model,sidecar;
    ~Cleanup(){std::filesystem::remove(model);std::filesystem::remove(sidecar);}
  } cleanup{path,sidecar};
  const std::string data="metadata fixture only; never sent to HB_DNN";
  {std::ofstream file(path);file<<data;}
  unsigned char digest[32];unsigned int length=0;
  ASSERT_EQ(EVP_Digest(data.data(),data.size(),digest,&length,EVP_sha256(),nullptr),1);
  std::ostringstream sha;sha<<std::hex<<std::setfill('0');
  for(unsigned i=0;i<length;++i)sha<<std::setw(2)<<int(digest[i]);
  json valid={{"schema_version",1},{"target","rdk_s100p"},{"adapter","gpen_bpu"},
    {"role","face_restoration"},{"input_size",{256,256}},
    {"input_contract","float_nchw_rgb_minus1_1_cubic_gray128"},
    {"output_contract","float_nchw_rgb_minus1_1"},{"hbm_sha256",sha.str()},
    {"inputs",json::array({{{"name","input"},{"shape",{1,3,256,256}}}})},
    {"outputs",json::array({{{"name","output"},{"shape",{1,3,256,256}}}})}};
  auto write=[&](const json& m){std::ofstream file(sidecar);file<<m;};
  write(valid);
  // Only metadata is validated. This fixture is deliberately not loaded.
  EXPECT_EQ(ValidateFaceEnhanceBpuManifest("gpen",path),valid);
  auto bad=valid;bad["hbm_sha256"]=std::string(64,'0');write(bad);
  EXPECT_THROW(ValidateFaceEnhanceBpuManifest("gpen",path),std::runtime_error);
  bad=valid;bad["input_contract"]="nv12_bt709";write(bad);
  EXPECT_THROW(ValidateFaceEnhanceBpuManifest("gpen",path),std::runtime_error);
  bad=valid;bad["outputs"][0]["shape"]={1,256,256,3};write(bad);
  EXPECT_THROW(ValidateFaceEnhanceBpuManifest("gpen",path),std::runtime_error);
  bad=valid;bad["inputs"].push_back({{"name","fidelity"},{"shape",{1}}});write(bad);
  EXPECT_THROW(ValidateFaceEnhanceBpuManifest("gpen",path),std::runtime_error);
  write(valid);
  EXPECT_THROW(ValidateFaceEnhanceBpuManifest("codeformer",path),std::runtime_error);
  RecordProperty("model_inference_verified","false");
}
TEST(BpuFaceRestore, RegisteredBackendKeepsBoundedCacheAndResolvesModelRoot){
  using namespace ai_service::output;
  const auto root=std::filesystem::temp_directory_path()/
    ("ainvr-face-root-"+std::to_string(getpid()));
  RegisterFaceEnhancerBpu(root);
  auto first=GetFaceEnhancer("gpen","one.hbm");
  EXPECT_EQ(first,GetFaceEnhancer("gpen","./one.hbm"));
  EXPECT_EQ(first,GetFaceEnhancer("gpen",(root/"one.hbm").string()));
  EXPECT_NE(first,GetFaceEnhancer("gpen","two.hbm"));
  EXPECT_NE(first,GetFaceEnhancer("codeformer","one.hbm"));
  EXPECT_THROW(first->EnsureLoaded(),std::runtime_error);
  EXPECT_THROW(RegisterFaceEnhancerBpu(root),std::logic_error);
}
