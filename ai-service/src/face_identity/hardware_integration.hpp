// Copyright AINVR. Real cross-service admission; no permissive/fake default.
#pragma once
#include "face_embedding/hardware.hpp"
#include "residency.hpp"
#include "../../../shared/cpp/bpu_coexist_reservation.hpp"
#include "../../../shared/cpp/bpu_reserved_pool.hpp"
#include "../../../shared/cpp/bpu_dma_buffer.hpp"

namespace ainvr::face {
inline uint64_t ReservationBytes(const Settings& settings){
  // Conservative admission ceiling for HBM + tensors/workspace + JPEG/GLES.
  // This is an estimate, never a claim of measured SDK usage or capacity.
  const uint64_t hbm=settings.detector.bytes+settings.embedding.bytes;
  return (512ULL<<20)+4*((hbm+(1ULL<<20)-1)>>20)*(1ULL<<20);
}
struct NativeReservation {
  std::unique_ptr<BpuCoexistReservation> reservation;
  explicit NativeReservation(const Settings& settings){
    if(!BpuRuntimeHealthy())throw std::runtime_error("face_bpu_fault");
    IonPolicy policy;policy.pool_bytes=ReadBpuIonBudgetBytes();policy.min_free=256ULL<<20;
    reservation=std::make_unique<BpuCoexistReservation>("/run/ainvr","ai-service",ReservationBytes(settings),policy);
  }
  ~NativeReservation(){if(!BpuRuntimeHealthy())(void)reservation.release();}
  void Loaded(){
    // Verify actual allocatable headroom after SDK load, not just ledger maths.
    {BpuDmaBuffer probe(256ULL<<20);}
    reservation->Loaded();
  }
};
inline std::shared_ptr<Residency> MakeResidency(){
  return std::make_shared<Residency>([](const Settings& settings){
    auto resource=std::make_shared<NativeReservation>(settings);
    return Reservation{resource,[resource]{resource->Loaded();}};
  },[](Demand demand){BpuModel::ConfigureResidency(std::move(demand));});
}
} // namespace ainvr::face
