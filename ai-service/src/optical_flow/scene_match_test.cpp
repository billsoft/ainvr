#include "scene_match.hpp"
#include <gtest/gtest.h>
using namespace ainvr::flow;
static std::vector<ScenePair> Grid(const Homography& h){
  std::vector<ScenePair> p;
  for(int y=1;y<20;++y)for(int x=1;x<20;++x){
    double a=x/20.0,b=y/20.0,d=h[6]*a+h[7]*b+1;
    p.push_back({a,b,(h[0]*a+h[1]*b+h[2])/d,(h[3]*a+h[4]*b+h[5])/d});
  }
  return p;
}
TEST(SceneMatch,PerspectiveRecoversCornersWithOutliers){
  Homography expected{0.9,0.08,0.03,-0.03,0.95,0.02,0.12,-0.05,1};
  auto pairs=Grid(expected);
  for(size_t i=0;i<pairs.size();i+=7){pairs[i].u=0.7;pairs[i].v=0.1;}
  auto result=FitScenePairs(pairs);ASSERT_TRUE(result["matched"]);
  auto actual=result["homography"].get<Homography>();
  for(size_t i=0;i<9;++i)EXPECT_NEAR(actual[i],expected[i],1e-6);
}
TEST(SceneMatch,RejectsSmallSupportAndDegeneratePairs){
  auto pairs=Grid({1,0,0,0,1,0,0,0,1});
  for(auto& p:pairs){p.x*=0.1;p.y*=0.1;p.u=p.x;p.v=p.y;}
  EXPECT_FALSE(FitScenePairs(pairs)["matched"]);
  for(auto& p:pairs)p.y=0.5;
  EXPECT_FALSE(FitScenePairs(pairs)["matched"]);
}
TEST(SceneMatch,RejectsReflectionAndHorizon){
  EXPECT_FALSE(FitScenePairs(Grid({-1,0,1,0,1,0,0,0,1}))["matched"]);
  EXPECT_FALSE(FitScenePairs(Grid({1,0,0,0,1,0,-0.95,0,1}))["matched"]);
}
TEST(SceneMatch,RejectsCompetingPatchAcrossTheImageAndKeepsUniquePatch){
  std::vector<uint32_t> words(4*kPixels);
  std::mt19937 rng(5721);
  for(auto& w:words)w=rng();
  int i=64*kWidth+100,j=i+73;
  // Construct a plausible competitor on a different 16-value index bin.
  words[2*kPixels+i]=0x6F7E7150;words[2*kPixels+j]=0x74837655;
  words[3*kPixels+i]=0x00657189;words[3*kPixels+j]=0x006A768E;
  words[j]=words[i]^1u;words[kPixels+j]=words[kPixels+i];
  EXPECT_TRUE(SceneDescriptorIndex(words).HasAlternative(words,i,i,0));
  words[j]=~words[i];words[kPixels+j]=~words[kPixels+i];
  EXPECT_FALSE(SceneDescriptorIndex(words).HasAlternative(words,i,i,0));
  EXPECT_THROW(SceneDescriptorIndex(std::vector<uint32_t>{}),Error);
}
TEST(SceneMatch,EmptyAndAmbiguousEvidenceDoNotSupportIdentity){
  std::vector<uint32_t> uniform(4*kPixels,0);
  std::vector<float> f(2*kPixels,0);
  Homography id{1,0,0,0,1,0,0,0,1};
  auto sites=SceneEvidence(id,f,f,uniform,uniform);
  EXPECT_EQ(sites.size(),128*96u);
  EXPECT_EQ(sites.find_first_not_of("ua"),std::string::npos);
  EXPECT_NE(sites.find('a'),std::string::npos);
  EXPECT_THROW(SceneEvidence(id,f,f,{},uniform),Error);
}
TEST(SceneMatch,BlankFramesCannotAuthorizeIdentity){
  std::vector<float> flow(2*kPixels,0),image(3*kPixels,128);
  EXPECT_FALSE(MatchScene(flow,flow,image,image)["matched"]);
}
TEST(SceneMatch,TextureIdentityAndCycleConsistency){
  std::vector<float> flow(2*kPixels,0),image(3*kPixels);
  for(size_t i=0;i<image.size();++i)image[i]=float((i*17)%251);
  EXPECT_TRUE(MatchScene(flow,flow,image,image)["matched"]);
  std::vector<float> reverse(2*kPixels,20);
  EXPECT_FALSE(MatchScene(flow,reverse,image,image)["matched"]);
}
TEST(SceneMatch,RejectsDifferentAppearanceAndInvalidFields){
  std::vector<float> flow(2*kPixels,0),a(3*kPixels),b(3*kPixels,255);
  for(size_t i=0;i<a.size();++i)a[i]=float((i*17)%71);
  EXPECT_FALSE(MatchScene(flow,flow,a,b)["matched"]);
  EXPECT_THROW(MatchScene({},flow,a,b),Error);
}

TEST(SceneMatch,LocalGridRejectsUnsupportedInteriorAndDifferentPlane){
  auto pairs=Grid({1,0,0,0,1,0,0,0,1});
  pairs.erase(std::remove_if(pairs.begin(),pairs.end(),[](const ScenePair& p){return p.x>.25&&p.x<.75&&p.y>.25&&p.y<.75;}),pairs.end());
  auto result=FitScenePairs(pairs);ASSERT_TRUE(result["matched"]);
  EXPECT_FALSE(result["supportGrid"]["cells"][2*8+3]);
  pairs=Grid({1,0,0,0,1,0,0,0,1});
  for(auto& p:pairs)if(p.x>.25&&p.x<.75&&p.y>.25&&p.y<.75){p.u+=.1;p.v-=.06;}
  result=FitScenePairs(pairs);ASSERT_TRUE(result["matched"]);
  EXPECT_FALSE(result["supportGrid"]["cells"][2*8+3]);
  EXPECT_TRUE(result["supportGrid"]["cells"][0]);
}
