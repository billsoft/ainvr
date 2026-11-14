// SSD wear: at 15 frames/s the journal synced four times per record (state file and
// its directory, record and its directory), ~56 syncs/s and ~1.9 MB/s of device
// writes on .190 for ~0.14 MB/s of records. Records arriving close together now share
// one commit, and offsets are reserved in blocks so the state file is rarely rewritten.
#define main original_journal_test_main
#include "observation_journal_test.cpp"
#undef main
#include <fstream>
#include <sys/wait.h>

using ai_service::analytics::JournalDiag;
namespace {
nlohmann::json ReadState(const std::filesystem::path& dir) {
  std::ifstream in(dir / "producer.json"); nlohmann::json j; in >> j; return j;
}
uint64_t StateOffset(const std::filesystem::path& dir) {
  return std::stoull(ReadState(dir).at("next_offset").get<std::string>());
}
std::string Name(uint64_t offset) {
  std::string s = std::to_string(offset);
  return std::string(20 - s.size(), '0') + s + ".json";
}
}  // namespace

int main(int argc, char** argv) {
  assert(argc == 2);
  const std::string root = argv[1];
  const auto dir = [&](const std::string& r) { return std::filesystem::path(r) / ObservationJournal::Hash("processor"); };

  // 1. Records ~20 ms apart (a 50 fps stream) share commits instead of one each.
  {
    const std::string r = root + "-group";
    ObservationJournal journal(r, "processor", 64 * 1024 * 1024, 10000, 0);
    for (int i = 1; i <= 10; ++i) { journal.Stage(sample(i)); std::this_thread::sleep_for(std::chrono::milliseconds(20)); }
    assert(journal.Flush());
    assert(journal.Status().at("next_offset") == "10");
    assert(journal.Status().at("async_failures") == 0);
    assert(journal.Status().value("write_batches", uint64_t(1000)) <= 3);
    for (uint64_t o = 0; o < 10; ++o) assert(std::filesystem::exists(dir(r) / Name(o)));
  }
  // 2. Offsets are reserved in blocks: many batches, one state write.
  {
    const std::string r = root + "-reserve";
    ObservationJournal journal(r, "processor", 64 * 1024 * 1024, 10000, 0);
    const auto before = JournalDiag().state_writes.load();
    for (int i = 1; i <= 6; ++i) { journal.Stage(sample(i)); assert(journal.Flush()); }
    assert(journal.Status().value("write_batches", uint64_t(0)) == 6);
    assert(JournalDiag().state_writes.load() - before == 1);
    const auto ceiling = StateOffset(dir(r));
    assert(ceiling >= 6);                               // never behind a written record
    for (uint64_t o = 0; o < 6; ++o) assert(o < ceiling);
  }
  // 3. A crash (no destructor) restarts after the reserved block: no offset is reused.
  {
    const std::string r = root + "-crash";
    const pid_t child = fork();
    assert(child >= 0);
    if (child == 0) {
      auto* journal = new ObservationJournal(r, "processor", 64 * 1024 * 1024, 10000, 0);
      for (int i = 1; i <= 5; ++i) journal->Stage(sample(i));
      _exit(journal->Flush() ? 0 : 3);                  // the process dies holding the journal
    }
    int status = 0; assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    ObservationJournal next(r, "processor", 64 * 1024 * 1024, 10000, 0);
    const auto resumed = std::stoull(next.Status().at("next_offset").get<std::string>());
    assert(resumed >= 5);
    const auto old = ReadState(dir(r));
    next.Stage(sample(6)); assert(next.Flush());
    assert(std::filesystem::exists(dir(r) / Name(resumed)));
    for (uint64_t o = 0; o < 5; ++o) assert(std::filesystem::exists(dir(r) / Name(o)));
    assert(next.Status().at("producer_id") == old.at("producer_id"));
  }
  // 4. A graceful stop saves the exact offset: no gap across an ordinary restart.
  {
    const std::string r = root + "-graceful";
    { ObservationJournal journal(r, "processor", 64 * 1024 * 1024, 10000, 0);
      for (int i = 1; i <= 5; ++i) journal.Stage(sample(i)); assert(journal.Flush()); }
    assert(StateOffset(dir(r)) == 5);
    ObservationJournal next(r, "processor", 64 * 1024 * 1024, 10000, 0);
    assert(next.Status().at("next_offset") == "5");
  }
  std::cout << "observation journal wear contracts passed\n";
  return 0;
}
