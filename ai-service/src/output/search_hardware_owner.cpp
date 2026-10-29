#include "output/search_hardware_owner.hpp"
#include "analytics/jpeg_dimensions.hpp"
#include <atomic>
#include <algorithm>
#include <future>
#include <mutex>
namespace ai_service::output {
namespace {
using Pin=ainvr::search::RuntimeModelPin;
bool PinAllowsSpace(const std::optional<Pin>& pin,const SearchEmbeddingSpace& space){
  return !pin||(pin->package_id==space.package_id&&pin->model_version==space.model_version);
}
bool ReencodeDimensions(int width,int height){
  return width>=16&&height>=16&&width<=8192&&height<=8192&&width%2==0&&height%2==0&&
    size_t(width)*size_t(height)<=kSearchReencodeMaxPixels;
}
bool ReencodeEmbedding(std::span<const float> embedding){
  if(embedding.empty()||embedding.size()>4096)return false;
  double sum=0;for(const float value:embedding){if(!std::isfinite(value))return false;sum+=double(value)*value;}
  return std::isfinite(sum)&&std::abs(sum-1)<.01;
}
}
struct SearchHardwareOwner::Impl {
  explicit Impl(Factory f,Clock c):factory(std::move(f)),clock(c?std::move(c):Clock([]{return std::chrono::steady_clock::now();})) {}
  explicit Impl(PinnedFactory f,Clock c):pinned_factory(std::move(f)),clock(c?std::move(c):Clock([]{return std::chrono::steady_clock::now();})) {}
  Factory factory;
  PinnedFactory pinned_factory;
  Clock clock;
  ArchiveExecutor affine{1,1};
  mutable std::mutex mutex;
  std::mutex shutdown;
  bool stopped=false;
  uint64_t epoch=1;
  std::optional<config::SearchProducerLease> desired;
  std::string package,loaded;
  std::optional<Pin> expected;
  std::optional<SearchEmbeddingSpace> space;
  std::function<bool()> healthy;
  State state=State::Disabled;
  std::chrono::steady_clock::time_point retry{};
  std::optional<std::future<void>> refresh;
  std::optional<std::future<void>> maintenance;
  std::atomic<bool> reencoding{false};
  std::atomic<size_t> realtime_waiters{0};
  // Expiry mirror is mutex protected. Cache/model itself is affine-only.
  std::optional<std::chrono::steady_clock::time_point> reencode_expiry;
  // Access ONLY on affine. Stop joins its reset before destroying the executor.
  std::unique_ptr<SearchHardwareSession> session;
  std::unique_ptr<SearchHardwareSession> reencode_session;
  std::optional<Pin> reencode_pin;
  bool CurrentLocked(uint64_t e,const SearchEmbeddingSpace& s,const config::SearchProducerLease& lease) const {
    return !stopped&&epoch==e&&space&&*space==s&&desired&&desired->IsCurrent()&&lease.IsCurrent()&&
      desired->grant&&lease.grant&&desired->grant->package_id==s.package_id&&lease.grant->package_id==s.package_id&&
      desired->grant->expected_model==lease.grant->expected_model&&PinAllowsSpace(desired->grant->expected_model,s)&&healthy&&healthy();
  }
};
SearchHardwareOwner::SearchHardwareOwner(Factory factory,Clock clock):impl_(std::make_shared<Impl>(std::move(factory),std::move(clock))) {
  if(!impl_->factory)throw std::invalid_argument("search_hardware_factory_missing");
}
SearchHardwareOwner::SearchHardwareOwner(PinnedFactory factory,Clock clock):impl_(std::make_shared<Impl>(std::move(factory),std::move(clock))) {
  if(!impl_->pinned_factory)throw std::invalid_argument("search_hardware_factory_missing");
}
SearchHardwareOwner::~SearchHardwareOwner(){Stop();}
SearchHardwareOwner::State SearchHardwareOwner::Refresh(std::optional<config::SearchProducerLease> lease,bool force) {
  auto p=impl_;
  {
    std::lock_guard<std::mutex> lock(p->mutex);
    if(p->stopped)return State::Stopped;
    if(lease&&(!lease->IsCurrent()||!lease->grant))lease.reset();
    if(lease&&lease->grant->expected_model&&(!ainvr::search::ValidRuntimeModelPin(*lease->grant->expected_model)||
      lease->grant->expected_model->package_id!=lease->grant->package_id))lease.reset();
    if(lease&&std::none_of(lease->grant->sources.begin(),lease->grant->sources.end(),
        [](const auto& entry){return entry.second.object||entry.second.scene;}))lease.reset();
    const std::string package=lease?lease->grant->package_id:"";
    const auto expected=lease?lease->grant->expected_model:std::optional<Pin>{};
    if(force||package!=p->package||expected!=p->expected){++p->epoch;p->space.reset();p->healthy={};p->retry={};}
    p->package=package;p->expected=expected;p->desired=std::move(lease);
  }
  return Tick();
}
SearchHardwareOwner::State SearchHardwareOwner::Tick(){
  auto p=impl_;std::lock_guard<std::mutex> lock(p->mutex);
  if(p->stopped)return State::Stopped;
  if(p->maintenance&&p->maintenance->wait_for(std::chrono::seconds(0))==std::future_status::ready){
    try{p->maintenance->get();}catch(...){}p->maintenance.reset();
  }
  if(!p->maintenance&&p->reencode_expiry&&p->clock()>=*p->reencode_expiry&&!p->reencoding.load()){
    auto cleanup=p->affine.TrySubmit([p]{
      bool expired;{std::lock_guard<std::mutex> guard(p->mutex);
        expired=p->reencode_expiry&&p->clock()>=*p->reencode_expiry;}
      if(expired){p->reencode_session.reset();p->reencode_pin.reset();
        std::lock_guard<std::mutex> guard(p->mutex);p->reencode_expiry.reset();}
    });
    if(cleanup)p->maintenance=std::move(*cleanup);
  }
  if(p->desired&&!p->desired->IsCurrent()){
    p->desired.reset();p->package.clear();p->expected.reset();p->space.reset();p->healthy={};++p->epoch;
  }
  if(p->refresh){
    if(p->refresh->wait_for(std::chrono::seconds(0))!=std::future_status::ready)return State::Loading;
    try{p->refresh->get();}catch(...){p->state=State::Failed;}
    p->refresh.reset();
  }
  if(p->space&&p->desired){
    if(p->CurrentLocked(p->epoch,*p->space,*p->desired))return p->state=State::Ready;
    // Runtime task failure is latched; no repeated allocation attempts.
    return p->state=State::Failed;
  }
  if(p->package.empty()&&p->loaded.empty())return p->state=State::Disabled;
  if(std::chrono::steady_clock::now()<p->retry)return p->state=State::Failed;
  const auto epoch=p->epoch;const auto package=p->package;const auto expected=p->expected;
  auto job=p->affine.TrySubmit([p,epoch,package,expected]{
    // Model and GLES destructors are affine, even on cancelled or failed load.
    p->session.reset();
    {std::lock_guard<std::mutex> guard(p->mutex);p->loaded.clear();}
    std::unique_ptr<SearchHardwareSession> next;
    try{
      const SearchSamplingCurrent current=[p,epoch,package,expected]{std::lock_guard<std::mutex> guard(p->mutex);
        return !p->stopped&&p->epoch==epoch&&p->package==package&&p->expected==expected&&p->desired&&
          p->desired->IsCurrent()&&p->desired->grant&&p->desired->grant->package_id==package&&p->desired->grant->expected_model==expected;};
      if(!package.empty()){
        if(!current())return;
        if(p->pinned_factory)next=p->pinned_factory(package,expected,current);
        else{
          // A legacy factory cannot prove a pre-load pin check. Never allocate
          // first and discover the mismatch from Session::Space afterwards.
          if(expected)throw std::runtime_error("search_hardware_pin_factory_required");
          next=p->factory(package);
        }
      }
      if(!package.empty()&&!next)throw std::runtime_error("search_hardware_not_ready");
      std::optional<SearchEmbeddingSpace> space=next?std::optional(next->Space()):std::nullopt;
      auto health=next?next->HealthReader():std::function<bool()>{};
      if(next&&(!space||space->package_id!=package||space->model_version.empty()||space->input_spec_version.empty()||
          !PinAllowsSpace(expected,*space)||!health||!health()))
        throw std::runtime_error("search_hardware_space_invalid");
      std::lock_guard<std::mutex> guard(p->mutex);
      if(p->stopped||p->epoch!=epoch||p->package!=package||p->expected!=expected||(next&&(!p->desired||!p->desired->IsCurrent())))return;
      p->session=std::move(next);p->loaded=package;p->space=std::move(space);p->healthy=std::move(health);
      p->state=p->session?State::Ready:State::Disabled;
    }catch(...){
      std::lock_guard<std::mutex> guard(p->mutex);
      if(p->epoch==epoch){p->space.reset();p->healthy={};p->state=State::Failed;p->retry=std::chrono::steady_clock::now()+std::chrono::seconds(30);}
    }
  });
  if(!job)return p->state=State::Busy;
  p->refresh=std::move(*job);return p->state=State::Loading;
}
std::optional<SearchEmbeddingSpace> SearchHardwareOwner::CurrentSpace() const {
  auto p=impl_;std::lock_guard<std::mutex> lock(p->mutex);
  if(p->space&&p->desired&&p->CurrentLocked(p->epoch,*p->space,*p->desired))return p->space;
  return {};
}
std::shared_ptr<const SearchPreparedSample> SearchHardwareOwner::Prepare(const FrozenSearchFrame& frame,const SearchEmbeddingSpace& space,
    const config::SearchProducerLease& lease,const SearchSamplingCurrent& current){
  if(SearchSamplingPolicy::IsProbe(frame.Selection()))return {};
  return PrepareInternal(frame,space,lease,{},false,current).prepared;
}
SearchHardwareOwner::ProbeResult SearchHardwareOwner::PrepareProbe(const FrozenSearchFrame& frame,const SearchEmbeddingSpace& space,
    const config::SearchProducerLease& lease,std::span<const float> baseline,const SearchSamplingCurrent& current){
  if(!SearchSamplingPolicy::ProbeContractValid(frame.Selection())||baseline.empty()||baseline.size()>4096)return {};
  return PrepareInternal(frame,space,lease,baseline,true,current);
}
SearchHardwareOwner::ProbeResult SearchHardwareOwner::PrepareInternal(const FrozenSearchFrame& frame,const SearchEmbeddingSpace& space,
    const config::SearchProducerLease& lease,std::span<const float> baseline,bool probe,const SearchSamplingCurrent& current){
  auto p=impl_;uint64_t epoch;
  p->realtime_waiters.fetch_add(1);
  struct RealtimePermit{std::atomic<size_t>& count;~RealtimePermit(){count.fetch_sub(1);}} realtime{p->realtime_waiters};
  {std::lock_guard<std::mutex> lock(p->mutex);epoch=p->epoch;if(!p->CurrentLocked(epoch,space,lease))return {};}
  auto valid=[p,epoch,space,lease,current]{
    if(!current||!current())return false;
    std::lock_guard<std::mutex> lock(p->mutex);return p->CurrentLocked(epoch,space,lease);
  };
  auto output=std::make_shared<ProbeResult>();
  auto job=p->affine.TrySubmit([p,&frame,space,lease,valid,output,baseline,probe]{
    if(!valid()||!p->session)return;
    auto product=p->session->Prepare(frame,valid);
    if(!valid())return;
    std::optional<SearchAppearanceAudit> audit;
    if(probe){
      const auto distance=SearchAppearanceDistance(product.embedding,baseline);
      if(!distance||!std::isfinite(frame.Selection().probe_threshold)||frame.Selection().probe_threshold<0||frame.Selection().probe_threshold>1)return;
      output->distance=distance;
      if(*distance<frame.Selection().probe_threshold)return;
      audit=SearchAppearanceAudit{frame.Selection().probe_reference_fingerprint,*distance,frame.Selection().probe_threshold};
    }
    output->prepared=BuildSearchPreparedSample(frame,space,lease,std::move(product),std::move(audit));
  });
  if(!job)return {};
  // Deliberately no timeout: frame/raw allocation cannot expire under a task.
  job->get();return valid()?*output:ProbeResult{};
}
SearchReencodeResult SearchHardwareOwner::Reencode(const Pin& target,std::span<const uint8_t> jpeg,
    std::chrono::steady_clock::time_point valid_until,const SearchSamplingCurrent& current){
  using Result=SearchReencodeResult;using Status=Result::Status;
  auto p=impl_;
  if(!ainvr::search::ValidRuntimeModelPin(target)||jpeg.size()<4||jpeg.size()>kSearchReencodeMaxJpegBytes)
    return {Status::Unsupported,{}, {},0,0};
  auto valid=[p,valid_until,current]{
    try{if(!current||!current()||p->clock()>=valid_until)return false;
      std::lock_guard<std::mutex> guard(p->mutex);return !p->stopped;
    }catch(...){return false;}
  };
  if(!valid())return {Status::Stale,{}, {},0,0};
  if(valid_until-p->clock()>std::chrono::seconds(30))return {Status::Unsupported,{}, {},0,0};
  if(p->realtime_waiters.load()||p->reencoding.exchange(true))return {Status::Busy,{}, {},0,0};
  struct Permit{std::atomic<bool>& flag;~Permit(){flag.store(false);}} permit{p->reencoding};
  auto result=std::make_shared<Result>();
  auto task=p->affine.TrySubmit([p,target,jpeg,valid_until,valid,result]{
    if(!valid()){result->status=Status::Stale;return;}
    if(p->realtime_waiters.load()){result->status=Status::Busy;return;}
    // The only bounded compressed-byte copy. It is destroyed when this affine
    // task finishes; the HTTP borrow cannot expire earlier than future.get().
    std::vector<uint8_t> bytes(jpeg.begin(),jpeg.end());
    std::pair<int,int> dimensions;
    try{dimensions=analytics::JpegDimensions(bytes);}catch(...){result->status=Status::Unsupported;return;}
    if(!ReencodeDimensions(dimensions.first,dimensions.second)){result->status=Status::Unsupported;return;}
    auto drop_cache=[&]{p->reencode_session.reset();p->reencode_pin.reset();
      std::lock_guard<std::mutex> guard(p->mutex);p->reencode_expiry.reset();};
    SearchHardwareSession* selected=nullptr;bool cached=false;
    try{
      if(!valid()){result->status=Status::Stale;return;}
      // Source state and producer leases stay independent of migration. The
      // authenticated caller proves its own short-lived job authority.
      if(p->session){const auto s=p->session->Space();const auto health=p->session->HealthReader();
        if(PinAllowsSpace(target,s)&&health&&health())selected=p->session.get();}
      if(!selected){
        bool expired;{std::lock_guard<std::mutex> guard(p->mutex);
          expired=!p->reencode_expiry||p->clock()>=*p->reencode_expiry;}
        if(expired||p->reencode_pin!=std::optional(target))drop_cache();
        if(!p->reencode_session){
          if(!p->pinned_factory){result->status=Status::Unsupported;return;}
          auto next=p->pinned_factory(target.package_id,target,valid);
          if(!valid()){result->status=Status::Stale;return;}
          if(!next)throw std::runtime_error("search_hardware_not_ready");
          const auto s=next->Space();const auto health=next->HealthReader();
          if(!PinAllowsSpace(target,s)||s.input_spec_version.empty()||!health||!health())
            throw std::runtime_error("search_hardware_space_invalid");
          p->reencode_session=std::move(next);p->reencode_pin=target;
          {std::lock_guard<std::mutex> guard(p->mutex);p->reencode_expiry=valid_until;}
        }
        selected=p->reencode_session.get();cached=true;
      }
      if(!valid()){if(cached)drop_cache();result->status=Status::Stale;return;}
      auto output=selected->ReencodeJpeg(bytes,valid);
      if(!valid()){if(cached)drop_cache();result->status=Status::Stale;return;}
      if(output.status==Status::Ready&&(!PinAllowsSpace(target,output.space)||output.space!=selected->Space()||
          std::pair(output.image_width,output.image_height)!=dimensions||!ReencodeEmbedding(output.embedding)))
        output={Status::Failed,{}, {},0,0};
      if(output.status==Status::Ready&&cached){std::lock_guard<std::mutex> guard(p->mutex);p->reencode_expiry=valid_until;}
      else if(output.status!=Status::Ready&&cached)drop_cache();
      if(output.status!=Status::Ready)output={output.status,{}, {},0,0};
      *result=std::move(output);
    }catch(const std::exception& error){
      if(cached||p->reencode_session)drop_cache();
      const std::string_view code=error.what();
      result->status=!valid()?Status::Stale:
        (code=="ion_budget_exceeded"||code=="large_model_busy"||code=="admission_lock_timeout")?Status::Busy:Status::Failed;
    }catch(...){if(cached||p->reencode_session)drop_cache();result->status=valid()?Status::Failed:Status::Stale;}
  });
  if(!task)return {Status::Busy,{}, {},0,0};
  // Deliberately no short wait: decoder/encoder may still own borrowed data.
  try{task->get();}catch(...){return {valid()?Status::Failed:Status::Stale,{}, {},0,0};}
  return valid()?std::move(*result):Result{Status::Stale,{}, {},0,0};
}
void SearchHardwareOwner::Stop(){
  auto p=impl_;if(!p)return;std::lock_guard<std::mutex> shutdown(p->shutdown);
  {std::lock_guard<std::mutex> lock(p->mutex);if(p->stopped)return;
    p->stopped=true;++p->epoch;p->desired.reset();p->space.reset();p->healthy={};p->package.clear();p->expected.reset();p->state=State::Stopped;}
  p->affine.Submit([p]{p->session.reset();p->reencode_session.reset();p->reencode_pin.reset();}).get();
  // future.get() proves the reset body finished, not that its [p] callable was
  // destroyed. Keep this strong reference until the exclusive worker joins.
  p->affine.DrainAndShutdown();
  std::lock_guard<std::mutex> lock(p->mutex);
  if(p->refresh){try{p->refresh->get();}catch(...){}p->refresh.reset();}
  if(p->maintenance){try{p->maintenance->get();}catch(...){}p->maintenance.reset();}
  p->reencode_expiry.reset();
}
} // namespace ai_service::output
