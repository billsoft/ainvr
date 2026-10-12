// Copyright AINVR.
#pragma once
#include "result.hpp"
#include <cstdint>
#include <string>
#include <vector>
namespace ainvr {
struct ArchiveImage { int width=0,height=0;std::vector<uint8_t> jpeg; };
struct ArchiveDocumentInput {
  // Generate once at acceptance and retain across retries/restarts.
  std::string image_id,channel_name;
  uint64_t archive_epoch=0;
  ai_service::FrameResult frame;
  size_t detection_index=0;
  ArchiveImage image,original_image;
  bool enhanced=false,brightness_corrected=false;
  std::string enhance_model;
};
// Reference-compatible Mongo BSON with independent original/processed JPEGs.
// Owns the returned bytes; no OpenCV, CUDA, frame lifetime or database required.
std::vector<uint8_t> BuildArchiveDocument(const ArchiveDocumentInput& input);
}  // namespace ainvr
