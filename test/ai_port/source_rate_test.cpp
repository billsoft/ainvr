#include "../../ai-service/src/stream/source_rate.hpp"
#include <cassert>
#include <limits>
int main(){using ai_service::stream::FreshSourceRate;
 assert(FreshSourceRate(30,0,true)==30);assert(FreshSourceRate(30,2,true)==30);
 assert(FreshSourceRate(30,2.001,true)==0);assert(FreshSourceRate(30,0,false)==0);
 assert(FreshSourceRate(30,-1,true)==0);assert(FreshSourceRate(std::numeric_limits<double>::infinity(),0,true)==0);
 assert(FreshSourceRate(0,0,true)==0);assert(FreshSourceRate(25,0,true)==25);
}
