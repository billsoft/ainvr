// Copyright AINVR. One affine model owner, bounded one-job admission, revocable grant.
#pragma once
#include "plate_hardware.hpp"
#include "analytics/jpeg_dimensions.hpp"
#include "api/control_server.hpp"
#include <condition_variable>
#include <future>
#include <fstream>
#include <set>
#include <atomic>
#include <filesystem>
#include <openssl/evp.h>
namespace ainvr::plate {
using Json=nlohmann::json;
inline int64_t WallMs(){return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();}
inline std::string HashBytes(const std::string& bytes){unsigned char digest[32];unsigned int length=0;
 if(!EVP_Digest(bytes.data(),bytes.size(),digest,&length,EVP_sha256(),nullptr)||length!=32)throw std::runtime_error("plate_hash_failed");
 static const char hex[]="0123456789abcdef";std::string out;for(auto c:digest){out+=hex[c>>4];out+=hex[c&15];}return out;}
class Runtime {
 struct Job{Json meta;std::string jpeg;std::promise<Json> done;uint64_t epoch;};
 std::string root_;std::function<bool()> authorized_;std::mutex mutex_;std::condition_variable changed_;
 bool stopping_=false,busy_=false,ready_=false;uint64_t epoch_=0;int64_t issued_=0,expires_=0;std::atomic<int64_t> next_load_{0};
 std::set<std::string> channels_;std::string pin_;std::shared_ptr<Job> pending_;std::string error_;std::thread thread_;
 bool Valid(const Job& job){std::lock_guard lock(mutex_);return !stopping_&&authorized_()&&epoch_==job.epoch&&job.meta.at("model_pin").get<std::string>()==pin_&&expires_>WallMs()&&job.meta.at("expires_ms").get<int64_t>()>WallMs()&&channels_.contains(job.meta.at("channel_id").get<std::string>());}
 static Json Verify(const std::string& path){std::ifstream f(path+".ainvr.json");Json m=Json::parse(f);
  if(std::filesystem::file_size(path)>128*1024*1024||std::filesystem::file_size(path)!=m.at("hbm_bytes").get<uintmax_t>())throw std::runtime_error("plate_model_size_mismatch");
  std::ifstream model(path,std::ios::binary);std::string bytes((std::istreambuf_iterator<char>(model)),{});
  if(bytes.size()>128*1024*1024||HashBytes(bytes)!=m.at("hbm_sha256").get<std::string>())throw std::runtime_error("plate_model_hash_mismatch");return m;}
 void Loop(){std::unique_ptr<Hardware> hardware;std::string loaded_pin;
  for(;;){std::shared_ptr<Job> job;bool wanted;std::string pin;
   {std::unique_lock lock(mutex_);changed_.wait_for(lock,std::chrono::milliseconds(200));if(stopping_)break;
    pin=pin_;wanted=authorized_()&&!channels_.empty()&&expires_>WallMs();job=std::move(pending_);}
   if(!wanted||pin!=loaded_pin){hardware.reset();std::lock_guard lock(mutex_);ready_=false;}
   if(wanted&&!hardware&&WallMs()>=next_load_){try{
     const auto detect=root_+"/models/derived/s100p/plate-detect-yolo26s.hbm",recog=root_+"/models/derived/s100p/plate-recog-color.hbm";
     auto detection=Verify(detect);auto manifest=Verify(recog);if(HashBytes(detection.at("hbm_sha256").get<std::string>()+"|"+manifest.at("hbm_sha256").get<std::string>())!=pin)throw std::runtime_error("plate_model_pin_mismatch");hardware=std::make_unique<Hardware>(detect,recog,Utf8Symbols(manifest.at("charset")));
     loaded_pin=pin;std::lock_guard lock(mutex_);ready_=true;error_.clear();
    }catch(...){hardware.reset();next_load_=WallMs()+30000;std::lock_guard lock(mutex_);ready_=false;error_="model_unavailable";}}
   if(!job)continue;
   try{if(!hardware||!Valid(*job))throw std::runtime_error("vehicle_runtime_unavailable");
    std::vector<uint8_t> jpeg(job->jpeg.begin(),job->jpeg.end());auto [w,h]=ai_service::analytics::JpegDimensions(jpeg);
    if(w%2||h%2||w<16||h<16||size_t(w)*h>8*1024*1024)throw std::invalid_argument("unsupported_image");
    const auto roi=job->meta.at("vehicle_roi").get<std::array<int,4>>();
    VpuDecoder decoder(Codec::Jpeg,w,h);while(!decoder.Submit(jpeg,0,50))if(!Valid(*job))throw std::runtime_error("expired");
    std::optional<Nv12Frame> frame;while(!frame){if(!Valid(*job))throw std::runtime_error("expired");frame=decoder.Receive(50);}
    auto result=hardware->Run(*frame,[&]{return Valid(*job);},roi);if(!Valid(*job))throw std::runtime_error("expired");
    result["model_pin"]=loaded_pin;result["request"]=job->meta;result["preprocessing_version"]="plate-jpu-gles-quad-bgr-v1";job->done.set_value(std::move(result));
   }catch(...){job->done.set_exception(std::current_exception());}
   {std::lock_guard lock(mutex_);busy_=false;}
  }
  hardware.reset();
 }
 public:
 Runtime(std::string root,std::function<bool()> authorized):root_(std::move(root)),authorized_(std::move(authorized)),thread_([this]{Loop();}){}
 ~Runtime(){{std::lock_guard lock(mutex_);stopping_=true;if(pending_){pending_->done.set_exception(std::make_exception_ptr(std::runtime_error("stopping")));pending_.reset();}}changed_.notify_all();thread_.join();}
 Json Call(const Json& input,const std::string& jpeg){using ai_service::api::ApiError;
  const auto action=input.at("action").get<std::string>();
  if(action=="configure"){
   const auto issued=input.at("issued_ms").get<int64_t>(),expires=input.at("expires_ms").get<int64_t>(),now=WallMs();
   const auto channels=input.at("channels").get<std::set<std::string>>();const auto pin=input.at("model_pin").get<std::string>();
   if(pin.size()!=64)throw ApiError(422,"invalid_vehicle_model","车型契约无效");
   if(channels.size()>32||issued>now+5000||issued<now-60000||expires<=now||expires>now+60000)throw ApiError(422,"invalid_vehicle_grant","车辆授权范围无效");
   for(const auto& id:channels)if(id.empty()||id.size()>128)throw ApiError(422,"invalid_vehicle_channel","车辆通道无效");
   {std::lock_guard lock(mutex_);if(issued<issued_)throw ApiError(409,"stale_vehicle_grant","车辆配置已变化");issued_=issued;expires_=expires;if(channels!=channels_||pin!=pin_){++epoch_;channels_=channels;pin_=pin;next_load_=0;}}
   changed_.notify_all();
  }
  if(action=="status"||action=="configure"){std::lock_guard lock(mutex_);return {{"implemented",true},{"ready",ready_&&expires_>WallMs()&&authorized_()},
   {"configured_channels",channels_},{"busy",busy_},{"error",error_},{"expires_ms",expires_},{"accuracy_verified",false}};}
  if(action!="recognize"||!authorized_())throw ApiError(403,"vehicle_not_authorized","车牌识别未授权");
  const auto now=WallMs(),expires=input.at("expires_ms").get<int64_t>();
  if(expires<=now||expires>now+30000||jpeg.size()<4||jpeg.size()>8*1024*1024||HashBytes(jpeg)!=input.at("jpeg_sha256").get<std::string>())throw ApiError(422,"invalid_vehicle_image","车牌图像或有效期无效");
  auto job=std::make_shared<Job>();job->meta=input;job->jpeg=jpeg;auto future=job->done.get_future();
  {std::lock_guard lock(mutex_);if(stopping_||!ready_||expires_<=now||!channels_.contains(input.at("channel_id").get<std::string>()))throw ApiError(503,"vehicle_not_ready","车牌识别尚未就绪");
   if(busy_)throw ApiError(429,"vehicle_busy","车牌识别忙");busy_=true;job->epoch=epoch_;pending_=job;}
  changed_.notify_all();if(future.wait_for(std::chrono::milliseconds(expires-now+1000))!=std::future_status::ready)throw ApiError(504,"vehicle_timeout","车牌识别超时");
  try{return future.get();}catch(...){throw ApiError(503,"vehicle_inference_failed","车牌识别失败，保留通行记录");}
 }
};
}
