#pragma once
// Qwen keeps the four-argument API but now uses protocol 3: byte-accounted coexistence with other resident BPU models
// (search-service). It still excludes protocol-2 (exclusive) holders, e.g. the LocateAnything executor, both ways.
#include "../../shared/cpp/bpu_coexist_reservation.hpp"
namespace ainvr::llm {
class Reservation : public ainvr::BpuCoexistReservation {
 public:
  Reservation(std::string dir, uint64_t bytes, uint64_t min_free, uint64_t total)
      : BpuCoexistReservation(std::move(dir), "llm-service", bytes, Policy(total, min_free)) {}
 private:
  static ainvr::IonPolicy Policy(uint64_t total, uint64_t min_free) {
    ainvr::IonPolicy p; p.pool_bytes = total; p.min_free = min_free; return p;
  }
};
}  // namespace ainvr::llm
