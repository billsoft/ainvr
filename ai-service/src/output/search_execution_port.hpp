// AINVR. Composition of existing sampling, affine image preparation and transport.
#pragma once
#include "output/search_hardware_owner.hpp"
#include "output/search_producer_http.hpp"
namespace ai_service::output {
// The managed control tick refreshes hardware separately; the real-time producer
// only reads CurrentSpace. No model loading or HTTP runs on the producer thread.
std::shared_ptr<SearchSamplingExecutionPort> MakeSearchExecutionPort(
    std::shared_ptr<SearchHardwareOwner>, std::shared_ptr<SearchProducerHttp> http = {});
} // namespace ai_service::output
