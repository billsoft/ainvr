// Copyright AINVR. Bounded per-model candidates, shared by validation and decoding.
#pragma once
#include <vector>
#include <numeric>
#include <stdexcept>
#include <cstdint>
namespace ai_service::adapters {
inline constexpr int kPipelineCandidateCapacity=1000;
inline std::vector<int> PipelineCandidateLimits(const std::vector<int>& visible) {
  int64_t total=0;
  for(int n:visible){if(n<1||n>kPipelineCandidateCapacity)throw std::invalid_argument("Invalid model detection limit");total+=n;}
  if(visible.empty()||total>kPipelineCandidateCapacity)
    throw std::invalid_argument("模型最大检测数合计不能超过1000，请降低各模型的最大检测数");
  auto result=visible;const int spare=kPipelineCandidateCapacity-int(total);
  for(size_t i=0;i<result.size();++i)result[i]+=spare/int(result.size())+(i<size_t(spare%int(result.size()))?1:0);
  return result;
}
inline bool PlateSourceSupported(int width,int height) {
  return width>=16&&height>=16&&width%2==0&&height%2==0&&int64_t(width)*height<=8388608;
}
}
