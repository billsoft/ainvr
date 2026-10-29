#include "output/search_execution_port.hpp"
namespace ai_service::output {
namespace {
class ExecutionPort final : public SearchSamplingExecutionPort {
 public:
  ExecutionPort(std::shared_ptr<SearchHardwareOwner> hardware, std::shared_ptr<SearchProducerHttp> http)
      : hardware_(std::move(hardware)), http_(std::move(http)) {
    if (!hardware_ || !http_) throw std::invalid_argument("search_execution_dependencies_missing");
  }
  std::optional<SearchEmbeddingSpace> CurrentSpace() const override {
    return hardware_->CurrentSpace();
  }
  std::shared_ptr<SearchSamplingOperation> Prepare(const FrozenSearchFrame& frame,
      const SearchEmbeddingSpace& space, const config::SearchProducerLease& lease,
      const SearchSamplingCurrent& current) override {
    if (!current || !current() || !lease.IsCurrent()) return {};
    auto prepared = hardware_->Prepare(frame, space, lease, current);
    if (!prepared || !current() || !lease.IsCurrent() || !(prepared->space == space)) return {};
    return http_->Prepare(prepared->sample, prepared->source, prepared->space, lease, prepared->candidate);
  }
  SearchSamplingReceipt Reconcile(const SearchSamplingPolicy::Candidate& candidate,
      const config::SearchProducerSource& source, const SearchEmbeddingSpace& space,
      const std::string& key, const std::string& query, const config::SearchProducerLease& lease,
      const SearchSamplingCurrent& current) override {
    if (!current || !current() || !lease.IsCurrent()) return {};
    const auto active = hardware_->CurrentSpace();
    if (!active || !(*active == space)) return {};
    return http_->Reconcile(candidate, source, space, key, query, lease, current);
  }
  bool CoverageEnabled() const noexcept override { return true; }
  bool SupportsProbes()const noexcept override{return true;}
  SearchSamplingProbePreparation PrepareProbe(const FrozenSearchFrame& frame,const SearchEmbeddingSpace& space,
      const config::SearchProducerLease& lease,std::span<const float> baseline,const SearchSamplingCurrent& current)override{
    using Result=SearchSamplingProbePreparation::Result;
    if(!current||!current()||!lease.IsCurrent()||!SearchSamplingPolicy::ProbeContractValid(frame.Selection()))return {};
    const auto result=hardware_->PrepareProbe(frame,space,lease,baseline,current);
    if(!current()||!lease.IsCurrent()||!result.distance)return {};
    if(*result.distance<frame.Selection().probe_threshold){
      if(result.prepared)return {};
      return {Result::NoChange,result.distance,{}};
    }
    if(!result.prepared||!(result.prepared->space==space))return {};
    auto operation=http_->Prepare(result.prepared->sample,result.prepared->source,result.prepared->space,lease,result.prepared->candidate);
    return {Result::Write,result.distance,std::move(operation)};
  }
  bool PublishCoverage(const SearchCoverageRange& range,const config::SearchProducerLease& lease,
      const SearchSamplingCurrent& current) override {
    if(!current||!current()||!lease.IsCurrent())return false;
    const auto active=hardware_->CurrentSpace();
    if(!active||active->package_id!=range.scope.package_id||active->model_version!=range.scope.model_version)return false;
    return http_->PublishCoverage(range,lease,current);
  }
 private:
  std::shared_ptr<SearchHardwareOwner> hardware_;
  std::shared_ptr<SearchProducerHttp> http_;
};
}
std::shared_ptr<SearchSamplingExecutionPort> MakeSearchExecutionPort(
    std::shared_ptr<SearchHardwareOwner> hardware, std::shared_ptr<SearchProducerHttp> http) {
  if (!http) http = std::make_shared<SearchProducerHttp>();
  return std::make_shared<ExecutionPort>(std::move(hardware), std::move(http));
}
} // namespace ai_service::output
