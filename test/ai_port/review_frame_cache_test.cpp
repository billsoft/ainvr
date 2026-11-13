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
 std::ofstream(root/"enabled.json")<<Json{{"expires_at",std::time(nullptr)+120},{"channels",Json::array({"test"})},{"region_channels",mode=="region"?Json::array({"test"}):Json::array()},{"retained_keys",Json::array()}};
 Gate gate; // Must outlive the cache; release before any assertion can unwind it.
 ReviewFrameCache cache;
 struct ReleaseBeforeJoin{Gate& gate;~ReleaseBeforeJoin(){gate.Release();}}release{gate};
 Check(cache.Enabled("test"),"test policy unavailable");
 if(mode=="queue"){
  cache.OfferAsync(Metadata(1),[&]{gate.Wait();return cv::Mat(32,32,CV_8UC4);});gate.Entered();
  for(int i=2;i<=97;++i)cache.OfferAsync(Metadata(i),[]{return cv::Mat(32,32,CV_8UC4);});
  auto rejected=cache.OfferAsync(Metadata(98),[]{return cv::Mat(32,32,CV_8UC4);});
  Check(rejected.wait_for(std::chrono::milliseconds(0))==std::future_status::ready&&!rejected.get(),"full queue must reject without blocking");
  gate.Release();WaitWritten(root,97);
  const auto stats=Status(root);Check(stats.at("written")==97,"small frames must support 96 queued jobs");Check(stats.at("queue_full_dropped")==1,"queue overflow not accounted");
 }else if(mode=="backpressure"){
  auto first=cache.OfferAsync(Metadata(1),[&]{gate.Wait();return cv::Mat(32,32,CV_8UC4);});gate.Entered();
  for(int i=2;i<=97;++i)cache.OfferAsync(Metadata(i),[]{return cv::Mat(32,32,CV_8UC4);});
  std::atomic<bool> cancel{false};
  auto stopped=std::async(std::launch::async,[&]{return cache.OfferAsync(Metadata(98),[]{return cv::Mat(32,32,CV_8UC4);},0,[&]{return cancel.load();}).get();});
  Check(stopped.wait_for(std::chrono::milliseconds(50))==std::future_status::timeout,"saturated required evidence did not wait");
  cancel=true;Check(stopped.wait_for(std::chrono::seconds(1))==std::future_status::ready&&!stopped.get(),"stop did not interrupt admission");
  auto admitted=std::async(std::launch::async,[&]{return cache.OfferAsync(Metadata(99),[]{return cv::Mat(32,32,CV_8UC4);},0,[]{return false;}).get();});
  Check(admitted.wait_for(std::chrono::milliseconds(50))==std::future_status::timeout,"saturated admission exceeded capacity");
  gate.Release();Check(first.get()&&admitted.get(),"backpressured frame was lost");
  WaitWritten(root,98);Check(Status(root).at("dropped")==0,"required backpressure dropped evidence");
 }else if(mode=="pixels"){
  cache.OfferAsync(Metadata(1,8192,8192),[&]{gate.Wait();return cv::Mat(32,32,CV_8UC4);});gate.Entered();
  cache.OfferAsync(Metadata(2,8192,8192),[]{return cv::Mat(32,32,CV_8UC4);});
  cache.OfferAsync(Metadata(3,8192,8192),[]{return cv::Mat(32,32,CV_8UC4);});
  gate.Release();WaitWritten(root,2);std::this_thread::sleep_for(std::chrono::milliseconds(1100));
  const auto stats=Status(root);Check(stats.value("pixel_budget_dropped",0U)==1,"active NV12 bytes must count toward the 256 MiB bound");
  Check(stats.at("written")==2,"over-budget frame was retained");
 }else if(mode=="receipts"){
  auto pending=cache.OfferAsync(Metadata(1),[&]{gate.Wait();return cv::Mat(32,32,CV_8UC4);});gate.Entered();
  Check(pending.wait_for(std::chrono::milliseconds(0))==std::future_status::timeout,"admitted is not durable");
  gate.Release();Check(pending.get(),"durable receipt missing");
  size_t jpg=0,meta=0;
  for(const auto& e:std::filesystem::directory_iterator(root/"raw")){jpg+=e.path().extension()==".jpg";meta+=e.path().extension()==".json";}
  Check(jpg==1&&meta==1,"receipt preceded evidence pair");
  Check(!cache.OfferAsync(Metadata(2),[]()->cv::Mat{throw std::runtime_error("render failure");}).get(),"render failure claimed durable");
  Check(cache.OfferAsync(Metadata(3),[]{return cv::Mat(32,32,CV_8UC4);}).get(),"worker did not recover");
  Check(!cache.OfferAsync(Metadata(4,63,64),[]{return cv::Mat(32,32,CV_8UC4);}).get(),"invalid geometry admitted");
 }else if(mode=="shutdown"){
  // A second isolated cache owns these receipts; its destructor drains them.
  const auto child=root/"drain";setenv("AINVR_REVIEW_FRAME_ROOT",child.c_str(),1);
  std::vector<std::shared_future<bool>> receipts;
  {ReviewFrameCache draining;for(int i=0;i<5;++i)receipts.push_back(draining.OfferAsync(Metadata(i),[]{std::this_thread::sleep_for(std::chrono::milliseconds(10));return cv::Mat(32,32,CV_8UC4);}));}
  for(auto& receipt:receipts)Check(receipt.get(),"shutdown discarded accepted evidence");
 }else if(mode=="encoded"){
  auto receipt=cache.OfferPreparedAsync(Metadata(101),[&]{gate.Wait();return ReviewEncodedFrame{{255,216,255,217},48,32};});
  gate.Entered();Check(receipt.wait_for(std::chrono::milliseconds(0))==std::future_status::timeout,"prepared input claimed durable before storage");gate.Release();Check(receipt.get(),"prepared image not durably persisted");
  size_t found=0;for(const auto& f:std::filesystem::directory_iterator(root/"raw"))if(f.path().extension()==".json"){Json m;std::ifstream in(f.path());in>>m;Check(m.at("image_width")==48&&m.at("image_height")==32&&m.at("bytes")==4&&m.at("sha256").get<std::string>().size()==64,"prepared dimensions/hash changed");++found;}
  Check(found==1,"prepared image metadata missing");
  Check(!cache.OfferPreparedAsync(Metadata(102),[]{return ReviewEncodedFrame{{1,2,3,4},48,32};}).get(),"non-JPEG prepared bytes admitted");
 }else if(mode=="persist_failure"){
  const std::string identity="test\ns\n1\n1";unsigned char digest[SHA256_DIGEST_LENGTH];SHA256(reinterpret_cast<const unsigned char*>(identity.data()),identity.size(),digest);std::string key;for(auto byte:digest){key+="0123456789abcdef"[byte>>4];key+="0123456789abcdef"[byte&15];}
  const auto blocked=root/"raw"/(key+".json.tmp");std::filesystem::create_directory(blocked);
  Check(!cache.OfferAsync(Metadata(1),[]{return cv::Mat(32,32,CV_8UC4);}).get(),"failed metadata write claimed complete evidence");
  Check(!std::filesystem::exists(root/"raw"/(key+".jpg")),"published JPEG before staging metadata");
  Check(std::filesystem::is_directory(blocked),"cleanup removed a path it did not open");std::filesystem::remove(blocked);
  Check(cache.OfferAsync(Metadata(2),[]{return cv::Mat(32,32,CV_8UC4);}).get(),"write failure blocked later receipts");
 }else if(mode=="region"){
  ai_service::FrameResult empty;
  empty.model_extra={{"analytics",{{"status","active"},{"tracks",Json::array()},{"stream_session_id","s"}}}};
  Check(!HasReviewVisualTarget(empty),"empty scene unexpectedly contains a target");
  Check(cache.NeedsFrame("test",empty),"armed region must preserve empty scene evidence");
  Check(!cache.NeedsFrame("unarmed",empty),"unarmed channel must retain target-only policy");
  const auto receipt=cache.OfferPreparedAsync(Metadata(501),[]{return ReviewEncodedFrame{{255,216,255,217},64,64};});
  Check(receipt.get(),"empty region scene did not become durable");
  size_t frames=0;
  for(const auto& file:std::filesystem::directory_iterator(root/"raw"))if(file.path().extension()==".json"){
   Json meta;std::ifstream(file.path())>>meta;
   Check(meta.at("source_frame_index")=="501"&&meta.at("source_pts_ns")=="501","empty scene lost frame identity");++frames;
  }
  Check(frames==1,"empty scene evidence metadata missing");
  const auto replacement=root/"enabled.json.next";
  std::ofstream(replacement)<<Json{{"expires_at",std::time(nullptr)+120},{"channels",Json::array({"test"})},{"region_channels",Json::array()}};
  std::filesystem::rename(replacement,root/"enabled.json");
  const auto until=std::chrono::steady_clock::now()+std::chrono::seconds(4);
  while(cache.NeedsFrame("test",empty)&&std::chrono::steady_clock::now()<until)std::this_thread::sleep_for(std::chrono::milliseconds(50));
  Check(!cache.NeedsFrame("test",empty),"removing region rules must stop empty scene capture");
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
  cache.OfferAsync(Metadata(1),[]{return cv::Mat(32,32,CV_8UC4);});WaitWritten(root,1);
  size_t found=0;std::filesystem::path jpg;
  for(const auto& e:std::filesystem::directory_iterator(root/"raw"))if(e.path().extension()==".jpg"){jpg=e.path();++found;}
  Check(found==1,"expected one isolated JPEG");
  std::filesystem::last_write_time(jpg,std::filesystem::file_time_type::clock::now()-std::chrono::seconds(20));
  std::this_thread::sleep_for(std::chrono::milliseconds(1300));
  Check(std::filesystem::exists(jpg),"unacknowledged frame must survive");
  auto ack=jpg;ack.replace_extension(".ack");std::ofstream(ack)<<"{}";
  std::filesystem::last_write_time(ack,std::filesystem::file_time_type::clock::now()-std::chrono::seconds(60));
  auto pin=jpg;pin.replace_extension(".test.pin");std::ofstream(pin)<<"{}";
  std::this_thread::sleep_for(std::chrono::milliseconds(1300));
  Check(std::filesystem::exists(jpg),"pinned acknowledged frame was evicted");
  std::filesystem::remove(pin);std::this_thread::sleep_for(std::chrono::milliseconds(1300));
  Check(!std::filesystem::exists(jpg),"expired acknowledged frame was never reclaimed");
 }else if(mode=="full_spool"){
  // Unacknowledged evidence never expires, so a saturated spool must reject
  // quickly: no per-job directory rescan and no JPEG encode that cannot be stored.
  // Sparse files make 2.4 GiB of apparent size without writing data.
  for(int i=0;i<3;++i){
   std::string key(64,char('a'+i));
   const auto jpg=root/"raw"/(key+".jpg");{std::ofstream(jpg)<<"x";}
   std::filesystem::resize_file(jpg,800ULL*1024*1024);
   std::ofstream(root/"raw"/(key+".json"))<<"{}";
  }
  std::atomic<int> renders{0};
  const auto started=std::chrono::steady_clock::now();
  for(int i=1;i<=40;++i)
   Check(!cache.OfferAsync(Metadata(i),[&]{++renders;return cv::Mat(32,32,CV_8UC4);}).get(),"full spool accepted evidence");
  const auto elapsed=std::chrono::duration<double>(std::chrono::steady_clock::now()-started).count();
  std::this_thread::sleep_for(std::chrono::milliseconds(1100));
  // Status is rewritten at most once per second, after a job. One more job past
  // that window flushes the counters; poll instead of reading a stale snapshot.
  Check(!cache.OfferAsync(Metadata(41),[&]{++renders;return cv::Mat(32,32,CV_8UC4);}).get(),"full spool accepted evidence");
  Json stats;const auto until=std::chrono::steady_clock::now()+std::chrono::seconds(5);
  do{try{stats=Status(root);}catch(...){}if(stats.value("failed",0U)>=41)break;std::this_thread::sleep_for(std::chrono::milliseconds(20));}while(std::chrono::steady_clock::now()<until);
  Check(stats.value("failed",0U)>=41,"full spool rejections not accounted");
  Check(renders.load()==0,"full spool still rendered frames that cannot be stored");
  // Space freed outside this process (operator cleanup) must be reclaimed by the
  // next scan: remembered sizes follow the directory, never a stale byte total.
  for(int i=0;i<3;++i){std::string key(64,char('a'+i));std::filesystem::remove(root/"raw"/(key+".jpg"));std::filesystem::remove(root/"raw"/(key+".json"));}
  std::this_thread::sleep_for(std::chrono::milliseconds(1100));
  Check(cache.OfferAsync(Metadata(42),[]{return cv::Mat(32,32,CV_8UC4);}).get(),"freed spool space was not reclaimed");
  Check(stats.at("maintenance_scans").get<uint64_t>()<=elapsed+3,"full spool rescanned the directory per failed job");
 }else if(mode=="abandon"){
  // A durable frame whose observation record was never published has no consumer
  // that could reference or acknowledge it. It must become reclaimable (an ACK),
  // or the never-expiring spool fills with orphans.
  const auto ackOf=[&](int n){const auto m=Metadata(n);const std::string id=m.at("channel_id").get<std::string>()+"\n"+m.at("stream_session_id").get<std::string>()+"\n"+m.at("source_pts_ns").get<std::string>()+"\n"+m.at("source_frame_index").get<std::string>();
   unsigned char d[SHA256_DIGEST_LENGTH];SHA256(reinterpret_cast<const unsigned char*>(id.data()),id.size(),d);std::string k;for(auto b:d){k+="0123456789abcdef"[b>>4];k+="0123456789abcdef"[b&15];}return root/"raw"/(k+".ack");};
  auto queued=cache.OfferAsync(Metadata(1),[&]{gate.Wait();return cv::Mat(32,32,CV_8UC4);});gate.Entered();
  cache.Abandon(Metadata(1),queued);
  Check(!std::filesystem::exists(ackOf(1)),"abandon must not ACK a frame before it is durable");
  gate.Release();Check(queued.get(),"abandoned frame was not stored");
  const auto until=std::chrono::steady_clock::now()+std::chrono::seconds(2);
  while(!std::filesystem::exists(ackOf(1))&&std::chrono::steady_clock::now()<until)std::this_thread::sleep_for(std::chrono::milliseconds(10));
  Check(std::filesystem::exists(ackOf(1)),"frame abandoned while queued was never released");
  auto stored=cache.OfferAsync(Metadata(2),[]{return cv::Mat(32,32,CV_8UC4);});Check(stored.get(),"second frame not stored");
  cache.Abandon(Metadata(2),stored);
  Check(std::filesystem::exists(ackOf(2)),"frame abandoned after storage was not released");
  auto kept=cache.OfferAsync(Metadata(3),[]{return cv::Mat(32,32,CV_8UC4);});Check(kept.get(),"third frame not stored");
  Check(!std::filesystem::exists(ackOf(3)),"a published frame must wait for its consumer ACK");
  std::promise<bool> refused;refused.set_value(false);
  cache.Abandon(Metadata(4),refused.get_future().share());
  Check(!std::filesystem::exists(ackOf(4)),"a refused admission must not leave an ACK");
 }else if(mode=="batch"){
  // Frames that queued while storage was busy are committed together: their file
  // syncs run concurrently and ONE directory sync commits the batch. Per-frame
  // syncs (3 per frame on a busy SSD) capped durable evidence near 15 frames/s.
  auto first=cache.OfferAsync(Metadata(1),[&]{gate.Wait();return cv::Mat(32,32,CV_8UC4);});gate.Entered();
  std::vector<std::shared_future<bool>> rest;
  for(int i=2;i<=97;++i)rest.push_back(cache.OfferAsync(Metadata(i),[]{return cv::Mat(32,32,CV_8UC4);}));
  auto overflow=cache.OfferAsync(Metadata(98),[]{return cv::Mat(32,32,CV_8UC4);});
  Check(overflow.wait_for(std::chrono::milliseconds(0))==std::future_status::ready&&!overflow.get(),"batching must not enlarge the bounded queue");
  gate.Release();Check(first.get(),"first frame not stored");
  for(auto& r:rest)Check(r.get(),"queued frame not stored");
  WaitWritten(root,97);std::this_thread::sleep_for(std::chrono::milliseconds(1100));
  cache.OfferAsync(Metadata(99),[]{return cv::Mat(32,32,CV_8UC4);}).get();
  Json stats;const auto until=std::chrono::steady_clock::now()+std::chrono::seconds(5);
  do{try{stats=Status(root);}catch(...){}if(stats.value("written",0U)>=98)break;std::this_thread::sleep_for(std::chrono::milliseconds(20));}while(std::chrono::steady_clock::now()<until);
  Check(stats.value("written",0U)==98,"batched frames not all written");
  Check(stats.value("directory_syncs",1000U)<=4,"queued frames were not committed by a shared directory sync");
  size_t jpg=0,meta=0,tmp=0;
  for(const auto& e:std::filesystem::directory_iterator(root/"raw")){jpg+=e.path().extension()==".jpg";meta+=e.path().extension()==".json";tmp+=e.path().extension()==".tmp";}
  Check(jpg==98&&meta==98&&tmp==0,"batch left incomplete pairs or temporaries");
 }else if(mode=="stall"){
  // A storage stall (a slow fsync on a busy SSD) must be absorbed by the RAM
  // budget, not stop inference: ~4 s of 1080p evidence at 15 FPS is admitted
  // at once while the writer is blocked (.190: an 8-job bound stalled the
  // inference loop for 1-15 s and the tracker lost identities in the hole).
  auto first=cache.OfferAsync(Metadata(1,1920,1080),[&]{gate.Wait();return cv::Mat(32,32,CV_8UC4);},0,[]{return false;});gate.Entered();
  const auto t0=std::chrono::steady_clock::now();
  std::vector<std::shared_future<bool>> rest;
  for(int i=2;i<=61;++i)rest.push_back(cache.OfferAsync(Metadata(i,1920,1080),[]{return cv::Mat(32,32,CV_8UC4);},0,[]{return false;}));
  Check(std::chrono::steady_clock::now()-t0<std::chrono::milliseconds(500),"admission blocked during a storage stall within the RAM budget");
  gate.Release();Check(first.get(),"first frame not stored");
  for(auto& r:rest)Check(r.get(),"stalled frame not stored");
  WaitWritten(root,61);Check(Status(root).at("dropped")==0,"stall dropped evidence");
 }else throw std::runtime_error("unknown scenario");
 std::cout<<mode<<" software cache check passed\n";
 }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
