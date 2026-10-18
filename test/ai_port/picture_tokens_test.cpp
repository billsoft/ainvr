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
