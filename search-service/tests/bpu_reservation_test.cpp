// Search-service reservation contract: protocol 3 (byte-accounted coexistence) next to Qwen, and mutual exclusion with the
// unchanged protocol-2 exclusive holders. Software only: a fake probe replaces /proc fdinfo, no BPU, no production registry.
#include "../../shared/cpp/bpu_reservation.hpp"
#include "../../shared/cpp/bpu_coexist_reservation.hpp"
#include "../../llm-service/src/reservation.hpp"
#include <csignal>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <sys/wait.h>
#include <type_traits>
namespace fs = std::filesystem;
using Json = nlohmann::json;
namespace {
constexpr uint64_t kMiB = 1024*1024, kTotal = 7680*kMiB, kMinFree = 256*kMiB, kText = 972*kMiB, kVision = 537*kMiB;
constexpr uint64_t kQwenDeclared = 5500000000ULL, kQwenMeasured = 5459*kMiB, kAi = 198*kMiB;
void Check(bool value) { if (!value) throw std::runtime_error("reservation_test_failed"); }
void Reject(const std::function<void()>& fn, const char* reason) {
  try { fn(); } catch (const std::runtime_error& error) { Check(std::string(error.what()) == reason); return; }
  throw std::runtime_error("reservation_was_not_rejected");
}
Json Read(const fs::path& path) { std::ifstream file(path); Json value; file >> value; return value; }
ainvr::IonProbe Fake(std::map<int, uint64_t> by_pid, uint64_t others) {
  ainvr::IonProbe p;
  p.pid_bytes = [by_pid](int pid) { auto it = by_pid.find(pid); return it == by_pid.end() ? uint64_t(0) : it->second; };
  p.others_bytes = [others](const std::set<int>&) { return others; };
  return p;
}
ainvr::IonPolicy Policy() { ainvr::IonPolicy p; p.pool_bytes = kTotal; p.min_free = kMinFree; return p; }
struct Temp {
  std::string path;
  Temp() { char value[] = "/tmp/ainvr-search-reservation-XXXXXX"; auto p = mkdtemp(value); Check(p); path = p; }
  ~Temp() { std::error_code error; fs::remove_all(path, error); }
};
}  // namespace
int main() {
  static_assert(std::is_base_of_v<ainvr::BpuCoexistReservation, ainvr::llm::Reservation>);
  try {
    Temp tmp; const auto registry = fs::path(tmp.path)/"bpu-reservations.json";
    Reject([&] { ainvr::BpuCoexistReservation bad(tmp.path, "unknown-service", kText, Policy(), Fake({}, kAi)); }, "invalid_reservation_service");
    Check(!fs::exists(registry));
    // Qwen (measured 5459 MiB) stays resident; both so400m towers are admitted next to it, a further one is not.
    ainvr::BpuCoexistReservation qwen(tmp.path, "llm-service", kQwenDeclared, Policy(), Fake({{getpid(), kQwenMeasured}}, kAi));
    qwen.Loaded();
    int to_child[2], from_child[2]; Check(pipe(to_child) == 0 && pipe(from_child) == 0);
    const pid_t child = fork(); Check(child >= 0);
    if (child == 0) {                                                    // text tower in its own process, like a second service
      close(to_child[1]); close(from_child[0]);
      try {
        ainvr::BpuCoexistReservation text(tmp.path, "search-service", kText, Policy(), Fake({{getpid(), kText}}, kAi));
        text.Loaded(); (void)!write(from_child[1], "K", 1); char c; (void)!read(to_child[0], &c, 1);
      } catch (...) { (void)!write(from_child[1], "E", 1); }
      _exit(0);
    }
    close(to_child[0]); close(from_child[1]); char ready = 0; Check(read(from_child[0], &ready, 1) == 1 && ready == 'K');
    auto state = Read(registry);
    Check(state["protocol"] == 3 && state["holders"].size() == 2);
    {
      ainvr::BpuCoexistReservation vision(tmp.path, "search-service", kVision, Policy(), Fake({{getpid(), kVision}}, kAi));
      Check(vision.Decision().ok && vision.Decision().spare >= 0);
      Check(Read(registry)["holders"].size() == 3);
      Reject([&] { ainvr::BpuCoexistReservation more(tmp.path, "search-service", 493*kMiB, Policy(), Fake({}, kAi)); }, "ion_budget_exceeded");
    }
    Check(Read(registry)["holders"].size() == 2);
    // Protocol-2 exclusive holders and protocol-3 holders exclude each other in both directions.
    Reject([&] { ainvr::BpuReservation old(tmp.path, kText, 512*kMiB, kTotal, "search-service"); }, "large_model_busy");
    close(to_child[1]); int st = 0; Check(waitpid(child, &st, 0) == child);
    Check(Read(registry)["holders"].size() == 1 && Read(registry)["holders"][0]["service"] == "llm-service");
    std::cout << Json{{"protocol", 3}, {"coexisting_pair_next_to_qwen", true}, {"production_registry_accessed", false}, {"bpu_tasks", 0}} << '\n';
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
  try {                                                                  // exclusive holder first: protocol 3 must be refused
    Temp tmp;
    { ainvr::BpuReservation old(tmp.path, kQwenDeclared, 512*kMiB, kTotal, "llm-service");
      Reject([&] { ainvr::BpuCoexistReservation c(tmp.path, "search-service", kText, Policy(), Fake({}, kAi)); }, "large_model_busy"); }
    ainvr::BpuCoexistReservation c(tmp.path, "search-service", kText, Policy(), Fake({}, kAi)); Check(c.Decision().ok);
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
