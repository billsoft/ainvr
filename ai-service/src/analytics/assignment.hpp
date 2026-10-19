// Copyright AINVR. Minimum-cost one-to-one association, including unmatched rows.
#pragma once
#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <vector>
namespace ai_service::analytics {
// Rows are tracks, columns observations. Costs >= unmatched_cost are rejected.
// A private dummy column per row makes missing observations a normal outcome.
inline std::vector<int> Assign(const std::vector<std::vector<double>>& costs,
                               double unmatched_cost) {
  if(!std::isfinite(unmatched_cost)||unmatched_cost<=0)
    throw std::invalid_argument("Invalid unmatched cost");
  const int n=static_cast<int>(costs.size());
  if(!n) return {};
  const int observed=static_cast<int>(costs[0].size()),m=observed+n;
  for(const auto& row:costs) {
    if(static_cast<int>(row.size())!=observed) throw std::invalid_argument("Ragged association matrix");
    for(double value:row) if(!std::isfinite(value)||value<0)
      throw std::invalid_argument("Invalid association cost");
  }
  std::vector<double> u(n+1),v(m+1);
  std::vector<int> p(m+1),way(m+1);
  for(int i=1;i<=n;++i) {
    p[0]=i;
    int j0=0;
    std::vector<double> minimum(m+1,std::numeric_limits<double>::infinity());
    std::vector<bool> used(m+1,false);
    do {
      used[j0]=true;
      int i0=p[j0],j1=0;
      double delta=std::numeric_limits<double>::infinity();
      for(int j=1;j<=m;++j) if(!used[j]) {
        double cost=j<=observed?costs[i0-1][j-1]:unmatched_cost;
        double current=cost-u[i0]-v[j];
        if(current<minimum[j]) {minimum[j]=current;way[j]=j0;}
        if(minimum[j]<delta) {delta=minimum[j];j1=j;}
      }
      for(int j=0;j<=m;++j) {
        if(used[j]) {u[p[j]]+=delta;v[j]-=delta;}
        else minimum[j]-=delta;
      }
      j0=j1;
    } while(p[j0]);
    do {int j1=way[j0];p[j0]=p[j1];j0=j1;} while(j0);
  }
  std::vector<int> result(n,-1);
  for(int j=1;j<=observed;++j)
    if(p[j] && costs[p[j]-1][j-1]<unmatched_cost) result[p[j]-1]=j-1;
  return result;
}
} // namespace ai_service::analytics
