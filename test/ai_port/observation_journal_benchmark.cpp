// AINVR. Bounded SSD-only benchmark; no models, hardware capture or live config.
#include "../../ai-service/src/analytics/observation_journal.hpp"
#include <chrono>
#include <algorithm>
#include <iostream>
#include <vector>
using ai_service::analytics::ObservationJournal;
using Clock=std::chrono::steady_clock;
nlohmann::json summary(std::vector<double> v){
 std::sort(v.begin(),v.end());double sum=0;for(auto x:v)sum+=x;
 return {{"samples",v.size()},{"mean_ms",sum/v.size()},{"p50_ms",v[v.size()/2]},
 {"p95_ms",v[std::min(v.size()-1,v.size()*95/100)]},{"max_ms",v.back()}};
}
int main(int argc,char**argv){
 if(argc!=2) return 2;
 const std::filesystem::path root=argv[1];
 if(root.string().find("/mnt/ainvr-ssd/ainvr-alarm-journal-benchmark-")!=0)return 3;
 ai_service::FrameResult r;r.channel_id="benchmark";r.stream_url="rtmp://127.0.0.1/live/test";
 r.frame_width=3840;r.frame_height=2160;r.model_name="coco";r.timestamp=1792414800;
 nlohmann::json labels=nlohmann::json::array(),tracks=nlohmann::json::array();
 for(int i=0;i<80;i++)labels.push_back({{"class_id",i},{"label_id","class:"+std::to_string(i)},{"name","category"+std::to_string(i)},{"description",""}});
 for(int i=0;i<10;i++)tracks.push_back({{"track_id","s:"+std::to_string(i)},{"label_id","class:0"},{"state","confirmed"},{"observation","detected"},{"last_observed_pts_ns","1234567890123456"},{"bbox",{{"x",100},{"y",200},{"w",80},{"h",100}}}});
 r.model_extra={{"label_catalog",{{"schema_version","1.0"},{"adapter","test"},{"labels",labels}}},
 {"analytics",{{"status","active"},{"stream_session_id","bench"},{"tracks",tracks}}}};
 std::vector<double> empty,late,rejected;
 auto measure=[&](ObservationJournal&j,std::vector<double>&values,bool reject){
  for(int i=0;i<20;i++){
   r.frame_index=i;r.frame_pts_ns=1234567890123456LL+i*100000000;
   const auto start=Clock::now();
   bool failed=false;try{j.Stage(r);}catch(const std::exception&e){if(std::string(e.what())!="Observation journal full")throw;failed=true;}
   if(failed!=reject)throw std::runtime_error("Unexpected quota result");
   values.push_back(std::chrono::duration<double,std::milli>(Clock::now()-start).count());
   if(&values==&empty){
    const auto offset=std::stoull(j.Status().at("next_offset").get<std::string>())-1;
    std::ostringstream n;n<<std::setw(20)<<std::setfill('0')<<offset<<".json";
    std::filesystem::remove(root.string()+"-empty-v2/"+ObservationJournal::Hash(r.channel_id)+"/"+n.str());
   }
  }
 };
 {ObservationJournal j(root.string()+"-empty-v2",r.channel_id);std::cerr<<"empty started"<<std::endl;measure(j,empty,false);std::cerr<<"empty "<<summary(empty).dump()<<std::endl;}
 {ObservationJournal j(root.string(),r.channel_id);std::cerr<<"backlog started"<<std::endl;measure(j,late,false);std::cerr<<"backlog "<<summary(late).dump()<<std::endl;}
 {ObservationJournal j(root.string(),r.channel_id,64*1024*1024,1);std::cerr<<"full started"<<std::endl;measure(j,rejected,true);std::cerr<<"full "<<summary(rejected).dump()<<std::endl;}
 std::cout<<nlohmann::json({{"empty_queue",summary(empty)},{"backlogged_queue",summary(late)},
 {"full_rejection",summary(rejected)},{"synthetic_model_classes",80},{"tracks_per_frame",10},
 {"note","Backlog prepared by bounded prior fill; empty queue unlinks after each measured Stage. No live channel involved."}}).dump(2)<<"\n";
}
