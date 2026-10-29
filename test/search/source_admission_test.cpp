// Pure concurrency/clock fence checks, no Mongo, PG, SDK or device.
#include "source_admission.hpp"
#include <atomic>
#include <iostream>
#include <thread>
using namespace ainvr::search;
namespace {int checks=0;void Check(bool ok){++checks;if(!ok)throw std::runtime_error("source_admission_contract");}}
int main(){try{
  using Clock=std::chrono::steady_clock;const auto now=Clock::now();const int64_t wall=1000000;
  RuntimeIngestionGate gate{"plan","epoch","worker",std::string(64,'a'),2,wall+120000,
    {"siglip2-base-full-int8",std::string(64,'b'),"search-v1-"+std::string(64,'b')}};
  SourceAdmission owner;auto old=owner.TryEnter(now);Check(bool(old));owner.Apply(gate,wall,now);
  Check(!owner.TryEnter(now));Check(!owner.DrainedGate(now));old.reset();Check(bool(owner.DrainedGate(now)));
  Check(!owner.TryEnter(now+std::chrono::seconds(119)));Check(!owner.TryEnter(now+std::chrono::seconds(120)));
  Check(!owner.DrainedGate(now+std::chrono::seconds(120)));
  auto renewed=gate;renewed.expires_ms=wall+360000;owner.Apply(renewed,wall+119000,now+std::chrono::seconds(119));
  Check(!owner.TryEnter(now+std::chrono::seconds(120))); // Same epoch never resumes admission.
  Check(!owner.DrainedGate(now+std::chrono::seconds(120))); // Renewal never extends the 120s ACK bound.
  Check(!owner.TryEnter(now+std::chrono::hours(24)));
  Check(!owner.DrainedGate(now+std::chrono::hours(24)));
  auto wrong=gate;wrong.worker="other";bool refused=false;try{owner.Apply(wrong,wall,now);}catch(...){refused=true;}Check(refused);
  Check(!owner.TryEnter(now+std::chrono::hours(24))); // Rejected renewal does not clear the latch.
  // The production controller must durably begin a new writer epoch first.
  owner.Apply(std::nullopt,wall+86400000,now+std::chrono::hours(24));Check(bool(owner.TryEnter(now+std::chrono::hours(24))));
  gate.epoch="next-epoch";gate.expires_ms=wall+5000;owner.Apply(gate,wall,now);Check(!owner.TryEnter(now+std::chrono::milliseconds(4999)));
  Check(bool(owner.DrainedGate(now+std::chrono::milliseconds(4999))));
  Check(!owner.TryEnter(now+std::chrono::milliseconds(5000)));
  Check(!owner.DrainedGate(now+std::chrono::milliseconds(5000)));
  Check(!owner.TryEnter(now+std::chrono::seconds(10)));
  // Already expired metadata still closes admission but cannot acknowledge.
  gate.epoch="expired-on-arrival";gate.expires_ms=wall;owner.Apply(gate,wall,now);
  Check(!owner.TryEnter(now));Check(!owner.DrainedGate(now));
  owner.Apply(std::nullopt,wall,now);
  std::atomic<bool> entered{false},release{false};std::thread writer([&]{auto p=owner.TryEnter();Check(bool(p));entered=true;while(!release.load())std::this_thread::yield();});
  while(!entered.load())std::this_thread::yield();
gate.epoch="concurrent";gate.expires_ms=wall+120000;owner.Apply(gate,wall);
  Check(!owner.DrainedGate());Check(!owner.TryEnter());release=true;writer.join();Check(bool(owner.DrainedGate()));
  // Expiration cannot admit a new writer while a pre-gate permit drains, nor
  // manufacture an ACK after that permit eventually releases.
  owner.Apply(std::nullopt,wall,now);auto draining=owner.TryEnter(now);Check(bool(draining));
  gate.epoch="expires-while-draining";gate.expires_ms=wall+5000;owner.Apply(gate,wall,now);
  Check(!owner.DrainedGate(now+std::chrono::milliseconds(4999)));
  Check(!owner.TryEnter(now+std::chrono::milliseconds(5000)));Check(!owner.DrainedGate(now+std::chrono::milliseconds(5000)));
  draining.reset();Check(!owner.DrainedGate(now+std::chrono::seconds(10)));Check(!owner.TryEnter(now+std::chrono::seconds(10)));
  owner.Apply(std::nullopt,wall+10000,now+std::chrono::seconds(10));Check(bool(owner.TryEnter(now+std::chrono::seconds(10))));
  // Permit may safely outlive its facade; its shared mutex is destroyed unlocked.
  std::optional<SourceAdmission::Permit> last;{SourceAdmission temporary;last=temporary.TryEnter();}last.reset();Check(true);
  std::cout<<checks<<" source-admission pure checks passed; no I/O\n";
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
