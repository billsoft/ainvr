// AINVR. Pure sample/fingerprint contract shared by storage and producers.
// No Mongo, HTTP, image processing or inference dependency.
#pragma once
#include "vector_index.hpp"
#include <nlohmann/json.hpp>
#include <optional>
namespace ainvr::search {
struct Sample {
  Record record;
  nlohmann::json evidence;
  std::vector<uint8_t> jpeg;
  int64_t expires_ms = 0;
  std::string fingerprint{};
  std::optional<size_t> track_slot{};
};
struct SampleContractDigest {
  nlohmann::json metadata;
  std::vector<uint8_t> vector_bytes;
  std::string metadata_sha, vector_sha, jpeg_sha, fingerprint;
};
std::string SampleSha256(const uint8_t* data, size_t size);
std::string SampleSha256(const std::string& text);
// RFC9562 UUIDv8 storage/idempotency key, not a tracker or identity registry.
// Hashes compact UTF8 JSON [domain,identity], preserving existing slot IDs.
std::string SampleStorageUuid(const std::string& domain,const nlohmann::json& identity);
// One identity formatter for live producers and retained-image reencoding.
// Changing model space changes the key; replacing a slot's image does not.
struct SearchSampleStorageIdentity {
  std::string input_stream_id,channel_id,processor_id,session_id,model_version,track_id;
  std::optional<size_t> track_slot{};
  uint64_t source_pts_ns=0,source_frame_index=0;
};
std::string SearchSampleStorageUuid(const SearchSampleStorageIdentity& identity);
nlohmann::json SampleStorageMetadata(const Sample& sample);
// Hashes ORIGINAL f32le vector bytes, canonical nlohmann JSON metadata and the
// actual encoded JPEG bytes. Never hash a normalized/rounded replacement body.
SampleContractDigest ComputeSampleContractDigest(const Sample& sample);
}  // namespace ainvr::search
