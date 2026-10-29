#include "submission_budget.hpp"
#include <iostream>
#include <limits>
#include <stdexcept>

using namespace ainvr::llm;
int checks = 0;
void Check(bool condition) {
  ++checks;
  if (!condition) throw std::runtime_error("submission_budget_contract_failed");
}
int main() {
  try {
    const auto now = SubmissionClock::time_point(std::chrono::seconds(100));
    SubmissionHistory history;
    Check(SubmissionAllowed(history, now, 90));
    history.emplace_back(now, 8.999);
    Check(SubmissionAllowed(history, now, 90));
    history.back().second = 9;
    Check(!SubmissionAllowed(history, now, 90));
    Check(!SubmissionAllowed(history, now + std::chrono::milliseconds(9999), 90));
    Check(SubmissionAllowed(history, now + std::chrono::seconds(10), 90));
    Check(history.empty());
    history = {{now - std::chrono::seconds(10), 20}, {now, 4.5}};
    Check(!SubmissionAllowed(history, now, 45));
    Check(history.size() == 1);
    Check(SubmissionAllowed(history, now, 46));
    history = {{now, .25}, {now, .25}};
    Check(!SubmissionAllowed(history, now, 5));
    history.back().second = .249;
    Check(SubmissionAllowed(history, now, 5));
    for (const double cap : {0., 4., 91., 100., 89.5,
                            std::numeric_limits<double>::quiet_NaN(),
                            std::numeric_limits<double>::infinity()})
      Check(!SubmissionAllowed(history, now, cap));
    for (const double used : {-1., std::numeric_limits<double>::quiet_NaN(),
                             std::numeric_limits<double>::infinity()}) {
      history = {{now, used}};
      Check(!SubmissionAllowed(history, now, 90));
    }
    history = {{now + std::chrono::nanoseconds(1), 0}};
    Check(!SubmissionAllowed(history, now, 90));
    history = {{now, std::numeric_limits<double>::max()},
               {now, std::numeric_limits<double>::max()}};
    Check(!SubmissionAllowed(history, now, 90));
    history = {{now - std::chrono::seconds(10),
                std::numeric_limits<double>::quiet_NaN()}};
    Check(SubmissionAllowed(history, now, 90));
    Check(history.empty());
    std::cout << checks << " submission budget checks passed\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
