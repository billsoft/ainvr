#pragma once
// Compatibility alias: Qwen keeps the same four-argument API, identity,
// exclusive protocol-2 registry and lifecycle lock.
#include "../../shared/cpp/bpu_reservation.hpp"
namespace ainvr::llm {
using Reservation = ainvr::BpuReservation;
}
