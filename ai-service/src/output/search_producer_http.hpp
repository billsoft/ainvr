// AINVR. Prepared immutable sampling writes and exact receipt lookups only.
#pragma once
#include "output/search_sampling_owner.hpp"
#include <array>
#include "../../../search-service/src/sample_contract.hpp"
namespace ai_service::output {
// Diagnostics: sample-write outcomes (0 committed, 1 repeated submit, 2 lease not alive, 3 not attempted,
// 4 prewrite rejected, 5 http status 0, 6 http 5xx, 7 other non-200, 8 lease lost after reply, 9 ack mismatch, 10 exception).
std::array<uint64_t,12> SearchSubmitOutcomes();
struct SearchProducerHttpResponse {
  bool attempted = false;
  int status = 0;
  std::string body;
  // Internal transport fact, never a wire header. True only for a complete,
  // bounded, uncompressed JSON error response from the fixed local endpoint.
  bool complete_error_response = false;
};
// Synchronous bounded transport, not a queue or an HTTP authority. jpeg is
// borrowed only through Post's return; metadata and pixels must not be retained.
class SearchProducerHttpTransport {
 public:
  virtual ~SearchProducerHttpTransport() = default;
  virtual SearchProducerHttpResponse Post(const config::SearchProducerLease&,
      const std::string& path, const std::string& metadata, const std::vector<uint8_t>* jpeg,
      const SearchSamplingCurrent&) = 0;
  virtual SearchProducerHttpResponse PutCoverage(const config::SearchProducerLease&,
      const std::string&,const SearchSamplingCurrent&) { return {}; }
};
std::shared_ptr<SearchProducerHttpTransport> MakeSearchProducerHttpTransport();
class SearchProducerHttp {
 public:
  explicit SearchProducerHttp(std::shared_ptr<SearchProducerHttpTransport> transport = {});
  // Sample and its underlying storage MUST be immutable after hardware prepare.
  // No UUID/expiry/evidence regeneration. Object CAS token is generated once.
  std::shared_ptr<SearchSamplingOperation> Prepare(std::shared_ptr<const ainvr::search::Sample>,
      const config::SearchProducerSource&, const SearchEmbeddingSpace&, const config::SearchProducerLease&,
      const SearchSamplingPolicy::Candidate&);
  SearchSamplingReceipt Reconcile(const SearchSamplingPolicy::Candidate&, const config::SearchProducerSource&,
      const SearchEmbeddingSpace&, const std::string& receipt_key, const std::string& receipt_query,
      const config::SearchProducerLease& current_lease, const SearchSamplingCurrent&);
  bool PublishCoverage(const SearchCoverageRange&,const config::SearchProducerLease&,
      const SearchSamplingCurrent&);
 private:
  std::shared_ptr<SearchProducerHttpTransport> transport_;
};
}  // namespace ai_service::output
