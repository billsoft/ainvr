#include "../../ai-service/src/analytics/assignment.hpp"
#include <cassert>
int main(){using ai_service::analytics::Assign;
 assert((Assign({{1,1.2},{1.1,4}},4)==std::vector<int>{1,0}));
 assert((Assign({{4}},4)==std::vector<int>{-1}));
 assert((Assign({{3.999}},4)==std::vector<int>{0}));
 assert((Assign({{},{}},4)==std::vector<int>{-1,-1}));
 assert((Assign({{0},{.1}},4)==std::vector<int>{0,-1}));
}
