// Copyright AINVR. Check the real linked media ABI and compressed packet ownership.
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavcodec/version.h>
#include <libavformat/avformat.h>
#include <libavformat/version.h>
#include <libavutil/avutil.h>
#include <libavutil/ffversion.h>
#include <libavutil/version.h>
}
#include <gtest/gtest.h>
#include <fstream>
#include <iterator>
#include <string>

TEST(FfmpegRuntime, PinnedReleaseAndLinkedLibrariesMatchHeaders) {
  EXPECT_STREQ(FFMPEG_VERSION, "8.1.2");
  EXPECT_STREQ(av_version_info(), "8.1.2");
  EXPECT_EQ(avformat_version(), LIBAVFORMAT_VERSION_INT);
  EXPECT_EQ(avcodec_version(), LIBAVCODEC_VERSION_INT);
  EXPECT_EQ(avutil_version(), LIBAVUTIL_VERSION_INT);
}

TEST(FfmpegRuntime, OldSharedMediaAbiIsNotLoaded) {
  std::ifstream file("/proc/self/maps");
  ASSERT_TRUE(file.is_open());
  const std::string maps{std::istreambuf_iterator<char>(file), {}};
  EXPECT_EQ(maps.find("libavformat.so.58"), std::string::npos);
  EXPECT_EQ(maps.find("libavcodec.so.58"), std::string::npos);
  EXPECT_EQ(maps.find("libavutil.so.56"), std::string::npos);
}

TEST(FfmpegRuntime, PacketReferencesPreservePayloadAndNegativeDecodeTimestamp) {
  AVPacket* source = av_packet_alloc();
  AVPacket* retained = av_packet_alloc();
  ASSERT_NE(source, nullptr);
  ASSERT_NE(retained, nullptr);
  ASSERT_EQ(av_new_packet(source, 8), 0);
  for (int i = 0; i < source->size; ++i) source->data[i] = static_cast<uint8_t>(i);
  source->pts = 3000;
  source->dts = -2000;
  source->duration = 1000;
  ASSERT_EQ(av_packet_ref(retained, source), 0);
  EXPECT_EQ(retained->data, source->data);
  av_packet_free(&source);
  EXPECT_EQ(retained->pts, 3000);
  EXPECT_EQ(retained->dts, -2000);
  EXPECT_EQ(retained->duration, 1000);
  for (int i = 0; i < retained->size; ++i) EXPECT_EQ(retained->data[i], i);
  av_packet_free(&retained);
}
