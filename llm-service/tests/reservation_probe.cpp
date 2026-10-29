// Holds a protocol-3 reservation until stdin closes. The unmanaged-ION probe is faked to zero so the lifecycle-lock test
// does not depend on whatever the live board holds in ION (e.g. a resident Qwen service).
#include "reservation.hpp"
#include <iostream>
#include <fstream>
int main(int argc, char** argv) {
  try {
    if (argc < 2 || argc > 3) throw std::runtime_error("invalid_probe_arguments");
    const std::string mode = argc > 2 ? argv[2] : "";
    ainvr::IonPolicy policy;
    policy.pool_bytes = mode == "insufficient" ? 1 : 8053063680ULL;
    policy.min_free = 512ULL * 1024 * 1024;
    ainvr::IonProbe probe;
    probe.pid_bytes = [](int) { return uint64_t(0); };
    probe.others_bytes = [](const std::set<int>&) { return uint64_t(0); };
    if (mode == "collision" || mode == "collision-symlink") {
      const auto path = std::string(argv[1]) + "/bpu-reservations.json." + std::to_string(getpid()) + ".1.tmp";
      if (mode == "collision") { std::ofstream file(path); file << "not-ours"; }
      else if (symlink("collision-target", path.c_str())) throw std::runtime_error("probe_fixture_failed");
    }
    ainvr::BpuCoexistReservation r(argv[1], "llm-service", mode.empty() ? 5500000000ULL : (64ULL << 20), policy, probe);
    r.Loaded();
    std::cout << "locked" << std::endl;
    std::string line;
    std::getline(std::cin, line);
    return 0;
  } catch (const std::exception& e) { std::cerr << e.what(); return 2; }
}
