#include "search_work_budget.hpp"
#include <atomic>
#include <iostream>
#include <limits>
#include <thread>
#include <vector>
using ai_service::output::SearchWorkBudget;
void Check(bool value) { if (!value) throw std::runtime_error("search_work_budget_assertion"); }
int main() {
  constexpr size_t mib = 1024 * 1024;
  SearchWorkBudget budget;
  Check(!budget.TryAcquire(1));
  budget.Configure(4, 256 * mib);
  Check(!budget.TryAcquire(0)); Check(!budget.TryAcquire(std::numeric_limits<size_t>::max()));
  auto a = budget.TryAcquire(100 * mib), b = budget.TryAcquire(100 * mib);
  Check(a.has_value() && b.has_value() && !budget.TryAcquire(60 * mib));
  Check(budget.Inspect().bytes == 200 * mib);
  budget.Configure(1, 8 * mib); Check(!budget.TryAcquire(1));
  a.reset(); b.reset(); Check(budget.Inspect().bytes == 0);
  auto first = budget.TryAcquire(8 * mib); Check(first.has_value());
  SearchWorkBudget::Ticket moved(std::move(*first)); first.reset();
  Check(budget.Inspect().jobs == 1);
  budget.Disable(); Check(!budget.TryAcquire(1));
  budget.Configure(4, 256 * mib); // old generation's moved ticket still counts
  std::atomic<int> accepted{0}; std::vector<std::thread> workers;
  for (int n = 0; n < 8; ++n) workers.emplace_back([&] {
    for (int i = 0; i < 2000; ++i) {
      auto ticket = budget.TryAcquire(64 * mib);
      if (ticket) { ++accepted; auto now = budget.Inspect(); Check(now.jobs <= 4 && now.bytes <= 256 * mib); }
    }
  });
  for (auto& thread : workers) thread.join();
  Check(accepted.load() > 0); Check(budget.Inspect().jobs == 1 && budget.Inspect().bytes == 8 * mib);
  { auto owner = std::make_unique<SearchWorkBudget>(); owner->Configure(1, 8 * mib);
    auto ticket = owner->TryAcquire(8 * mib); owner.reset(); ticket.reset(); }
  std::cout << "search work budget: lifecycle, generation, overflow and 8-producer contention passed\n";
}
