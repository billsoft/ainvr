// Copyright AINVR. Bounded admission, cancellation and reservation lifetime.
#include "output/archive_admission.hpp"
#include <future>
#include <iostream>
#include <stdexcept>
using namespace ai_service::output;
void Require(bool ok){if(!ok)throw std::runtime_error("Archive admission assertion failed");}
int main(){
 auto pool=std::make_shared<ArchiveCapacity::Pool>();pool->limit=400;
 auto yes=[] {return true;};
 {
  ArchiveAdmission admission(pool);
  auto first=admission.Acquire(100,yes),second=admission.Acquire(100,yes);
  Require(first.has_value()&&second.has_value()&&pool->reserved==200);
  std::promise<void> entered;
  auto pending=std::async(std::launch::async,[&]{entered.set_value();return admission.Acquire(100,yes);});
  entered.get_future().wait();Require(pending.wait_for(std::chrono::milliseconds(50))==std::future_status::timeout);
  first.reset();Require(pending.wait_for(std::chrono::seconds(1))==std::future_status::ready);
  auto third=pending.get();Require(third.has_value());
  auto cancelled=std::async(std::launch::async,[&]{return admission.Acquire(100,yes);});
  admission.Stop();Require(cancelled.wait_for(std::chrono::seconds(1))==std::future_status::ready);
  Require(!cancelled.get());Require(!admission.Acquire(100,yes));
 }
 Require(pool->reserved==0);
 std::optional<ArchiveAdmission::Ticket> retained;
 {
  ArchiveAdmission owner(pool);retained=owner.Acquire(150,yes);
  ArchiveAdmission other(pool);bool rejected=false;
  try{other.Acquire(100,yes);}catch(const std::runtime_error&){rejected=true;}
  Require(rejected&&pool->reserved==300);
  Require(!other.Acquire(100,[]{return false;}));
  Require(!other.Acquire(100,[]()->bool{throw std::runtime_error("deny");}));
 }
 Require(pool->reserved==300);retained.reset();Require(pool->reserved==0);
 std::cout<<"PASS two slots, backpressure, stop, budget, cancelled callback, surviving ticket\n";
}
