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
  std::cout << "Async observation journal PASS\n";
}
