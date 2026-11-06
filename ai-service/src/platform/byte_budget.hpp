#pragma once
#include <charconv>
#include <algorithm>
#include <cstdlib>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>
namespace ainvr {
class MemoryBudgetExceeded:public std::runtime_error {
 public:explicit MemoryBudgetExceeded(const std::string& message):std::runtime_error(message){}
};
inline uint64_t MemorySetting(const char* name,uint64_t fallback){
 const char* raw=std::getenv(name);if(!raw)return fallback;
 std::string value(raw);uint64_t mib=0;
 auto [end,ec]=std::from_chars(value.data(),value.data()+value.size(),mib);
 if(ec!=std::errc{}||end!=value.data()+value.size()||mib<1||mib>65536)
   throw std::invalid_argument(std::string(name)+" must be an integer MiB value in [1,65536]");
 return mib<<20;
}
class ByteBudget {
 struct State {std::mutex mutex;uint64_t limit,used=0,peak=0,rejected=0,next=0;
   std::map<uint64_t,std::pair<std::string,uint64_t>> entries;explicit State(uint64_t n):limit(n){}};
 public:
 class Ticket {
  friend class ByteBudget;
  std::shared_ptr<State> state_;uint64_t id_,bytes_;bool armed_=false;
  Ticket(std::shared_ptr<State> s,uint64_t id,uint64_t bytes):state_(std::move(s)),id_(id),bytes_(bytes){}
 public:
  ~Ticket(){if(!armed_)return;std::lock_guard lock(state_->mutex);state_->used-=bytes_;state_->entries.erase(id_);}
  Ticket(const Ticket&)=delete;Ticket& operator=(const Ticket&)=delete;
  uint64_t Bytes()const{return bytes_;}
 };
 struct Entry{std::string owner;uint64_t bytes;};
 struct Stats{uint64_t limit,reserved,peak,rejected;std::vector<Entry> entries;};
 explicit ByteBudget(uint64_t limit):state_(std::make_shared<State>(limit)){}
 std::shared_ptr<Ticket> Acquire(uint64_t bytes,const std::string& owner){
  std::lock_guard lock(state_->mutex);
  if(bytes==0||bytes>state_->limit-state_->used){++state_->rejected;
    throw MemoryBudgetExceeded("编码缓冲内存额度不足：申请 "+std::to_string(bytes)+"，已预留 "+std::to_string(state_->used)+"，预算 "+std::to_string(state_->limit)+" 字节；请停用不需要的AI输出或调整部署预算");}
  const auto id=++state_->next;
  // Allocate control block before publishing reservation; failures leave no charge.
  auto ticket=std::shared_ptr<Ticket>(new Ticket(state_,id,bytes));
  state_->entries.emplace(id,std::make_pair(owner,bytes));
  state_->used+=bytes;ticket->armed_=true;state_->peak=std::max(state_->peak,state_->used);return ticket;
 }
 Stats Snapshot()const{std::lock_guard lock(state_->mutex);Stats s{state_->limit,state_->used,state_->peak,state_->rejected,{}};
  for(const auto& [id,e]:state_->entries)s.entries.push_back({e.first,e.second});return s;}
 private:std::shared_ptr<State> state_;
};
inline ByteBudget& EncodedBudget(){static ByteBudget pool(MemorySetting("AINVR_AI_AU_TOTAL_MIB",384ULL<<20));return pool;}
inline uint64_t EncodedChannelLimit(){static auto value=MemorySetting("AINVR_AI_AU_CHANNEL_MIB",96ULL<<20);return value;}
inline uint64_t ActiveChannelLimit(){
 static const auto count=[](){const auto n=MemorySetting("AINVR_AI_ACTIVE_CHANNELS",8ULL<<20)>>20;
   if(n>64)throw std::invalid_argument("AINVR_AI_ACTIVE_CHANNELS must be in [1,64]");return n;}();return count;
}
inline ByteBudget& ActiveChannels(){static ByteBudget pool(ActiveChannelLimit());return pool;}
inline std::shared_ptr<ByteBudget::Ticket> AcquireChannelSlot(const std::string& owner){
 try{return ActiveChannels().Acquire(1,owner);}catch(const MemoryBudgetExceeded&){
  throw MemoryBudgetExceeded("活动AI通道名额不足：部署上限 "+std::to_string(ActiveChannelLimit())+"；已有通道可能仍在收尾，请停用不需要的通道或调整经验证的容量档");
 }
}
inline uint64_t EncodedReservation(const std::string& adapter){return adapter=="locateanything_trt"?768ULL<<20:EncodedChannelLimit();}
}
