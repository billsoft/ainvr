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
    history={{now,.1}};
    Check(!PacedSubmissionAllowed(history,now,40));
    Check(!PacedSubmissionAllowed(history,now+std::chrono::milliseconds(149),40));
    Check(PacedSubmissionAllowed(history,now+std::chrono::milliseconds(150),40));
    history={{now,1.0}};
    Check(!PacedSubmissionAllowed(history,now+std::chrono::seconds(10),5));
    Check(history.size()==1); // cooldown cannot disappear with the accounting window
    Check(PacedSubmissionAllowed(history,now+std::chrono::seconds(19),5));
    Check(history.empty());
    history={{now,-1}};Check(!PacedSubmissionAllowed(history,now,40));
    history={{now+std::chrono::seconds(1),.1}};Check(!PacedSubmissionAllowed(history,now,40));
    history={};Check(PacedSubmissionAllowed(history,now,40));
    Check(!PacedSubmissionAllowed(history,now,0));
    // Every short task creates a quiet interval; a single request cannot burst
    // through its whole ten-second allowance before yielding to detections.
    auto clock=now;
    for(int i=0;i<100;i++){
      Check(PacedSubmissionAllowed(history,clock,40));
      clock+=std::chrono::milliseconds(20);history.emplace_back(clock,.02);
      Check(!PacedSubmissionAllowed(history,clock,40));
      clock+=std::chrono::milliseconds(31);
    }
    std::cout << checks << " submission budget checks passed\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
