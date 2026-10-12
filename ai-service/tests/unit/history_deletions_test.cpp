#include <gtest/gtest.h>
#include <fstream>
#include <unistd.h>
#include "../../src/output/history_deletions.hpp"

using ai_service::output::HistoryDeletions;
using ai_service::config::WriteDurableFile;

namespace {
struct Temp {
  std::filesystem::path dir;
  Temp() {
    char name[] = "/tmp/ainvr-history-fence-XXXXXX";
    dir = ::mkdtemp(name);
  }
  ~Temp() { std::filesystem::remove_all(dir); }
};
int sync_calls = 0;
int FailFirst(int) { return -1; }
int FailDirectory(int fd) { return ++sync_calls == 2 ? -1 : ::fsync(fd); }
}

TEST(DurableFile, FileSyncFailurePreservesOriginal) {
  Temp t;
  auto path = t.dir / "state.json";
  WriteDurableFile(path, "old");
  EXPECT_THROW(WriteDurableFile(path, "new", FailFirst), std::runtime_error);
  std::ifstream in(path); std::string value; in >> value;
  EXPECT_EQ(value, "old");
}

TEST(DurableFile, DirectorySyncFailureIsReported) {
  Temp t; sync_calls = 0;
  EXPECT_THROW(WriteDurableFile(t.dir / "state.json", "new", FailDirectory), std::runtime_error);
  EXPECT_EQ(sync_calls, 2);
}

TEST(HistoryDeletions, DeletedRetryCannotReappearAfterReload) {
  Temp t;
  HistoryDeletions fence; fence.Load(t.dir.string());
  auto accepted = fence.Epoch();
  fence.Add({{"image_id", "deleted-image"}});
  EXPECT_TRUE(fence.Matches(accepted, "deleted-image", 100));
  EXPECT_FALSE(fence.Matches(accepted, "other-image", 100));
  HistoryDeletions reload; reload.Load(t.dir.string());
  EXPECT_TRUE(reload.Matches(accepted, "deleted-image", 100));
  EXPECT_FALSE(reload.Matches(reload.Epoch(), "deleted-image", 100));
}

TEST(HistoryDeletions, RangeAndClearKeepNewCapturesEvenIfWallClockMovesBack) {
  Temp t;
  HistoryDeletions fence; fence.Load(t.dir.string());
  fence.Add({{"timestamp", {{"$gte", 10.0}, {"$lte", 20.0}}}});
  EXPECT_TRUE(fence.Matches(0, "a", 15));
  EXPECT_FALSE(fence.Matches(0, "b", 21));
  fence.Add(nlohmann::json::object());
  EXPECT_TRUE(fence.Matches(1, "b", 21));
  EXPECT_FALSE(fence.Matches(fence.Epoch(), "new-frame", 5));
  EXPECT_EQ(fence.Rules().size(), 1);
}

TEST(HistoryDeletions, InvalidFiltersDoNotAdvanceEpochOrChangeRules) {
  HistoryDeletions fence; fence.Add({{"image_id", "kept-rule"}});
  const auto before = fence.Rules();
  std::vector<nlohmann::json> invalid = {
    nullptr, nlohmann::json::array(), {{"unknown", true}}, {{"image_id", ""}},
    {{"image_id", 42}}, {{"image_id", "x"}, {"timestamp", {{"$gte", 1}, {"$lte", 2}}}},
    {{"timestamp", {{"$gte", 2}, {"$lte", 1}}}}, {{"timestamp", {{"$gte", 1}}}},
    {{"timestamp", {{"$gte", "1"}, {"$lte", 2}}}},
    {{"timestamp", {{"$gte", 1}, {"$lte", std::numeric_limits<double>::infinity()}}}}
  };
  for (const auto& filter : invalid) {
    EXPECT_THROW(fence.Add(filter), std::invalid_argument);
    EXPECT_EQ(fence.Epoch(), 1u); EXPECT_EQ(fence.Rules(), before);
  }
}

TEST(HistoryDeletions, CorruptJournalFailsBeforeReplacingCurrentState) {
  Temp t; HistoryDeletions fence; fence.Add({{"image_id", "old-rule"}});
  const auto before = fence.Rules();
  std::vector<nlohmann::json> invalid = {
    {{"schema",1},{"epoch",1},{"rules",nlohmann::json::array()}},
    {{"schema",1},{"epoch",-1},{"rules",nlohmann::json::array()}},
    {{"schema",1},{"epoch",1},{"rules",nlohmann::json::array({{{"epoch",0},{"filter",nlohmann::json::object()}}})}},
    {{"schema",1},{"epoch",1},{"rules",nlohmann::json::array({{{"epoch",1},{"filter",{{"bad",true}}}}})}},
    {{"schema",1},{"epoch",2},{"rules",nlohmann::json::array({{{"epoch",2},{"filter",nlohmann::json::object()}},{{"epoch",1},{"filter",nlohmann::json::object()}}})}}
  };
  for (const auto& state : invalid) {
    WriteDurableFile(t.dir / "deletions.json", state.dump());
    EXPECT_ANY_THROW(fence.Load(t.dir.string()));
    EXPECT_EQ(fence.Epoch(), 1u); EXPECT_EQ(fence.Rules(), before);
    EXPECT_TRUE(std::filesystem::exists(t.dir / "deletions.json"));
  }
}

TEST(HistoryDeletions, ClearJournalCanReloadWithCompactedEpochs) {
  Temp t; HistoryDeletions fence; fence.Load(t.dir.string());
  fence.Add({{"image_id","a"}}); fence.Add({{"image_id","b"}}); fence.Add(nlohmann::json::object());
  HistoryDeletions reloaded; reloaded.Load(t.dir.string());
  EXPECT_EQ(reloaded.Epoch(), 3u); EXPECT_EQ(reloaded.Rules().size(), 1u);
  EXPECT_TRUE(reloaded.Matches(2,"b",100)); EXPECT_FALSE(reloaded.Matches(3,"b",100));
}
