// Copyright AINVR. Deterministic parser/display routing; no hardware calls.
#include "platform/picture_tokens.hpp"
#include <gtest/gtest.h>
TEST(PictureTokens, ReordersBFramesWithoutChangingTokens){
  ainvr::PictureTokens p;p.Push(0,100);p.Push(6,600);p.Push(2,200);p.Push(4,400);
  EXPECT_EQ(p.Take(0),100u);EXPECT_EQ(p.Take(2),200u);EXPECT_EQ(p.Take(4),400u);EXPECT_EQ(p.Take(6),600u);
}
TEST(PictureTokens, DroppedFrameCannotStealNextGopToken){
  ainvr::PictureTokens p;p.Push(0,100);p.Push(2,200);EXPECT_EQ(p.Take(2),200u);
  EXPECT_THROW(p.Push(0,900),std::runtime_error);
}
TEST(PictureTokens, CleanGopResetAndPocWrapAreAllowed){
  ainvr::PictureTokens p;for(int k=0;k<3;++k){p.Push(0,100+k);EXPECT_EQ(p.Take(0),100u+k);}
  p.Push(255,500);EXPECT_EQ(p.Take(255),500u);p.Push(0,600);EXPECT_EQ(p.Take(0),600u);
}
TEST(PictureTokens, UnknownOrConsumedPocFails){
  ainvr::PictureTokens p;p.Push(0,100);EXPECT_THROW(p.Take(4),std::runtime_error);
  EXPECT_EQ(p.Take(0),100u);EXPECT_THROW(p.Take(0),std::runtime_error);
}
TEST(PictureTokens, RetentionIsBounded){
  ainvr::PictureTokens p;for(int i=0;i<128;++i)p.Push(i,i+1);
  EXPECT_THROW(p.Push(128,129),std::runtime_error);EXPECT_EQ(p.Take(0),1u);p.Push(128,129);
}

TEST(PictureTokens, BackpressureDrainsOldGopBeforeReusingPoc){
  ainvr::PictureTokens tokens;ainvr::PreparedPicture prepared;
  tokens.Push(0,100);int parses=0;std::vector<uint8_t> packet{1,2,3};
  auto parse=[&](uint8_t* bytes,size_t size){++parses;EXPECT_EQ(size,3u);EXPECT_EQ(bytes[3],0);return 0;};
  const auto poc=prepared.Prepare(packet,200,64,parse);
  EXPECT_TRUE(tokens.Contains(poc));
  EXPECT_EQ(prepared.Prepare(packet,200,64,parse),poc);EXPECT_EQ(parses,1);
  EXPECT_EQ(tokens.Take(0),100u);EXPECT_FALSE(tokens.Contains(poc));
  tokens.Push(poc,200);prepared.Commit();EXPECT_FALSE(prepared.Pending());
  EXPECT_EQ(tokens.Take(0),200u);
  prepared.Prepare(packet,300,64,parse);EXPECT_EQ(parses,2);
}
TEST(PictureTokens, PendingAdmissionCannotChangePacketOrTimestamp){
  ainvr::PreparedPicture prepared;std::vector<uint8_t> packet{1,2,3};
  auto parse=[](uint8_t*,size_t){return 2;};prepared.Prepare(packet,1,64,parse);
  EXPECT_THROW(prepared.Prepare(packet,2,64,parse),std::runtime_error);
  packet[1]=9;EXPECT_THROW(prepared.Prepare(packet,1,64,parse),std::runtime_error);
}
