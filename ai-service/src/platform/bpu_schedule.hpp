// Copyright AINVR. Optional SDK scheduling priority, independent of tensor ownership.
#pragma once
#include <charconv>
#include <stdexcept>
#include <string_view>
namespace ainvr {
inline int ParseBpuTaskPriority(const char* text) {
  if(!text)return 0; // Preserve SDK default unless the deployment opts in.
  const std::string_view value(text);int priority=0;
  const auto parsed=std::from_chars(value.data(),value.data()+value.size(),priority);
  if(value.empty()||value.front()<'0'||value.front()>'9'||parsed.ec!=std::errc{}||
     parsed.ptr!=value.data()+value.size()||priority<0||priority>255)
    throw std::invalid_argument("AINVR_BPU_TASK_PRIORITY must be an integer from 0 to 255");
  return priority;
}
}
