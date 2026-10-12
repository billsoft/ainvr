// Copyright AINVR.
#pragma once
#include <cstdint>
namespace ai_service::output {
struct ExposureBackendStats { uint64_t gpu_runs, failures, cpu_runs; };
ExposureBackendStats GetExposureBackendStats();
}
