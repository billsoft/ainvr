#include "index_discovery.hpp"
#include <iostream>
using namespace ainvr::search;
using namespace std::chrono_literals;
int checks=0;
void Check(bool ok) { ++checks; if(!ok)throw std::runtime_error("discovery_contract_failed"); }
template<class F> void Reject(F f) { bool rejected=false;try{f();}catch(...){rejected=true;}Check(rejected); }
int main(){try{
  const std::string a="00000000-0000-4000-8000-000000000001",b="00000000-0000-4000-8000-000000000002";
  std::chrono::steady_clock::time_point now{};
  const auto clock=[&]{return now;};
  {   // A failed refresh keeps its watermark pending; the validated page is not read again.
    HistoryIndexChanges page{{{a,0,1},{a,86399999,2},{b,86400000,3}},3};
    std::vector<std::string> writes; bool fail=true; int scans=0;
    IndexDiscovery discovery({a,b},[&](int64_t after,size_t limit){++scans;Check(limit==32);return after==0?page:HistoryIndexChanges{{},after};},
      [&](const auto& ch,const auto& day,int64_t minimum){writes.push_back(ch+day+std::to_string(minimum));if(ch==b&&fail)throw std::runtime_error("unknown_ack");},
      {},clock);
    Reject([&]{discovery.Step();}); Check(discovery.Checkpoint()==3 && writes.size()==2 && discovery.Pending()==1);
    fail=false; Check(!discovery.Step()); Check(scans==2 && writes.size()==3 && writes[2]==writes[1] && discovery.Pending()==0);
    Check(writes[0]==a+"1970-01-01"+"2" && writes[1]==b+"1970-01-02"+"3");
  }
  {   // A shard being written is refreshed at once, then at most once per interval, always with its newest ordinal.
    int64_t newest=0; std::vector<int64_t> refreshed;
    IndexDiscovery live({a},[&](int64_t after,size_t){
        HistoryIndexChanges out{{},after};
        for(int64_t o=after+1;o<=newest;++o){out.items.push_back({a,1000,o});}
        if(!out.items.empty()){out.checkpoint=newest;}
        return out;},
      [&](const auto&,const auto&,int64_t minimum){refreshed.push_back(minimum);},{600s,1800s},clock);
    newest=1; live.Step(); Check(refreshed==std::vector<int64_t>{1});
    for(int minute=1;minute<10;++minute){now+=60s;newest+=5;live.Step();live.Step();}
    Check(refreshed.size()==1 && live.Pending()==1);
    now+=60s; live.Step();                                  // interval elapsed, no new sample needed
    Check(refreshed.size()==2 && refreshed[1]==newest && live.Pending()==0);
    now+=600s; Check(!live.Step()); Check(refreshed.size()==2); // nothing new: nothing sent
  }
  {   // Caught up, the cursor stays; a full pass from 0 runs once per interval and finds a late lower ordinal.
    now={}; std::vector<int64_t> asked; std::vector<HistoryIndexChange> rows{{a,1000,1},{a,1000,2}};
    IndexDiscovery cursor({a},[&](int64_t after,size_t){asked.push_back(after);HistoryIndexChanges out{{},after};
        for(const auto& r:rows){if(r.ordinal>after){out.items.push_back(r);out.checkpoint=r.ordinal;}}
        return out;},
      [](const auto&,const auto&,auto){},{0s,1800s},clock);
    Check(cursor.Step() && cursor.Checkpoint()==2);
    Check(!cursor.Step() && cursor.Checkpoint()==2);
    now+=600s; Check(!cursor.Step() && cursor.Checkpoint()==2);
    now+=1200s; Check(!cursor.Step() && cursor.Checkpoint()==0);   // full pass scheduled
    Check(cursor.Step() && cursor.Checkpoint()==2);
    Check(asked==std::vector<int64_t>({0,2,2,2,0}));
  }
  {   // Deleted rows advance the cursor without a refresh.
    HistoryIndexChanges page{{},5}; int64_t asked=-1;
    IndexDiscovery deleted({a},[&](int64_t after,size_t){asked=after;return after<5?page:HistoryIndexChanges{{},5};},
      [](const auto&,const auto&,auto){throw std::logic_error("no_hidden_write");},{},clock);
    Check(deleted.Step() && deleted.Checkpoint()==5 && asked==0);
    Check(!deleted.Step() && deleted.Checkpoint()==5 && asked==5);
  }
  bool cancelled=true;int scans=0;
  IndexDiscovery stopping({a},[&](int64_t,size_t){++scans;return HistoryIndexChanges{{{a,0,1}},1};},[](const auto&,const auto&,auto){},{},clock);
  Check(stopping.Step([&]{return cancelled;}) && scans==0);
  cancelled=false;Check(stopping.Step([&]{return cancelled;}) && scans==1);
  for(int scenario=0;scenario<6;++scenario){
    HistoryIndexChanges bad{{{a,0,1}},1};
    if(scenario==0)bad.checkpoint=-1;
    if(scenario==1)bad.items[0].channel=b;
    if(scenario==2)bad.items[0].ordinal=2;
    if(scenario==3)bad.items.push_back(bad.items[0]);
    if(scenario==4)bad.items.resize(33,bad.items[0]);
    if(scenario==5)bad.items[0].captured_ms=-1;
    int mutations=0;
    IndexDiscovery denied({a},[&](int64_t,size_t){return bad;},[&](const auto&,const auto&,auto){++mutations;},{},clock);
    Reject([&]{denied.Step();});Check(mutations==0 && denied.Checkpoint()==0 && denied.Pending()==0);
  }
  Reject([&]{IndexDiscovery invalid({},[](auto,auto){return HistoryIndexChanges{};},[](const auto&,const auto&,auto){});});
  Reject([&]{IndexDiscovery invalid({a},{},[](const auto&,const auto&,auto){});});
  Reject([&]{IndexDiscovery invalid({a},[](auto,auto){return HistoryIndexChanges{};},{});});
  Reject([&]{IndexDiscovery invalid({a},[](auto,auto){return HistoryIndexChanges{};},[](const auto&,const auto&,auto){},{600s,0s});});
  std::cout<<checks<<" discovery checks passed\n";
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
