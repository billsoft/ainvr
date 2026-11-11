#include "stream/async_packet_reader.hpp"
#include <gtest/gtest.h>
#include <atomic>
#include <future>
#include <stdexcept>
#include <vector>
using ai_service::stream::AsyncPacketReader;
using namespace std::chrono_literals;

TEST(AsyncPacketReader, PreservesOrderAndDrainsBeforeEof) {
  int next=0;
  AsyncPacketReader<int> reader([&]()->std::optional<int>{
    if(next==500)return {};return next++;
  },[]{});
  for(int i=0;i<500;++i){auto r=reader.Poll(2s);ASSERT_FALSE(r.pending);ASSERT_TRUE(r.packet);EXPECT_EQ(*r.packet,i);}
  auto r=reader.Poll(2s);EXPECT_FALSE(r.pending);EXPECT_FALSE(r.packet);
}
TEST(AsyncPacketReader, BackpressureBoundsReadAheadToOnePacket) {
  std::atomic<int> reads=0;std::promise<void> started;
  AsyncPacketReader<int> reader([&]()->std::optional<int>{
    int n=++reads;if(n==1)started.set_value();return n;
  },[]{});
  started.get_future().wait();std::this_thread::sleep_for(20ms);
  EXPECT_EQ(reads,1);
}
TEST(AsyncPacketReader, SlowNetworkDoesNotBlockHardwarePollingAndCancels) {
  std::promise<void> release;auto gate=release.get_future().share();
  std::atomic<bool> cancelled=false;
  {
    AsyncPacketReader<int> reader([&]()->std::optional<int>{gate.wait();return {};},
      [&]{cancelled=true;release.set_value();});
    auto r=reader.Poll(2ms);EXPECT_TRUE(r.pending);EXPECT_FALSE(r.packet);
  }
  EXPECT_TRUE(cancelled);
}
TEST(AsyncPacketReader, ReportsReadFailureRatherThanFalseEof) {
  AsyncPacketReader<int> reader([]()->std::optional<int>{throw std::runtime_error("read failed");},[]{});
  EXPECT_THROW(reader.Poll(2s),std::runtime_error);
}
TEST(AsyncPacketReader, CancelsWithOccupiedSlot) {
  std::atomic<bool> cancelled=false;
  {
    AsyncPacketReader<std::vector<int>> reader([]()->std::optional<std::vector<int>>{
      return std::vector<int>(100,7);
    },[&]{cancelled=true;});
    auto r=reader.Poll(2s);ASSERT_TRUE(r.packet);EXPECT_EQ(r.packet->size(),100u);
  }
  EXPECT_TRUE(cancelled);
}
