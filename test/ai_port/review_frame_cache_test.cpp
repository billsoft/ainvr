// Software-only cache ownership test. The JPEG encoder is an explicit stub;
// this validates queue/TTL/byte admission, never image quality or hardware.
#include "../../ai-service/src/output/review_frame_cache.hpp"
#include <iostream>
#include <stdexcept>
using namespace ai_service::output;
namespace ai_service::output {
bool EncodeSnapshotRgbaJpeg(const cv::Mat&,std::vector<uint8_t>& jpeg,int){jpeg={255,216,255,217};return true;}
}
using Json=nlohmann::json;
void Check(bool ok,const char* why){if(!ok)throw std::runtime_error(why);}
struct Gate{
 std::mutex mutex;std::condition_variable cv;bool entered=false,open=false;
 void Wait(){std::unique_lock lock(mutex);entered=true;cv.notify_all();cv.wait(lock,[&]{return open;});}
 void Entered(){std::unique_lock lock(mutex);Check(cv.wait_for(lock,std::chrono::seconds(2),[&]{return entered;}),"worker did not start");}
 void Release(){std::lock_guard lock(mutex);open=true;cv.notify_all();}
 ~Gate(){Release();}
};
Json Metadata(int n,int w=64,int h=64){return {{"channel_id","test"},{"stream_session_id","s"},{"source_pts_ns",std::to_string(n)},
 {"source_frame_index",std::to_string(n)},{"frame_width",w},{"frame_height",h}};}
Json Status(const std::filesystem::path& root){Json out;std::ifstream in(root/"cache-status.json");in>>out;return out;}
void WaitWritten(const std::filesystem::path& root,size_t expected){
 const auto until=std::chrono::steady_clock::now()+std::chrono::seconds(5);
 while(std::chrono::steady_clock::now()<until){try{if(Status(root).value("written",0U)>=expected)return;}catch(...){}std::this_thread::sleep_for(std::chrono::milliseconds(20));}
}
int main(int argc,char** argv){try{
 Check(argc==3,"root and scenario required");const std::filesystem::path root=argv[1];const std::string mode=argv[2];
 Check(root.string().rfind("/mnt/ainvr-ssd/ainvr-tests/review-cache-",0)==0,"isolated test root required");
 std::filesystem::create_directories(root);setenv("AINVR_REVIEW_FRAME_ROOT",root.c_str(),1);
 std::ofstream(root/"enabled.json")<<Json{{"expires_at",std::time(nullptr)+120},{"channels",Json::array({"test"})},{"retained_keys",Json::array()}};
 Gate gate; // Must outlive the cache; release before any assertion can unwind it.
 ReviewFrameCache cache;
 struct ReleaseBeforeJoin{Gate& gate;~ReleaseBeforeJoin(){gate.Release();}}release{gate};
 Check(cache.Enabled("test"),"test policy unavailable");
 if(mode=="queue"){
  cache.Offer(Metadata(1),[&]{gate.Wait();return cv::Mat(32,32,CV_8UC4);});gate.Entered();
  for(int i=2;i<=9;++i)cache.Offer(Metadata(i),[]{return cv::Mat(32,32,CV_8UC4);});
  gate.Release();WaitWritten(root,9);
  const auto stats=Status(root);Check(stats.at("written")==9,"small frames must support eight queued jobs");Check(stats.at("dropped")==0,"small burst unexpectedly dropped");
 }else if(mode=="pixels"){
  cache.Offer(Metadata(1,8192,8192),[&]{gate.Wait();return cv::Mat(32,32,CV_8UC4);});gate.Entered();
  cache.Offer(Metadata(2,8192,8192),[]{return cv::Mat(32,32,CV_8UC4);});
  cache.Offer(Metadata(3,8192,8192),[]{return cv::Mat(32,32,CV_8UC4);});
  gate.Release();WaitWritten(root,2);std::this_thread::sleep_for(std::chrono::milliseconds(1100));
  const auto stats=Status(root);Check(stats.value("pixel_budget_dropped",0U)==1,"active NV12 bytes must count toward the 256 MiB bound");
  Check(stats.at("written")==2,"over-budget frame was retained");
 }else if(mode=="targets"){
  ai_service::FrameResult result;
  Check(!HasReviewVisualTarget(result),"empty frame must not consume a cache slot");
  result.model_extra={{"analytics",{{"status","detection_only"}}}};
  result.detections.emplace_back();
  Check(HasReviewVisualTarget(result),"non-tracking detections still need evidence");
  result.detections.clear();result.model_extra["analytics"]["tracks"]=Json::array({{{"observation","predicted"},{"event_eligible",true}}});
  Check(!HasReviewVisualTarget(result),"predicted-only frame is not visual evidence");
  result.model_extra["analytics"]["tracks"][0]["observation"]="detected";
  Check(HasReviewVisualTarget(result),"real eligible track needs evidence");
 }else if(mode=="ttl"){
  cache.Offer(Metadata(1),[]{return cv::Mat(32,32,CV_8UC4);});WaitWritten(root,1);
  size_t found=0;std::filesystem::path jpg;
  for(const auto& e:std::filesystem::directory_iterator("/dev/shm/ainvr-review-frames"))if(e.path().extension()==".jpg"){jpg=e.path();++found;}
  Check(found==1,"expected one isolated JPEG");
  std::filesystem::last_write_time(jpg,std::filesystem::file_time_type::clock::now()-std::chrono::seconds(20));
  std::this_thread::sleep_for(std::chrono::milliseconds(1300));
  Check(std::filesystem::exists(jpg),"20 second old frame must survive the new 30 second grace");
 }else throw std::runtime_error("unknown scenario");
 std::cout<<mode<<" software cache check passed\n";
 }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
