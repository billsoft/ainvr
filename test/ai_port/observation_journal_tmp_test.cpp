// Failed durable writes must not leave unaccounted .writer-tmp files on the eMMC.
#define main original_journal_test_main
#include "observation_journal_test.cpp"
#undef main
#include <csignal>
#include <fstream>
#include <sys/resource.h>

namespace {
size_t TempBytes(const std::filesystem::path& dir, size_t* count = nullptr) {
  size_t bytes = 0, n = 0;
  for (const auto& e : std::filesystem::directory_iterator(dir)) {
    const auto name = e.path().filename().string();
    if (name.size() > 11 && name.substr(name.size() - 11) == ".writer-tmp") { bytes += e.file_size(); ++n; }
  }
  if (count) *count = n;
  return bytes;
}
}  // namespace

int main(int argc, char** argv) {
  assert(argc == 2);
  const std::string root = argv[1];
  const auto dir = [&](const std::string& r) { return std::filesystem::path(r) / ObservationJournal::Hash("processor"); };

  // 1. A real write failure (file-size limit => EFBIG after a partial write) must clean its temp file.
  {
    const std::string r = root + "-fail";
    ObservationJournal journal(r, "processor", 64 * 1024 * 1024, 10000, 0);
    std::signal(SIGXFSZ, SIG_IGN);
    rlimit old{};
    getrlimit(RLIMIT_FSIZE, &old);
    rlimit tiny{100, old.rlim_max};
    setrlimit(RLIMIT_FSIZE, &tiny);
    for (int i = 1; i <= 20; ++i) journal.Stage(sample(i));
    assert(journal.Flush());
    setrlimit(RLIMIT_FSIZE, &old);
    assert(journal.Status().at("async_failures").get<int>() > 0);
    assert(TempBytes(dir(r)) == 0);                       // nothing left behind by the failed writes
    journal.Stage(sample(21));                            // and the journal recovers once writes work again
    assert(journal.Flush());
  }

  // 2. A previous crash may leave temp files; the single owner removes them on start.
  {
    const std::string r = root + "-stale";
    std::filesystem::create_directories(dir(r));
    { ObservationJournal first(r, "processor", 64 * 1024 * 1024, 10000, 0); }
    { std::ofstream(dir(r) / "00000000000000000007.json.writer-tmp") << std::string(3000, 'x'); }
    ObservationJournal journal(r, "processor", 64 * 1024 * 1024, 10000, 0);
    assert(TempBytes(dir(r)) == 0);
  }

  // 3. Leftover temp bytes count against the byte cap when usage is recounted.
  {
    const std::string r = root + "-count";
    ObservationJournal journal(r, "processor", 4096, 2, 0);
    journal.Stage(sample(1)); journal.Stage(sample(2));
    assert(journal.Flush());
    { std::ofstream(dir(r) / "00000000000000000099.json.writer-tmp") << std::string(5000, 'x'); }
    std::filesystem::remove(dir(r) / "00000000000000000000.json");   // one record slot is free again
    std::this_thread::sleep_for(std::chrono::milliseconds(1100));    // allow the recount
    bool rejected = false;
    try { journal.Stage(sample(3)); } catch (...) { rejected = true; }
    assert(rejected);                                                // 5000 B of temp > 4096 B cap
  }
  std::cout << "Observation journal temp-file accounting PASS\n";
}
