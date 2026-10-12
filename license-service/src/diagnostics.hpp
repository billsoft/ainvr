#pragma once
#include <condition_variable>
#include <deque>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <syncstream>
#include <thread>
#include <nlohmann/json.hpp>
namespace ainvr_license {
// 诊断日志只记调用方挑选的时间/计数字段，绝不记密钥、令牌、信封。
//
// 调用方常常持有授权全局锁，所以这里绝不在调用线程里做 I/O：只把一行 JSON 放进有界队列，
// 由独立线程写出。输出端（journald/磁盘）卡住时，队列满了丢最旧的并在恢复后补一条丢弃计数，
// 调用方永远不会被拖住。
class DiagnosticWriter {
 public:
  using Sink=std::function<void(const std::string&)>;
  static constexpr int kQueueLimit=256;
  static DiagnosticWriter& Instance(){static DiagnosticWriter w;return w;}
  void Push(std::string line){
    std::lock_guard lk(mu_);
    if(static_cast<int>(queue_.size())>=kQueueLimit){queue_.pop_front();++dropped_;}
    queue_.push_back(std::move(line));
    cv_.notify_one();
  }
  void SetSink(Sink s){std::lock_guard lk(mu_);sink_=std::move(s);}
  void Flush(){
    std::unique_lock lk(mu_);
    idle_cv_.wait(lk,[&]{return queue_.empty()&&!busy_;});
  }
 private:
  DiagnosticWriter():worker_([this]{Loop();}){}
  ~DiagnosticWriter(){
    {std::lock_guard lk(mu_);stop_=true;}
    cv_.notify_all();
    if(worker_.joinable())worker_.join();
  }
  void Loop(){
    std::unique_lock lk(mu_);
    for(;;){
      cv_.wait(lk,[&]{return stop_||!queue_.empty();});
      if(queue_.empty()){if(stop_)return;continue;}
      std::string line=std::move(queue_.front());queue_.pop_front();busy_=true;
      int dropped=dropped_;dropped_=0;auto sink=sink_;
      lk.unlock();
      Write(sink,line,dropped);
      lk.lock();busy_=false;idle_cv_.notify_all();
    }
  }
  static void Write(const Sink&sink,const std::string&line,int dropped) noexcept {
    try{
      if(dropped>0){
        nlohmann::json n={{"event","diagnostics_dropped"},{"dropped",dropped},{"component","license"}};
        Emit(sink,n.dump());
      }
      Emit(sink,line);
    }catch(...){}
  }
  static void Emit(const Sink&sink,const std::string&line){
    if(sink)sink(line);else std::osyncstream(std::cerr)<<line<<'\n';
  }
  std::mutex mu_;
  std::condition_variable cv_,idle_cv_;
  std::deque<std::string> queue_;
  Sink sink_;
  int dropped_=0;
  bool stop_=false,busy_=false;
  std::thread worker_;   // 最后声明：其余成员先构造完才启动线程
};
inline int DiagnosticQueueLimit(){return DiagnosticWriter::kQueueLimit;}
inline void SetDiagnosticSink(DiagnosticWriter::Sink s){DiagnosticWriter::Instance().SetSink(std::move(s));}
inline void FlushDiagnostics() noexcept {try{DiagnosticWriter::Instance().Flush();}catch(...){}}
inline void LicenseDiagnostic(nlohmann::json fields) noexcept {
  try {
    fields["component"] = "license";
    DiagnosticWriter::Instance().Push(fields.dump());
  } catch (...) {}
}
}
