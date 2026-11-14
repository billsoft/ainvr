// Stage() must not wait for durable writes; the on-disk protocol stays unchanged.
#define main original_journal_test_main
#include "observation_journal_test.cpp"
#undef main
#include <atomic>
#include <condition_variable>
#include <fstream>
#include <mutex>

namespace {
struct Gate {
  std::mutex m;
  std::condition_variable cv;
  bool open = false;
  void Wait() { std::unique_lock<std::mutex> l(m); cv.wait(l, [&] { return open; }); }
  void Open() { { std::lock_guard<std::mutex> l(m); open = true; } cv.notify_all(); }
};
nlohmann::json ReadJson(const std::filesystem::path& p) {
  std::ifstream in(p);
  nlohmann::json j;
  in >> j;
  return j;
}
std::string Name(uint64_t offset) {
  std::string s = std::to_string(offset);
  return std::string(20 - s.size(), '0') + s + ".json";
}
}  // namespace

int main(int argc, char** argv) {
  assert(argc == 2);
  const std::string root = argv[1];
  const auto channel_dir = [&](const std::string& r) { return std::filesystem::path(r) / ObservationJournal::Hash("processor"); };

  // 1. A held writer never blocks Stage; records land later, in FIFO order, with no gap.
  {
    Gate gate;
    const std::string r = root + "-gated";
    ObservationJournal journal(r, "processor", 64 * 1024 * 1024, 10000, 0, [&] { gate.Wait(); });
    const auto t0 = std::chrono::steady_clock::now();
    for (int i = 1; i <= 40; ++i) journal.Stage(sample(i));
    const auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    assert(ms < 500);                                       // fsync stall would take far longer
    assert(journal.Status().at("queued") == 40);
    assert(journal.Status().at("next_offset") == "0");      // offsets are reserved by the writer
    size_t records = 0;
    for (const auto& e : std::filesystem::directory_iterator(channel_dir(r)))
      if (e.path().filename().string().size() == 25) ++records;
    assert(records == 0);                                   // queued-but-unwritten leaves no gap
    gate.Open();
    assert(journal.Flush());
    assert(journal.Status().at("next_offset") == "40");
    assert(journal.Status().at("async_failures") == 0);
    const auto state_offset = std::stoull(ReadJson(channel_dir(r) / "producer.json").at("next_offset").get<std::string>());
    for (uint64_t o = 0; o < 40; ++o) {
      const auto j = ReadJson(channel_dir(r) / Name(o));
      assert(j.at("offset") == std::to_string(o));
      assert(j.at("source_frame_index") == std::to_string(o + 1));  // FIFO preserved
      assert(o < state_offset);                                     // producer.json never behind a record
    }
  }

  // 2. A full queue blocks (backpressure) and never drops.
  {
    Gate gate;
    const std::string r = root + "-full";
    ObservationJournal journal(r, "processor", 64 * 1024 * 1024, 10000, 0, [&] { gate.Wait(); });
    std::atomic<int> staged{0};
    std::thread producer([&] { for (int i = 1; i <= 300; ++i) { journal.Stage(sample(i)); ++staged; } });
    std::this_thread::sleep_for(std::chrono::milliseconds(400));
    assert(staged.load() < 300);                            // blocked by the bounded queue
    gate.Open();
    producer.join();
    assert(journal.Flush());
    assert(journal.Status().at("next_offset") == "300");    // nothing dropped
    assert(journal.Status().at("async_failures") == 0);
  }

  // 3. Destruction drains the queue before releasing the writer lock (Stop -> Start).
  {
    const std::string r = root + "-lifecycle";
    {
      ObservationJournal journal(r, "processor", 64 * 1024 * 1024, 10000, 0,
                                 [] { std::this_thread::sleep_for(std::chrono::milliseconds(20)); });
      for (int i = 1; i <= 10; ++i) journal.Stage(sample(i));
    }
    ObservationJournal next(r, "processor", 64 * 1024 * 1024, 10000, 0);  // would throw if the lock were still held
    assert(next.Status().at("next_offset") == "10");
    for (uint64_t o = 0; o < 10; ++o) assert(std::filesystem::exists(channel_dir(r) / Name(o)));
    next.Stage(sample(11));
    assert(next.Flush());
    assert(next.Status().at("next_offset") == "11");
  }
  // 4. Evidence gates only the ordered writer, not the producer. A later
  // frame must not overtake a pending receipt. Failed/broken receipts stay failed.
  {
    const std::string r=root+"-evidence";
    ObservationJournal journal(r,"processor",64*1024*1024,10000,0);
    std::promise<bool> first,second,failed;
    auto a=first.get_future().share(),b=second.get_future().share(),c=failed.get_future().share();
    std::shared_future<bool> broken;
    {std::promise<bool> abandoned;broken=abandoned.get_future().share();}
    journal.Stage(sample(1),a);journal.Stage(sample(2),b);journal.Stage(sample(3),c);journal.Stage(sample(4),broken);
    second.set_value(true);failed.set_value(false);
    assert(!journal.Flush(std::chrono::milliseconds(50)));
    assert(journal.Status().at("next_offset")=="0");
    first.set_value(true);assert(journal.Flush());
    for(int i=0;i<4;++i){auto record=ReadJson(channel_dir(r)/Name(i));
      assert(record.at("source_frame_index")==std::to_string(i+1));
      assert(record.at("evidence_delivery").at("state")== (i<2?"durable":"failed"));
    }
    assert(journal.Status().at("async_failures")==0);
  }
  // 5. A backlog is committed in batches: one state save and one directory sync per
  // batch, with every record still fsynced, in order, without gaps. Four syncs per
  // record capped the journal (and, through backpressure, inference) near 15/s.
  {
    Gate gate;
    const std::string r = root + "-batch";
    ObservationJournal journal(r, "processor", 64 * 1024 * 1024, 10000, 0, [&] { gate.Wait(); });
    for (int i = 1; i <= 40; ++i) journal.Stage(sample(i));
    gate.Open();
    assert(journal.Flush());
    assert(journal.Status().at("next_offset") == "40");
    assert(journal.Status().at("async_failures") == 0);
    assert(journal.Status().value("write_batches", uint64_t(1000)) <= 3);
    const auto state_offset = std::stoull(ReadJson(channel_dir(r) / "producer.json").at("next_offset").get<std::string>());
    // A reserved ceiling while running (offsets are reserved in blocks); exact after a graceful stop.
    assert(state_offset >= 40 && state_offset <= 40 + 4096);
    for (uint64_t o = 0; o < 40; ++o) {
      const auto j = ReadJson(channel_dir(r) / Name(o));
      assert(j.at("offset") == std::to_string(o));
      assert(j.at("source_frame_index") == std::to_string(o + 1));
    }
    for (const auto& e : std::filesystem::directory_iterator(channel_dir(r)))
      assert(e.path().filename().string().find(".writer-tmp") == std::string::npos);
  }
  std::cout << "Async observation journal PASS\n";
}
