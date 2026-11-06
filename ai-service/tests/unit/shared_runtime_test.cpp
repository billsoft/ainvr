#include "platform/shared_runtime.hpp"
#include <atomic>
#include <cassert>
#include <future>
#include <thread>
#include <chrono>
using namespace std::chrono_literals;
struct Resource {
 static inline std::atomic<int> alive=0,loads=0,peak=0;
 Resource(){int n=++alive;++loads;int old=peak;while(n>old&&!peak.compare_exchange_weak(old,n)){};}
 ~Resource(){std::this_thread::sleep_for(2ms);--alive;}
};
int main(){
 ainvr::SharedRuntimeCache<Resource> cache;
 auto factory=[](){return std::make_unique<Resource>();};
 std::vector<std::future<std::shared_ptr<Resource>>> work;
 for(int i=0;i<16;++i)work.push_back(std::async(std::launch::async,[&]{return cache.Acquire("same",factory);}));
 std::vector<std::shared_ptr<Resource>> owners;for(auto& f:work)owners.push_back(f.get());
 for(const auto& p:owners)assert(p==owners[0]);assert(Resource::loads==1);assert(cache.Snapshot()[0].second==16);
 auto other=cache.Acquire("different-version",factory);assert(other!=owners[0]);other.reset();owners.clear();assert(Resource::alive==0);
 // Failed initialization must not poison retries.
 bool failed=false;try{cache.Acquire("failed",[]()->std::unique_ptr<Resource>{throw 1;});}catch(...){failed=true;}assert(failed);assert(cache.Acquire("failed",factory));
 // Race the last release against a new acquisition. No overlapping model lives.
 Resource::peak=0;
 for(int i=0;i<100;++i){auto first=cache.Acquire("race",factory);auto release=std::async(std::launch::async,[p=std::move(first)]()mutable{p.reset();});auto next=cache.Acquire("race",factory);release.get();next.reset();}
 assert(Resource::peak==1);assert(Resource::alive==0);
 ainvr::FifoMutex fifo;fifo.lock();std::vector<int> order;std::vector<std::future<void>> queued;
 for(int i=0;i<8;++i){queued.push_back(std::async(std::launch::async,[&,i]{std::lock_guard<ainvr::FifoMutex> lock(fifo);order.push_back(i);}));while(fifo.Waiting()!=static_cast<unsigned>(i+2))std::this_thread::yield();}
 fifo.unlock();for(auto& f:queued)f.get();for(int i=0;i<8;++i)assert(order[i]==i);
 assert(cache.Snapshot().empty());
 auto lease=cache.Acquire("observe",factory);auto live=cache.LiveSnapshot();
 assert(live.size()==1&&live[0].second==lease);live.clear();lease.reset();
 assert(Resource::alive==0&&cache.LiveSnapshot().empty());
}
