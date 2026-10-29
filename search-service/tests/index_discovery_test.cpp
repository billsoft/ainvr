#include "index_discovery.hpp"
#include <iostream>
using namespace ainvr::search;
int checks=0;
void Check(bool ok) { ++checks; if(!ok)throw std::runtime_error("discovery_contract_failed"); }
template<class F> void Reject(F f) { bool rejected=false;try{f();}catch(...){rejected=true;}Check(rejected); }
int main(){try{
  const std::string a="00000000-0000-4000-8000-000000000001",b="00000000-0000-4000-8000-000000000002";
  HistoryIndexChanges page{{{a,0,1},{a,86399999,2},{b,86400000,3}},3};
  std::vector<std::string> writes; bool fail=true;
  IndexDiscovery discovery({a,b},[&](int64_t after,size_t limit){Check(after==0);Check(limit==32);return page;},
    [&](const auto& ch,const auto& day,int64_t minimum){writes.push_back(ch+day+std::to_string(minimum));if(ch==b&&fail)throw std::runtime_error("unknown_ack");});
  Reject([&]{discovery.Step();}); Check(discovery.Checkpoint()==0 && writes.size()==2);
  fail=false; Check(discovery.Step()); Check(discovery.Checkpoint()==3 && writes.size()==4 && writes[0]==writes[2] && writes[1]==writes[3]);
  Check(writes[0]==a+"1970-01-01"+"2" && writes[1]==b+"1970-01-02"+"3");
  page={{},5}; int64_t asked=-1;
  IndexDiscovery deleted({a},[&](int64_t after,size_t){asked=after;return page;},[](const auto&,const auto&,auto){throw std::logic_error("no_hidden_write");});
  Check(deleted.Step() && deleted.Checkpoint()==5 && asked==0);
  Check(!deleted.Step() && deleted.Checkpoint()==0 && asked==5);
  bool cancelled=true;int scans=0;
  IndexDiscovery stopping({a},[&](int64_t,size_t){++scans;return HistoryIndexChanges{{{a,0,1}},1};},[](const auto&,const auto&,auto){});
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
    IndexDiscovery denied({a},[&](int64_t,size_t){return bad;},[&](const auto&,const auto&,auto){++mutations;});
    Reject([&]{denied.Step();});Check(mutations==0 && denied.Checkpoint()==0);
  }
  Reject([&]{IndexDiscovery invalid({},[](auto,auto){return HistoryIndexChanges{};},[](const auto&,const auto&,auto){});});
  Reject([&]{IndexDiscovery invalid({a},{},[](const auto&,const auto&,auto){});});
  Reject([&]{IndexDiscovery invalid({a},[](auto,auto){return HistoryIndexChanges{};},{});});
  std::cout<<checks<<" discovery checks passed\n";
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
