#include "../../ai-service/src/platform/bpu_schedule.hpp"
#include <cassert>
int main(){
 assert(ainvr::ParseBpuTaskPriority(nullptr)==0);
 assert(ainvr::ParseBpuTaskPriority("0")==0);
 assert(ainvr::ParseBpuTaskPriority("128")==128);
 assert(ainvr::ParseBpuTaskPriority("255")==255);
 for(const auto* s:{"","-1","256","1x","1.5","+1"," 1","99999999999999"}){
  bool failed=false;try{ainvr::ParseBpuTaskPriority(s);}catch(const std::invalid_argument&){failed=true;}assert(failed);
 }
}
