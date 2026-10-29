#include "../../shared/cpp/bpu_coexist_reservation.hpp"
#include <csignal>
#include <iostream>
#include <sys/wait.h>

using Json = nlohmann::json;
namespace fs = std::filesystem;
namespace {
constexpr uint64_t M = 1024*1024;
void Check(bool value,const char* message) { if (!value) throw std::runtime_error(message); }
struct Temp {
  std::string path;
  Temp() { char name[]="/tmp/ainvr-ion-accounting-XXXXXX";auto* p=mkdtemp(name);Check(p,"private_directory_failed");path=p; }
  ~Temp() { std::error_code error;fs::remove_all(path,error); }
};
void Reject(const std::function<void()>& fn) {
  try {fn();} catch(const std::runtime_error& e) {Check(std::string(e.what())=="ion_budget_exceeded","unexpected_rejection");return;}
  throw std::runtime_error("unsafe_admission_allowed");
}
ainvr::IonPolicy Policy(uint64_t pool) {ainvr::IonPolicy p;p.pool_bytes=pool*M;p.min_free=64*M;return p;}
struct Children {
  pid_t pid=-1;
  ~Children() {if(pid>0){kill(pid,SIGKILL);int status=0;waitpid(pid,&status,0);}}
};
}  // namespace
int main() {
  try {
    size_t cases=0;
    {
      Temp tmp;const int self=getpid();bool saw_self_excluded=true;
      ainvr::IonProbe probe;
      probe.pid_bytes=[](int){return 206*M;};
      probe.others_bytes=[&](const std::set<int>& excluded){saw_self_excluded=excluded.count(self);return saw_self_excluded?0:206*M;};
      Reject([&]{ainvr::BpuCoexistReservation r(tmp.path,"search-service",700*M,Policy(1024),probe);});
      Check(!saw_self_excluded&&!fs::exists(fs::path(tmp.path)/"bpu-reservations.json"),"first_pid_baseline_omitted");++cases;
      ainvr::BpuCoexistReservation enough(tmp.path,"search-service",700*M,Policy(1200),probe);
      Check(enough.Decision().registered_used==0&&enough.Decision().other_reserved==334*M&&enough.Decision().spare==102*int64_t(M),"first_pid_sufficient_budget");++cases;
    }
    {
      Temp tmp;const int self=getpid();uint64_t measured=206*M;int pid_reads=0;
      ainvr::IonProbe probe;
      probe.pid_bytes=[&](int pid){Check(pid==self,"unexpected_pid_probe");++pid_reads;return measured;};
      probe.others_bytes=[&](const std::set<int>& excluded){return excluded.count(self)?0:measured;};
      ainvr::BpuCoexistReservation first(tmp.path,"search-service",103*M,Policy(4096),probe);
      measured=309*M;pid_reads=0;
      ainvr::BpuCoexistReservation second(tmp.path,"search-service",475*M,Policy(4096),probe);
      Check(second.Decision().registered_used==309*M&&second.Decision().other_reserved==256*M&&pid_reads==1,"second_holder_double_counted");++cases;
      measured=784*M;pid_reads=0;
      ainvr::BpuCoexistReservation third(tmp.path,"search-service",50*M,Policy(4096),probe);
      Check(third.Decision().registered_used==784*M&&third.Decision().other_reserved==256*M&&pid_reads==1,"same_pid_rows_not_merged");++cases;
    }
    {
      Temp tmp;Children child;int ready[2];Check(pipe(ready)==0,"pipe_failed");child.pid=fork();Check(child.pid>=0,"fork_failed");
      if(child.pid==0) {
        close(ready[0]);alarm(10);
        try {
          ainvr::IonProbe p;p.pid_bytes=[](int){return 450*M;};p.others_bytes=[](const std::set<int>&){return uint64_t(0);};
          ainvr::BpuCoexistReservation a(tmp.path,"llm-service",300*M,Policy(4096),p);
          ainvr::BpuCoexistReservation b(tmp.path,"llm-service",100*M,Policy(4096),p);
          if(write(ready[1],"L",1)!=1)_exit(21);
          for(;;)pause();
        }catch(...){_exit(22);}
      }
      close(ready[1]);char signal=0;Check(read(ready[0],&signal,1)==1&&signal=='L',"child_reservation_failed");close(ready[0]);
      const int self=getpid();int reads=0;
      ainvr::IonProbe p;
      p.pid_bytes=[&](int pid){Check(pid==child.pid,"wrong_registered_pid");++reads;return 450*M;};
      p.others_bytes=[&](const std::set<int>& excluded){Check(excluded.count(child.pid)&&!excluded.count(self),"registered_pid_exclusion_invalid");return 206*M;};
      Reject([&]{ainvr::BpuCoexistReservation denied(tmp.path,"search-service",500*M,Policy(1280),p);});++cases;
      reads=0;ainvr::BpuCoexistReservation accepted(tmp.path,"search-service",500*M,Policy(1400),p);
      Check(accepted.Decision().registered_used==450*M&&accepted.Decision().other_reserved==334*M&&reads==1,"other_pid_rows_double_counted");++cases;
    }
    {
      auto d=ainvr::EvaluateIonAdmission(Policy(4096),{{101,"llm-service",600*M,450*M}},0,475*M);
      Check(d.registered_used==600*M&&d.other_reserved==256*M&&d.ok,"declared_floor_not_applied");++cases;
      auto boundary=ainvr::EvaluateIonAdmission(Policy(1098),{},206*M,700*M);
      Check(boundary.ok&&boundary.spare==0,"exact_budget_boundary");++cases;
      auto denied=ainvr::EvaluateIonAdmission(Policy(1098),{},206*M,700*M+1);
      Check(!denied.ok&&denied.spare==-1,"one_byte_over_budget");++cases;
    }
    std::cout<<Json{{"pure_budget_cases",cases},{"fake_probes_only",true},{"production_registry_accessed",false},{"bpu_tasks",0}}<<'\n';
  }catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
