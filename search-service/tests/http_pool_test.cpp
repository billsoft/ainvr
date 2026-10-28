#include <httplib.h>
#include <atomic>
#include <chrono>
#include <future>
#include <iostream>
using namespace std::chrono_literals;
int main() {
  // Test the upstream bounded pool used by HttpService rather than maintaining
  // a competing first-party executor. No arbitrary exception escaping a job is
  // promised: application handlers translate their errors to HTTP responses.
  httplib::ThreadPool pool(1, 0, 2);
  std::promise<void> release, entered; auto gate = release.get_future().share();
  std::atomic<int> completed{0}; std::atomic<bool> rejected_ran{false};
  const bool first = pool.enqueue([&] { entered.set_value(); gate.wait(); ++completed; });
  const bool running = entered.get_future().wait_for(1s) == std::future_status::ready;
  const bool second = pool.enqueue([&] { ++completed; });
  const bool third = pool.enqueue([&] { ++completed; });
  const bool fourth = pool.enqueue([&] { rejected_ran = true; });
  release.set_value(); pool.shutdown();
  const bool after_shutdown = pool.enqueue([] {});
  if (!first || !running || !second || !third || fourth || completed != 3 || rejected_ran || after_shutdown) {
    std::cerr << "upstream HTTP pool admission/drain failed\n"; return 1;
  }
  std::cout << "upstream HTTP pool: fixed workers, bounded queue, rejection and shutdown passed\n";
}
