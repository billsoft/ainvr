// Copyright AINVR. Score-tiered association primitive, not a complete tracker.
#pragma once
#include "assignment.hpp"
#include <optional>
namespace ai_service::analytics {
struct ScoreAssociation {
  std::vector<int> matched;
  std::vector<int> new_candidates;
};
// High scores associate first. Low scores only recover unmatched eligible tracks;
// they never start a new identity. Unknown scores are rejected in this mode.
inline ScoreAssociation AssociateScores(
    const std::vector<std::vector<double>>& costs,
    const std::vector<std::optional<double>>& scores,
    const std::vector<bool>& allow_low_recovery,
    double low=0.1,double high=0.5,double birth=0.6) {
  if(!std::isfinite(low)||!std::isfinite(high)||!std::isfinite(birth)||
     low<0||low>=high||high>birth||birth>1)
    throw std::invalid_argument("Invalid score thresholds");
  if(costs.size()!=allow_low_recovery.size()) throw std::invalid_argument("Recovery mask differs");
  for(const auto& row:costs) {
    if(row.size()!=scores.size())throw std::invalid_argument("Score dimensions differ");
    for(double c:row)if(!std::isfinite(c)||c<0)throw std::invalid_argument("Invalid cost");
  }
  std::vector<int> high_ids,low_ids;
  for(size_t j=0;j<scores.size();++j) {
    if(!scores[j]||!std::isfinite(*scores[j])||*scores[j]<0||*scores[j]>1)
      throw std::invalid_argument("Scored association requires actual confidence");
    if(*scores[j]>=high)high_ids.push_back(static_cast<int>(j));
    else if(*scores[j]>=low)low_ids.push_back(static_cast<int>(j));
  }
  ScoreAssociation out;out.matched.resize(costs.size(),-1);
  std::vector<bool> used(scores.size(),false);
  auto pass=[&](const std::vector<int>& rows,const std::vector<int>& columns) {
    std::vector<std::vector<double>> matrix;
    for(int row:rows) {
      std::vector<double> values;
      for(int column:columns)values.push_back(costs[row][column]);
      matrix.push_back(std::move(values));
    }
    auto matches=Assign(matrix,1.0);
    for(size_t i=0;i<rows.size();++i)if(matches[i]>=0) {
      int column=columns[matches[i]];out.matched[rows[i]]=column;used[column]=true;
    }
  };
  std::vector<int> rows;
  for(size_t i=0;i<costs.size();++i)rows.push_back(static_cast<int>(i));
  pass(rows,high_ids);
  rows.clear();
  for(size_t i=0;i<costs.size();++i)
    if(out.matched[i]<0&&allow_low_recovery[i])rows.push_back(static_cast<int>(i));
  pass(rows,low_ids);
  for(int j:high_ids)if(!used[j]&&*scores[j]>=birth)out.new_candidates.push_back(j);
  return out;
}
}
