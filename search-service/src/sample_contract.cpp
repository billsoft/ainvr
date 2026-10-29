#include "sample_contract.hpp"
#include <openssl/evp.h>
#include <cstring>
#include <memory>
#include <algorithm>
namespace ainvr::search {
std::string SampleSha256(const uint8_t* data, size_t size) {
  std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> context(EVP_MD_CTX_new(), EVP_MD_CTX_free);
  unsigned char digest[EVP_MAX_MD_SIZE]; unsigned int length = 0;
  if (!context || EVP_DigestInit_ex(context.get(), EVP_sha256(), nullptr) != 1 ||
      EVP_DigestUpdate(context.get(), data, size) != 1 || EVP_DigestFinal_ex(context.get(), digest, &length) != 1)
    throw std::runtime_error("history_hash_failed");
  const char* hex = "0123456789abcdef"; std::string out;
  for (unsigned int i = 0; i < length; ++i) { out += hex[digest[i] >> 4]; out += hex[digest[i] & 15]; }
  return out;
}
std::string SampleSha256(const std::string& text) { return SampleSha256(reinterpret_cast<const uint8_t*>(text.data()), text.size()); }
std::string SampleStorageUuid(const std::string& domain,const nlohmann::json& identity) {
  if(domain.empty()||domain.size()>128||std::any_of(domain.begin(),domain.end(),[](unsigned char c){return c<33||c>126;}))
    throw std::invalid_argument("invalid_storage_uuid_domain");
  const auto canonical=nlohmann::json::array({domain,identity}).dump();
  if(canonical.size()>16384)throw std::invalid_argument("invalid_storage_uuid_identity");
  auto hex=SampleSha256(canonical).substr(0,32);hex[12]='8';
  const unsigned nibble=hex[16]<='9'?hex[16]-'0':hex[16]-'a'+10;
  hex[16]="0123456789abcdef"[(nibble&3)|8];
  return hex.substr(0,8)+"-"+hex.substr(8,4)+"-"+hex.substr(12,4)+"-"+hex.substr(16,4)+"-"+hex.substr(20,12);
}
std::string SearchSampleStorageUuid(const SearchSampleStorageIdentity& identity) {
  const auto valid=[](const std::string& value) {
    return !value.empty()&&value.size()<=128&&std::none_of(value.begin(),value.end(),
      [](unsigned char c){return c<32||c==127;});
  };
  for(const auto* value:{&identity.input_stream_id,&identity.channel_id,&identity.processor_id,
      &identity.session_id,&identity.model_version}) if(!valid(*value))throw std::invalid_argument("invalid_search_storage_identity");
  auto key=nlohmann::json::array({identity.input_stream_id,identity.channel_id,identity.processor_id,
    identity.session_id,identity.model_version});
  if(identity.track_slot) {
    if(*identity.track_slot>=8||!valid(identity.track_id))throw std::invalid_argument("invalid_search_storage_identity");
    key.push_back(identity.track_id);key.push_back(*identity.track_slot);
    return SampleStorageUuid("ainvr-search-slot-v1",key);
  }
  key.push_back(identity.source_pts_ns);key.push_back(identity.source_frame_index);
  return SampleStorageUuid("ainvr-search-scene-v1",key);
}
nlohmann::json SampleStorageMetadata(const Sample& sample) {
  const auto& r = sample.record;
  return {{"id", r.id}, {"channel", r.channel}, {"processor", r.processor}, {"session", r.session},
    {"track", r.track}, {"model", r.model}, {"captured_ms", r.captured_ms}, {"scene", r.scene},
    {"evidence", sample.evidence}, {"vector_format", "f32le"}, {"dimensions", r.vector.size()}, {"expires_ms", sample.expires_ms}};
}
SampleContractDigest ComputeSampleContractDigest(const Sample& sample) {
  SampleContractDigest out; out.metadata = SampleStorageMetadata(sample);
  out.vector_bytes.reserve(sample.record.vector.size() * 4);
  for (float value : sample.record.vector) {
    uint32_t bits; std::memcpy(&bits, &value, 4);
    for (int n = 0; n < 4; ++n) out.vector_bytes.push_back(uint8_t(bits >> (8 * n)));
  }
  out.metadata_sha = SampleSha256(out.metadata.dump());
  out.vector_sha = SampleSha256(out.vector_bytes.data(), out.vector_bytes.size());
  out.jpeg_sha = SampleSha256(sample.jpeg.data(), sample.jpeg.size());
  out.fingerprint = SampleSha256(out.metadata_sha + out.vector_sha + out.jpeg_sha);
  return out;
}
}  // namespace ainvr::search
