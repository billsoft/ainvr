// Copyright AINVR.
#include "../../ai-service/src/analytics/assignment.hpp"
#include "../../ai-service/src/analytics/geometry.hpp"
#include <cassert>
#include <iostream>
using namespace ai_service::analytics;
int main() {
  // Global assignment must outperform greedy association here.
  assert((Assign({{0.1,0.2},{0.15,0.9}},1.0)==std::vector<int>{1,0}));
  assert((Assign({{0.2},{0.8}},0.5)==std::vector<int>{0,-1}));
  assert((Assign({{},{}},1.0)==std::vector<int>{-1,-1}));
  assert(Assign({},1.0).empty());
  assert((Assign({{2.0,2.0},{2.0,2.0}},1.0)==std::vector<int>{-1,-1}));
  bool rejected=false;
  try {Assign({{0.1},{0.2,0.3}},1);} catch(const std::invalid_argument&) {rejected=true;}
  assert(rejected);
  std::vector<Point> polygon{{0.2,0.2},{0.8,0.2},{0.8,0.8},{0.2,0.8}};
  ValidatePolygon(polygon);
  assert(Inside(polygon,{0.5,0.5}));
  assert(Inside(polygon,{0.2,0.5}));
  assert(!Inside(polygon,{0.9,0.5}));
  assert(Crosses({0.5,0.2},{0.5,0.8},{0.4,0.5},{0.6,0.5}));
  assert(!Crosses({0.5,0.2},{0.5,0.8},{0.4,0.9},{0.6,0.9}));
  assert(!Crosses({0.5,0.2},{0.5,0.8},{0.4,0.5},{0.5,0.5}));
  rejected=false;
  try {ValidatePolygon({{0,0},{1,1},{0,1},{1,0}});} catch(const std::invalid_argument&) {rejected=true;}
  assert(rejected);
  std::cout<<"analytics association and geometry: PASS\n";
}
