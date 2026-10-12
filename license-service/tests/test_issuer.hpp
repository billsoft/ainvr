#pragma once
#include <openssl/evp.h>
#include "signed_license.hpp"
#include "encoding.hpp"

// Synthetic signer for unit tests only. Never part of license_core or deployment.
struct TestIssuer {
  EVP_PKEY* key = nullptr;
  ainvr_license::VerifyKeys keys;
  TestIssuer() {
    auto seed=ainvr_license::RandomBytes(32);
    key=EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519,nullptr,seed.data(),seed.size());
    if(!key)throw std::runtime_error("test signer creation failed");
    std::vector<unsigned char> pub(32);size_t size=pub.size();
    if(EVP_PKEY_get_raw_public_key(key,pub.data(),&size)!=1)throw std::runtime_error("test public key failed");
    keys={{"test",ainvr_license::HexEncode(pub)}};
  }
  ~TestIssuer(){EVP_PKEY_free(key);}
  TestIssuer(const TestIssuer&)=delete;
  std::string Token(const std::string& machine,const std::string& installation,int minutes,int seq, int64_t issued_at=1) {
    nlohmann::json p={{"v",3},{"product","AINVR"},{"policy","hybrid_local"},{"kid","test"},
      {"machine_code",machine},{"installation_id",installation},
      {"license_id",std::string(31,'0')+std::to_string(seq)},{"grant_seq",seq},
      {"duration_minutes",minutes},{"issued_at",issued_at},{"purpose","activate"},
      {"challenge",""},{"legacy_token_hash",""},{"activation_wall",0}};
    auto text=p.dump();std::vector<unsigned char> bytes(text.begin(),text.end());
    auto encoded=ainvr_license::B64UrlEncode(bytes),message="AINVR/license/v3|"+encoded;
    auto* ctx=EVP_MD_CTX_new();std::vector<unsigned char> sig(64);size_t size=sig.size();
    bool ok=ctx && EVP_DigestSignInit(ctx,nullptr,nullptr,nullptr,key)==1 &&
      EVP_DigestSign(ctx,sig.data(),&size,reinterpret_cast<const unsigned char*>(message.data()),message.size())==1;
    EVP_MD_CTX_free(ctx);if(!ok)throw std::runtime_error("test signing failed");
    return "AINVR-LIC3-"+encoded+"."+ainvr_license::B64UrlEncode(sig);
  }
};
