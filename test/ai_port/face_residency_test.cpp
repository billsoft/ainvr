#include "face_embedding_test_fixture.hpp"
#include "face_identity/residency.hpp"
#include "../../shared/cpp/bpu_coexist_reservation.hpp"
#include <gtest/gtest.h>
using namespace ainvr::face;
using namespace face_test;
namespace {
Settings Enabled(){Settings s;s.enabled=true;s.detector=Spec("face-det-scrfd-500m",false);s.embedding=Spec();return s;}
}
TEST(FaceResidency,BaseAndFaceUpdatesNeverEraseEachOther){
  Demand actual;Residency r([](const Settings&){return Reservation{std::make_shared<int>(1),{}};},[&](Demand d){actual=std::move(d);});
  r.SetBase({{"channel.hbm:",{"channel:1"}}});auto lease=r.Apply(Enabled());EXPECT_EQ(actual.size(),3);
  r.SetBase({{"next.hbm:",{"channel:2"}}});EXPECT_EQ(actual.size(),3);EXPECT_TRUE(actual.contains("next.hbm:"));
  r.Apply({});EXPECT_EQ(actual.size(),1);EXPECT_FALSE(lease.Valid());
}
TEST(FaceResidency,BudgetRemainsUntilSdkModelAndLeaseBothRetire){
  std::weak_ptr<int> allocation;Residency r([&](const Settings&){auto a=std::make_shared<int>(1);allocation=a;return Reservation{a,{}};},[](Demand){});
  auto lease=r.Apply(Enabled());auto model=std::make_shared<int>(7);lease.observe_model(model);
  r.Apply({});lease={};r.Reap();EXPECT_FALSE(allocation.expired());EXPECT_EQ(r.Holdings(),1);
  model.reset();r.Reap();EXPECT_TRUE(allocation.expired());EXPECT_EQ(r.Holdings(),0);
}
TEST(FaceResidency,FailedNewAdmissionKeepsExistingLeaseAndDemand){
  bool fail=false;Demand actual;Residency r([&](const Settings&){if(fail)throw std::runtime_error("budget");return Reservation{std::make_shared<int>(1),{}};},[&](Demand d){actual=std::move(d);});
  auto lease=r.Apply(Enabled());auto before=actual;fail=true;EXPECT_THROW(r.Apply(Enabled()),std::runtime_error);EXPECT_EQ(actual,before);EXPECT_TRUE(lease.Valid());
}
TEST(FaceResidency,SharedDetectorTransfersBudgetButOldEmbeddingRemainsCovered){
  std::vector<std::weak_ptr<int>> budgets;
  Residency r([&](const Settings&){auto a=std::make_shared<int>(1);budgets.push_back(a);return Reservation{a,{}};},[](Demand){});
  auto detector=std::make_shared<int>(1),old_embedding=std::make_shared<int>(2),new_embedding=std::make_shared<int>(3);
  auto old=r.Apply(Enabled());old.observe_model(detector);old.observe_model(old_embedding);
  auto next=r.Apply(Enabled());next.observe_model(detector);next.observe_model(new_embedding);
  old={};r.Reap();EXPECT_FALSE(budgets[0].expired()); // old embedding is still alive
  old_embedding.reset();r.Reap();EXPECT_TRUE(budgets[0].expired());EXPECT_FALSE(budgets[1].expired());
  EXPECT_EQ(r.Holdings(),1); // common detector is now covered by next admission
  r.Apply({});next={};r.Reap();EXPECT_FALSE(budgets[1].expired());
  detector.reset();new_embedding.reset();r.Reap();EXPECT_TRUE(budgets[1].expired());
}
TEST(FaceResidency,RepeatedSharedSingletonSwitchesDoNotExhaustRetirementCapacity){
  Residency r([](const Settings&){return Reservation{std::make_shared<int>(1),{}};},[](Demand){});
  auto shared=std::make_shared<int>(1);BudgetLease lease;
  for(int i=0;i<20;++i){auto next=r.Apply(Enabled());next.observe_model(shared);lease=std::move(next);r.Reap();EXPECT_EQ(r.Holdings(),1);}
  r.Apply({});lease={};shared.reset();r.Reap();EXPECT_EQ(r.Holdings(),0);
}
TEST(FaceResidency,FailedPublicationDoesNotRetireOldLease){
  bool fail=false;Residency r([](const Settings&){return Reservation{std::make_shared<int>(1),{}};},[&](Demand){if(fail)throw std::runtime_error("publish");});
  auto lease=r.Apply(Enabled());fail=true;EXPECT_THROW(r.Apply({}),std::runtime_error);EXPECT_TRUE(lease.Valid());
}
TEST(FaceResidency,RealLedgerAcceptsAiServiceAndRemovesOnlyOwnRow){
  // Real flock/registry operations in an isolated test directory; no /run or SDK.
  const auto path=std::filesystem::current_path()/"test/ai_port"/("face-ledger-"+std::to_string(getpid()));
  ASSERT_TRUE(std::filesystem::create_directory(path));
  ainvr::IonPolicy policy;policy.pool_bytes=8ULL<<30;
  ainvr::IonProbe probe;probe.pid_bytes=[](int){return uint64_t(0);};probe.others_bytes=[](const std::set<int>&){return uint64_t(0);};
  {
    ainvr::BpuCoexistReservation search(path.string(),"search-service",256ULL<<20,policy,probe);
    {ainvr::BpuCoexistReservation face(path.string(),"ai-service",512ULL<<20,policy,probe);face.Loaded();
      std::ifstream f(path/"bpu-reservations.json");auto j=Json::parse(f);EXPECT_EQ(j.at("holders").size(),2);}
    std::ifstream f(path/"bpu-reservations.json");auto j=Json::parse(f);ASSERT_EQ(j.at("holders").size(),1);EXPECT_EQ(j.at("holders").at(0).at("service"),"search-service");
  }
  std::filesystem::remove_all(path);
}
