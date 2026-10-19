#include "../../ai-service/src/analytics/event_outbox.hpp"
#include <cassert>
#include <filesystem>
#include <unistd.h>
int main(){
 char pattern[]="/home/sunrise/ainvr/test/runtime/event-outbox-XXXXXX";
 auto* directory=mkdtemp(pattern);assert(directory);
 std::string path=directory;
 using ai_service::analytics::EventOutbox;
 nlohmann::json event={{"event_id","session:crossing:1"},{"type","line_crossing"}};
 {
   EventOutbox box(path,[](const auto&){throw std::runtime_error("offline");});
   box.Submit(event);
   for(int i=0;i<100&&!box.Failures();++i)std::this_thread::sleep_for(std::chrono::milliseconds(10));
   assert(box.Failures()>0 && box.Pending()==1);
 }
 std::atomic<int> written{0};
 {
   EventOutbox box(path,[&](const auto& got){assert(got==event);++written;});
   for(int i=0;i<100&&box.Pending();++i)std::this_thread::sleep_for(std::chrono::milliseconds(10));
   assert(box.Pending()==0 && written==1);
 }

 nlohmann::json poison={{"event_id","event-a"},{"type","line_crossing"}};
 nlohmann::json good={{"event_id","event-b"},{"type","line_crossing"}};
 {
   EventOutbox box(path,[](const auto&){throw std::runtime_error("offline");});
   box.Submit(poison);box.Submit(good);
 }
 written=0;
 {
   EventOutbox box(path,[&](const auto& got){
     if(got==poison)throw std::runtime_error("record rejected");
     assert(got==good);++written;
   });
   for(int i=0;i<200&&box.Pending()!=1;++i)
     std::this_thread::sleep_for(std::chrono::milliseconds(10));
   assert(box.Pending()==1 && written==1 && box.Failures()>0);
 }
 {
   EventOutbox box(path,[&](const auto& got){assert(got==poison);++written;});
   for(int i=0;i<200&&box.Pending();++i)
     std::this_thread::sleep_for(std::chrono::milliseconds(10));
   assert(box.Pending()==0 && written==2);
 }
 std::filesystem::remove_all(path);
}
