#include "signed_license.hpp"
#include "encoding.hpp"
#include "trusted_keys.hpp"
#include <openssl/evp.h>
#include <memory>
#include <stdexcept>

namespace ainvr_license {
VerifyKeys ProductionVerifyKeys() {
  if (!kIssuerKeyId[0] || !kIssuerPublicKeyHex[0]) return {};
  return {{kIssuerKeyId, kIssuerPublicKeyHex}};
}
namespace {
int64_t Number(const nlohmann::json& j, const char* name, int64_t lo, int64_t hi) {
  const auto& v = j.at(name);
  if (!v.is_number_integer() || (v.is_number_unsigned() && v.get<uint64_t>() > uint64_t(hi)))
    throw std::runtime_error("LICENSE_INVALID_INTEGER");
  auto n = v.get<int64_t>();
  if (n < lo || n > hi) throw std::runtime_error("LICENSE_INVALID_RANGE");
  return n;
}
std::string HexField(const nlohmann::json& j, const char* field, size_t len) {
  auto s = j.at(field).get<std::string>();
  if (s.size() != len || s.find_first_not_of("0123456789abcdef") != std::string::npos)
    throw std::runtime_error("LICENSE_INVALID_FIELD");
  return s;
}
}
SignedGrant OpenSignedGrant(const VerifyKeys& keys, const std::string& token) {
  constexpr std::string_view prefix = "AINVR-LIC3-";
  if (token.size() > 8192 || !token.starts_with(prefix)) throw std::runtime_error("LICENSE_V3_REQUIRED");
  auto dot = token.find('.', prefix.size());
  if (dot == std::string::npos) throw std::runtime_error("LICENSE_INVALID_FORMAT");
  auto encoded = token.substr(prefix.size(), dot-prefix.size());
  auto data = B64UrlDecode(encoded), sig = B64UrlDecode(token.substr(dot+1));
  if (!data || !sig || sig->size()!=64 || B64UrlEncode(*data)!=encoded || B64UrlEncode(*sig)!=token.substr(dot+1))
    throw std::runtime_error("LICENSE_INVALID_ENCODING");
  auto j = nlohmann::json::parse(*data);
  if (!j.is_object() || j.size()!=14) throw std::runtime_error("LICENSE_INVALID_SCHEMA");
  auto it = keys.find(j.at("kid").get<std::string>());
  if (it == keys.end()) throw std::runtime_error("LICENSE_UNKNOWN_SIGNER");
  auto raw = HexDecode(it->second);
  if (!raw || raw->size()!=32) throw std::runtime_error("LICENSE_INVALID_PUBLIC_KEY");
  std::unique_ptr<EVP_PKEY, decltype(&EVP_PKEY_free)> key(
      EVP_PKEY_new_raw_public_key(EVP_PKEY_ED25519,nullptr,raw->data(),raw->size()),EVP_PKEY_free);
  std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)> ctx(EVP_MD_CTX_new(),EVP_MD_CTX_free);
  const std::string message = "AINVR/license/v3|" + encoded;
  if (!key || !ctx || EVP_DigestVerifyInit(ctx.get(),nullptr,nullptr,nullptr,key.get())!=1 ||
      EVP_DigestVerify(ctx.get(),sig->data(),sig->size(),reinterpret_cast<const unsigned char*>(message.data()),message.size())!=1)
    throw std::runtime_error("LICENSE_SIGNATURE_INVALID");
  if (Number(j,"v",3,3)!=3 || j.at("product")!="AINVR" || j.at("policy")!="hybrid_local")
    throw std::runtime_error("LICENSE_INVALID_PRODUCT");
  SignedGrant g;
  g.license.fp = CrockfordNormalize(j.at("machine_code").get<std::string>());
  if(g.license.fp.size()!=24 || g.license.fp.find_first_not_of("0123456789ABCDEFGHJKMNPQRSTVWXYZ")!=std::string::npos)
    throw std::runtime_error("LICENSE_INVALID_MACHINE");
  g.license.license_id=HexField(j,"license_id",32);
  g.installation_id=HexField(j,"installation_id",32);
  g.license.grant_seq=Number(j,"grant_seq",1,kMaxSequence);
  g.license.ttl_min=Number(j,"duration_minutes",1,kMaxMinutes);
  g.license.issued_at=Number(j,"issued_at",0,253402300799LL);
  g.purpose=j.at("purpose").get<std::string>();
  g.challenge=j.at("challenge").get<std::string>();
  g.legacy_token_hash=j.at("legacy_token_hash").get<std::string>();
  g.activation_wall=Number(j,"activation_wall",0,253402300799LL);
  if(g.purpose!="activate" && g.purpose!="recover" && g.purpose!="migrate") throw std::runtime_error("LICENSE_INVALID_PURPOSE");
  if(g.purpose=="recover") HexField(j,"challenge",32);
  else if(!g.challenge.empty()) throw std::runtime_error("LICENSE_INVALID_CHALLENGE");
  if(g.purpose=="migrate") HexField(j,"legacy_token_hash",64);
  else if(!g.legacy_token_hash.empty() || g.activation_wall!=0) throw std::runtime_error("LICENSE_INVALID_MIGRATION");
  return g;
}
}
