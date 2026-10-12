// Copyright AINVR.
#include "output/archive_document.hpp"
#include <bson/bson.h>
#include <gtest/gtest.h>
#include <limits>
namespace {
ainvr::ArchiveDocumentInput Input(){
  ainvr::ArchiveDocumentInput in;in.image_id="507f1f77bcf86cd799439011";in.channel_name="AINVR camera";in.archive_epoch=42;
  in.frame.channel_id="cam-1";in.frame.frame_pts_ns=9007199254740993LL;in.frame.timestamp=1790168716.123456;
  in.frame.model_name="scrfd";in.frame.task_type="face_detection";
  ai_service::Detection d;d.class_id=1;d.class_name="face";d.confidence=.875;d.bbox={-1.5,2.25,30,40};
  d.landmarks=std::vector<std::array<double,2>>{{1.25,2.5},{3.75,4.125}};
  d.label_id="id\"quoted";d.query_description="a \\ description";d.model_extra={{"prompt", "face"}};
  in.frame.detections.push_back(d);
  // Envelope fixtures test byte retention, not JPEG decoding (covered by codec tests).
  in.original_image={21,19,{255,216,1,2,255,217}};in.image={42,38,{255,216,3,4,255,217}};
  in.enhanced=true;in.enhance_model="gpen";in.brightness_corrected=true;return in;
}
struct Document {
  std::vector<uint8_t> bytes;bson_t bson{};
  explicit Document(const ainvr::ArchiveDocumentInput& in):bytes(ainvr::BuildArchiveDocument(in)){if(!bson_init_static(&bson,bytes.data(),bytes.size()))throw std::runtime_error("Invalid BSON");}
  bson_iter_t At(const char* path){bson_iter_t root,out;if(!bson_iter_init(&root,&bson)||!bson_iter_find_descendant(&root,path,&out))throw std::runtime_error(path);return out;}
};
TEST(ArchiveDocument,RetainsIdentityTypesAndMetadata){
  auto in=Input();Document doc(in);EXPECT_TRUE(bson_validate(&doc.bson,BSON_VALIDATE_UTF8,nullptr));
  auto oid=doc.At("_id");ASSERT_TRUE(BSON_ITER_HOLDS_OID(&oid));char id[25];bson_oid_to_string(bson_iter_oid(&oid),id);EXPECT_EQ(std::string(id),in.image_id);
  auto pts=doc.At("frame_pts_ns");ASSERT_TRUE(BSON_ITER_HOLDS_INT64(&pts));EXPECT_EQ(bson_iter_int64(&pts),in.frame.frame_pts_ns);
  auto epoch=doc.At("archive_epoch");ASSERT_TRUE(BSON_ITER_HOLDS_INT64(&epoch));EXPECT_EQ(bson_iter_int64(&epoch),42);
  auto ts=doc.At("timestamp");EXPECT_DOUBLE_EQ(bson_iter_double(&ts),in.frame.timestamp);
  auto label=doc.At("label_id");EXPECT_EQ(std::string(bson_iter_utf8(&label,nullptr)),in.frame.detections[0].label_id);
  auto point=doc.At("landmarks.1.y");EXPECT_DOUBLE_EQ(bson_iter_double(&point),4.125);
  auto extra=doc.At("model_extra.prompt");EXPECT_STREQ(bson_iter_utf8(&extra,nullptr),"face");
  EXPECT_EQ(doc.bytes,ainvr::BuildArchiveDocument(in));
}
TEST(ArchiveDocument,RetainsBothImagesIndependently){
  auto in=Input();Document doc(in);
  for(auto item: {std::pair<const char*,const ainvr::ArchiveImage*>{"image",&in.image},{"original_image",&in.original_image}}){
    auto data=doc.At((std::string(item.first)+".data").c_str());ASSERT_TRUE(BSON_ITER_HOLDS_BINARY(&data));
    bson_subtype_t type;uint32_t length;const uint8_t* bytes;bson_iter_binary(&data,&type,&length,&bytes);
    EXPECT_EQ(type,BSON_SUBTYPE_BINARY);EXPECT_EQ(std::vector<uint8_t>(bytes,bytes+length),item.second->jpeg);
    auto width=doc.At((std::string(item.first)+".width").c_str());EXPECT_EQ(bson_iter_int32(&width),item.second->width);
  }
}
TEST(ArchiveDocument,UnknownConfidenceAndAbsentLandmarksRemainNull){
  auto in=Input();in.frame.detections[0].confidence_known=false;in.frame.detections[0].confidence=std::numeric_limits<double>::quiet_NaN();
  in.frame.detections[0].landmarks.reset();in.enhanced=false;Document doc(in);
  for(auto key:{"confidence","landmarks","enhance_model","embedding","embedding_model"}){auto value=doc.At(key);EXPECT_TRUE(BSON_ITER_HOLDS_NULL(&value));}
}
TEST(ArchiveDocument,RejectsInvalidRecords){
  auto in=Input();in.image_id="../invalid";EXPECT_THROW(ainvr::BuildArchiveDocument(in),std::invalid_argument);
  in=Input();in.detection_index=1;EXPECT_THROW(ainvr::BuildArchiveDocument(in),std::invalid_argument);
  in=Input();in.archive_epoch=UINT64_MAX;EXPECT_THROW(ainvr::BuildArchiveDocument(in),std::invalid_argument);
  in=Input();in.original_image.jpeg.clear();EXPECT_THROW(ainvr::BuildArchiveDocument(in),std::invalid_argument);
  in=Input();in.frame.timestamp=0;EXPECT_THROW(ainvr::BuildArchiveDocument(in),std::invalid_argument);
  in=Input();in.frame.detections[0].bbox[2]=-1;EXPECT_THROW(ainvr::BuildArchiveDocument(in),std::invalid_argument);
  in=Input();in.frame.detections[0].confidence=2;EXPECT_THROW(ainvr::BuildArchiveDocument(in),std::invalid_argument);
}
TEST(ArchiveDocument,RejectsOversizedDocumentBeforeMongo){
  auto in=Input();in.image.jpeg.resize(9*1024*1024,0);in.image.jpeg[0]=255;in.image.jpeg[1]=216;in.image.jpeg[in.image.jpeg.size()-2]=255;in.image.jpeg.back()=217;
  in.original_image.jpeg=in.image.jpeg;EXPECT_THROW(ainvr::BuildArchiveDocument(in),std::invalid_argument);
}
}
