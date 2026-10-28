// AINVR. Executor semantics only; no models, image operations or production I/O.
#include "output/archive_executor.hpp"
#include <atomic>
#include <chrono>
#include <iostream>
#include <stdexcept>
using ai_service::output::ArchiveExecutor;
using namespace std::chrono_literals;
void Check(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
int main() {
  try {
    ArchiveExecutor executor(1, 1);
    std::promise<void> entered, release;
    auto gate = release.get_future().share();
    auto running = executor.Submit([&] { entered.set_value(); gate.wait(); });
    entered.get_future().wait(); // Worker is outside the admission mutex.
    std::atomic<int> accepted{0}, rejected{0};
    auto queued = executor.TrySubmit([&] { ++accepted; });
    // One active task and one queued task fill the existing queue. A background
    // submission must return before we release the active worker.
    auto attempt = std::async(std::launch::async, [&] {
      return executor.TrySubmit([&] { ++rejected; });
    });
    const bool immediate = attempt.wait_for(500ms) == std::future_status::ready;
    if (!immediate) release.set_value(); // Ensure failure cannot hang teardown.
    auto refusal = attempt.get();
    if (immediate) release.set_value();
    running.get(); if (queued) queued->get(); if (refusal) refusal->get();
    Check(queued.has_value(), "empty queue did not accept background task");
    Check(immediate && !refusal, "full queue blocked or admitted background task");
    Check(accepted == 1 && rejected == 0, "rejected callback was executed");

    auto failure = executor.Submit([] { throw std::runtime_error("fixture_task_error"); });
    bool propagated = false;
    try { failure.get(); } catch (const std::runtime_error& error) {
      propagated = std::string(error.what()) == "fixture_task_error";
    }
    Check(propagated, "Submit lost task exception");
    // Hold the sole worker again so the try-lock admission outcome is fully
    // deterministic, then verify TrySubmit uses the same future semantics.
    std::promise<void> entered_again, release_again;
    auto gate_again = release_again.get_future().share();
    auto held = executor.Submit([&] { entered_again.set_value(); gate_again.wait(); });
    entered_again.get_future().wait();
    auto try_failure = executor.TrySubmit([] { throw std::logic_error("fixture_try_error"); });
    release_again.set_value(); held.get();
    Check(try_failure.has_value(), "try task unexpectedly refused");
    propagated = false;
    try { try_failure->get(); } catch (const std::logic_error& error) {
      propagated = std::string(error.what()) == "fixture_try_error";
    }
    Check(propagated, "TrySubmit lost task exception");

    std::atomic<int> drained{0};
    std::vector<std::future<void>> futures;
    {
      ArchiveExecutor drain(2, 16);
      for (int i = 0; i < 12; ++i) futures.push_back(drain.Submit([&] {
        std::this_thread::sleep_for(1ms); ++drained;
      }));
      // Destructor must drain every already accepted job rather than cancel it.
    }
    for (auto& future : futures) future.get();
    Check(drained == 12, "destruction lost accepted jobs");
    std::cout << "archive executor: nonblocking rejection, shared queue, futures, exceptions and drain passed\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; return 1;
  }
}
