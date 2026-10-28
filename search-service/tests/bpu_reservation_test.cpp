#include "../../shared/cpp/bpu_reservation.hpp"
#include "../../llm-service/src/reservation.hpp"
#include <csignal>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <sys/wait.h>
#include <type_traits>
namespace fs = std::filesystem;
using Json = nlohmann::json;
namespace {
constexpr uint64_t kMiB = 1024*1024, kTotal = 7680*kMiB, kReserve = 512*kMiB, kText = 972*kMiB;
void Check(bool value) { if (!value) throw std::runtime_error("reservation_test_failed"); }
void Reject(const std::function<void()>& fn, const char* reason) {
  try { fn(); } catch (const std::runtime_error& error) { Check(std::string(error.what()) == reason); return; }
  throw std::runtime_error("reservation_was_not_rejected");
}
Json Read(const fs::path& path) { std::ifstream file(path); Json value; file >> value; return value; }
void Write(const fs::path& path, const Json& value) { std::ofstream file(path); file << value; Check(bool(file)); }
struct Temp {
  std::string path;
  Temp() { char value[] = "/tmp/ainvr-search-reservation-XXXXXX"; auto p = mkdtemp(value); Check(p); path = p; }
  ~Temp() { std::error_code error; fs::remove_all(path, error); }
};
}  // namespace
int main() {
  static_assert(std::is_same_v<ainvr::llm::Reservation, ainvr::BpuReservation>);
  try {
    Temp tmp; const auto registry = fs::path(tmp.path)/"bpu-reservations.json";
    Reject([&] { ainvr::BpuReservation invalid(tmp.path, kText, kReserve, kTotal, "unknown-service"); }, "invalid_reservation_service");
    Check(!fs::exists(registry));
    Reject([&] { ainvr::BpuReservation invalid(tmp.path, kText, kReserve, kMiB, "search-service"); }, "ion_budget_exceeded");
    {
      ainvr::llm::Reservation llm(tmp.path, 5500000000ULL, kReserve, kTotal);
      Check(llm.Service() == "llm-service");
      Reject([&] { ainvr::BpuReservation search(tmp.path, kText, kReserve, kTotal, "search-service"); }, "large_model_busy");
      Check(Read(registry)["holders"][0]["service"] == "llm-service");
    }
    Json saved;
    {
      ainvr::BpuReservation search(tmp.path, kText, kReserve, kTotal, "search-service");
      Check(search.Service() == "search-service" && search.Bytes() == kText);
      auto state = Read(registry); Check(state["protocol"] == 2 && state["holders"][0]["state"] == "loading");
      search.Loaded(); saved = Read(registry); Check(saved["holders"][0]["state"] == "loaded");
      Reject([&] { ainvr::llm::Reservation llm(tmp.path, 5500000000ULL, kReserve, kTotal); }, "large_model_busy");
      const pid_t child = fork(); Check(child >= 0);
      if (child == 0) {
        try { ainvr::BpuReservation denied(tmp.path, kText, kReserve, kTotal, "search-service"); _exit(10); }
        catch (const std::runtime_error& error) { _exit(std::string(error.what()) == "large_model_busy" ? 0 : 11); }
      }
      int status = 0; Check(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    }
    Check(Read(registry)["holders"].empty());
    // A live registry holder without its lock is inconsistent and must not be
    // silently cleared; this test only writes its private temporary registry.
    Write(registry, saved);
    Reject([&] { ainvr::BpuReservation denied(tmp.path, kText, kReserve, kTotal, "search-service"); }, "uncoordinated_model_holder");
    Write(registry, Json{{"protocol",2},{"holders",Json::array()}});
    int pipefd[2]; Check(pipe(pipefd) == 0);
    const pid_t child = fork(); Check(child >= 0);
    if (child == 0) {
      close(pipefd[0]);
      try {
        ainvr::BpuReservation crashed(tmp.path, kText, kReserve, kTotal, "search-service");
        Check(write(pipefd[1], "L", 1) == 1); for (;;) pause();
      } catch (...) { _exit(12); }
    }
    close(pipefd[1]); char ready = 0; Check(read(pipefd[0], &ready, 1) == 1 && ready == 'L'); close(pipefd[0]);
    Check(kill(child, SIGKILL) == 0); int status = 0; Check(waitpid(child, &status, 0) == child && WIFSIGNALED(status));
    {
      ainvr::llm::Reservation recovered(tmp.path, 5500000000ULL, kReserve, kTotal);
      Check(Read(registry)["holders"][0]["service"] == "llm-service");
    }
    std::cout << Json{{"exclusive_protocol",2},{"checks",10},{"production_registry_accessed",false},{"bpu_tasks",0}} << '\n';
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
