#pragma once
#include "output/archive_executor.hpp"
namespace ai_service::output {
inline ArchiveExecutor& SearchSamplingExecutor(){
  static ArchiveExecutor executor(2,8);return executor;
}
inline ArchiveExecutor& SearchCoverageExecutor(){
  static ArchiveExecutor executor(1,1);return executor;
}
} // namespace ai_service::output
