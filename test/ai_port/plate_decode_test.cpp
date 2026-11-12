#include "adapters/plate_decode.hpp"
#include "platform/gles_preprocess.hpp"
#include <gtest/gtest.h>
using namespace ainvr::plate;
TEST(Plate,PerspectiveCorners){Quad q{{{20,30},{180,20},{170,80},{30,90}}};auto m=Homography(q,200,100);
 for(int i=0;i<4;++i){float u=(i==1||i==2),v=i>=2,d=m[6]*u+m[7]*v+m[8];
 EXPECT_NEAR((m[0]*u+m[1]*v+m[2])/d,q[i][0]/200,1e-5);EXPECT_NEAR((m[3]*u+m[4]*v+m[5])/d,q[i][1]/100,1e-5);}}
TEST(Plate,RejectAmbiguousCorners){Quad q{{{20,30},{180,20},{30,90},{170,80}}};EXPECT_THROW(Homography(q,200,100),std::invalid_argument);}
TEST(Plate,CtcBlankSeparatesRepeatedCharacter){std::vector<std::string> a(78,"X");a[0]="#";a[1]="京";a[2]="A";
 std::vector<float> l(21*78,-10);for(int t=0;t<21;++t)l[t*78]=10;
 for(auto [t,c]:std::vector<std::pair<int,int>>{{0,1},{1,1},{2,2},{4,2}}){l[t*78]=-10;l[t*78+c]=10;}
 auto text=Ctc(l,a);EXPECT_EQ(text.value,"京AA");EXPECT_EQ(text.character_scores.size(),3);}
TEST(Plate,RejectNonfiniteLogits){std::vector<std::string> a(78,"X");std::vector<float> l(21*78,0);l[0]=NAN;EXPECT_THROW(Ctc(l,a),std::invalid_argument);}
TEST(Plate,LetterboxRoundtrip){std::vector<float> rows(300*14); // 1280x720 -> 640x360 with top140
 const float r[]{100,200,300,250,.8,0,100,200,300,200,300,250,100,250};std::copy(r,r+14,rows.begin());
 auto detections=Decode(rows,1280,720);ASSERT_EQ(detections.size(),1);EXPECT_FLOAT_EQ(detections[0].corners[0][0],200);EXPECT_FLOAT_EQ(detections[0].corners[0][1],120);}
TEST(Plate,ProjectiveRejectsPole){ainvr::ImageTransform t;t.letterbox=false;t.projective_uv=std::array<float,9>{1,0,0,0,1,0,-2,0,1};EXPECT_THROW(ainvr::ValidateSourceRegion(t),std::invalid_argument);}
TEST(Plate,ProjectiveRejectsConflictingCrop){ainvr::ImageTransform t;t.letterbox=false;t.projective_uv=std::array<float,9>{1,0,0,0,1,0,0,0,1};t.source_region=std::array<float,4>{0,0,10,10};EXPECT_THROW(ainvr::ValidateSourceRegion(t),std::invalid_argument);}
TEST(Plate,DoubleRowRejectsSmallImage){ainvr::ImageTransform t;t.letterbox=false;t.plate_split_height=5;EXPECT_THROW(ainvr::ValidateSourceRegion(t),std::invalid_argument);}

TEST(Plate,LiveDetectionRetainsMoreThanOcrBudgetAndLowConfidenceCandidates){
 std::vector<float> rows(300*14);
 for(int i=0;i<6;++i){const float x=30.f+i*85;const float box[]{x,200,x+70,230,i==0?.05f:.8f,0,x,200,x+70,200,x+70,230,x,230};std::copy(box,box+14,rows.begin()+i*14);}
 auto live=Decode(rows,640,640,.01f);ASSERT_EQ(live.size(),6);EXPECT_FLOAT_EQ(live.back().score,.05f);
 auto ordinary=Decode(rows,640,640);EXPECT_EQ(ordinary.size(),5);
}
