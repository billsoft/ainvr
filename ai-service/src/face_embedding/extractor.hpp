// Copyright AINVR. Hardware execution port and explicit shared-budget custody.
#pragma once
#include "manifest.hpp"
#include <functional>
#include <memory>

namespace ainvr::face {
using Current=std::function<bool()>;
// Supplied by the central admission owner, never minted by a BFF JSON request.
// The owner MUST retain the same reservation while ConfigureResidency keeps
// these BPU models resident, including deferred retirement and fault quarantine.
// A null/expired lease fails before any SDK allocation. No private second pool.
struct BudgetLease {
  std::shared_ptr<void> custody;
  std::function<bool()> current;
  std::function<void(std::weak_ptr<void>)> observe_model;
  std::function<void()> loaded;
  bool Valid() const {return custody&&current&&current();}
};
class Extractor {
 public:
  virtual ~Extractor()=default;
  virtual Result Extract(const std::vector<uint8_t>& jpeg,const Current& current)=0;
};
using ExtractorFactory=std::function<std::unique_ptr<Extractor>(const Settings&,BudgetLease,const Current&)>;
} // namespace ainvr::face
