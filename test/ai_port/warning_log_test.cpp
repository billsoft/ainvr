// Copyright AINVR. Local file controls; no camera or hardware operations.
#include "utils/warning_log.hpp"
#include "utils/log.hpp"
#include <gtest/gtest.h>
#include <fstream>
#include <nlohmann/json.hpp>
namespace {
struct Fixture:testing::Test {
 std::filesystem::path root;
 void SetUp()override{char name[]="/tmp/ainvr-warning-log-XXXXXX";auto* p=mkdtemp(name);ASSERT_NE(p,nullptr);root=p;}
 void TearDown()override{std::filesystem::remove_all(root);}
 std::string Read(const char* name){std::ifstream f(root/name);return std::string(std::istreambuf_iterator<char>(f),{});}
};
}
TEST_F(Fixture, RotationIsBoundedAndRetainsMostRecentEvents){
 {ai_service::log::WarningLog log(root,16384);for(int i=0;i<100;++i)log.Append(std::to_string(i)+std::string(1000,'x'));}
 EXPECT_LE(std::filesystem::file_size(root/"warnings.jsonl"),16384u);
 EXPECT_LE(std::filesystem::file_size(root/"warnings.previous.jsonl"),16384u);
 EXPECT_NE(Read("warnings.jsonl").find("99"),std::string::npos);
 {ai_service::log::WarningLog log(root,16384);log.Append("after restart");}
 EXPECT_NE(Read("warnings.jsonl").find("after restart"),std::string::npos);
}
TEST_F(Fixture, RejectsUnsafeDirectoryAndSymlinkFiles){
 chmod(root.c_str(),0755);EXPECT_THROW(ai_service::log::WarningLog{root},std::runtime_error);chmod(root.c_str(),0700);
 std::filesystem::create_symlink("/dev/null",root/"warnings.jsonl");EXPECT_THROW(ai_service::log::WarningLog{root},std::runtime_error);
}
TEST_F(Fixture, RedactsWarningSecretsAndDoesNotCopyInfo){
 ai_service::log::EnableWarningFileLog(root.string());
 ai_service::log::Info("test","ordinary info");
 ai_service::log::Warning("test","password=example-secret rtsp://u:p@host");
 const auto text=Read("warnings.jsonl");EXPECT_EQ(text.find("example-secret"),std::string::npos);EXPECT_EQ(text.find("u:p@"),std::string::npos);
 EXPECT_EQ(text.find("ordinary info"),std::string::npos);EXPECT_NE(text.find("[REDACTED]"),std::string::npos);
 auto event=nlohmann::json::parse(text);EXPECT_EQ(event["level"],"WARNING");
}
