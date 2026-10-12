#include "crypto.hpp"

#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>

#include <stdexcept>

namespace ainvr_license {

namespace {
void ThrowOpenSsl(const char* what) {
  unsigned long e = ERR_get_error();
  char buf[256] = {0};
  ERR_error_string_n(e, buf, sizeof(buf));
  throw std::runtime_error(std::string(what) + ": " + buf);
}
}  // namespace

std::vector<unsigned char> Sha256(const unsigned char* data, size_t len) {
  unsigned char md[EVP_MAX_MD_SIZE];
  size_t md_len = 0;
  if (EVP_Q_digest(nullptr, "SHA256", nullptr, data, len, md, &md_len) != 1) {
    ThrowOpenSsl("SHA256");
  }
  return {md, md + md_len};
}

std::vector<unsigned char> Sha256(std::string_view s) {
  return Sha256(reinterpret_cast<const unsigned char*>(s.data()), s.size());
}

std::vector<unsigned char> HmacSha256(const Key32& key,
                                      const unsigned char* data, size_t len) {
  unsigned char md[EVP_MAX_MD_SIZE];
  unsigned int md_len = 0;
  if (HMAC(EVP_sha256(), key.data(), static_cast<int>(key.size()), data, len, md,
           &md_len) == nullptr) {
    ThrowOpenSsl("HMAC-SHA256");
  }
  return {md, md + md_len};
}

std::vector<unsigned char> HmacSha256(const Key32& key, std::string_view s) {
  return HmacSha256(key, reinterpret_cast<const unsigned char*>(s.data()),
                    s.size());
}

std::string HmacSha256Hex(const Key32& key, std::string_view s) {
  auto md = HmacSha256(key, s);
  static const char kHex[] = "0123456789abcdef";
  std::string out;
  out.reserve(md.size() * 2);
  for (unsigned char b : md) {
    out.push_back(kHex[b >> 4]);
    out.push_back(kHex[b & 0xF]);
  }
  return out;
}

Key32 Hkdf(const Key32& ikm, std::string_view salt, std::string_view info) {
  // Extract: PRK = HMAC(salt, IKM)
  unsigned int prk_len = EVP_MAX_MD_SIZE;
  unsigned char prk_buf[EVP_MAX_MD_SIZE];
  if (HMAC(EVP_sha256(),
           reinterpret_cast<const unsigned char*>(salt.data()),
           static_cast<int>(salt.size()), ikm.data(), ikm.size(),
           prk_buf, &prk_len) == nullptr) {
    ThrowOpenSsl("HKDF-Extract");
  }
  // Expand（L=32，单块）: T1 = HMAC(PRK, info || 0x01)
  std::vector<unsigned char> msg;
  msg.reserve(info.size() + 1);
  msg.insert(msg.end(), reinterpret_cast<const unsigned char*>(info.data()),
             reinterpret_cast<const unsigned char*>(info.data()) + info.size());
  msg.push_back(0x01);

  unsigned int okm_len = EVP_MAX_MD_SIZE;
  unsigned char okm_buf[EVP_MAX_MD_SIZE];
  if (HMAC(EVP_sha256(), prk_buf, static_cast<int>(prk_len), msg.data(),
           msg.size(), okm_buf, &okm_len) == nullptr) {
    ThrowOpenSsl("HKDF-Expand");
  }
  Key32 out{};
  std::copy(okm_buf, okm_buf + 32, out.begin());
  return out;
}

std::vector<unsigned char> AesGcmSeal(const Key32& key,
                                      const unsigned char iv[12],
                                      std::string_view plaintext,
                                      std::string_view aad) {
  EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
  if (!ctx) ThrowOpenSsl("EVP_CIPHER_CTX_new");
  std::vector<unsigned char> out;
  try {
    out.resize(plaintext.size() + 16);
    int len = 0;
    const auto* pt = reinterpret_cast<const unsigned char*>(plaintext.data());
    const auto* ad = reinterpret_cast<const unsigned char*>(aad.data());
    if (EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, nullptr, nullptr) != 1 ||
        EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, 12, nullptr) != 1 ||
        EVP_EncryptInit_ex(ctx, nullptr, nullptr, key.data(), iv) != 1 ||
        EVP_EncryptUpdate(ctx, nullptr, &len, ad,
                          static_cast<int>(aad.size())) != 1) {
      ThrowOpenSsl("GCM seal init/aad");
    }
    len = 0;
    int total = 0;
    if (!plaintext.empty() &&
        (EVP_EncryptUpdate(ctx, out.data(), &len, pt,
                          static_cast<int>(plaintext.size())) != 1)) {
      ThrowOpenSsl("GCM seal update");
    }
    total += len;
    if (EVP_EncryptFinal_ex(ctx, out.data() + total, &len) != 1) {
      ThrowOpenSsl("GCM seal final");
    }
    total += len;
    unsigned char tag[16];
    if (EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, 16, tag) != 1) {
      ThrowOpenSsl("GCM get tag");
    }
    std::copy(tag, tag + 16, out.begin() + total);
    out.resize(total + 16);
  } catch (...) {
    EVP_CIPHER_CTX_free(ctx);
    throw;
  }
  EVP_CIPHER_CTX_free(ctx);
  return out;
}

std::vector<unsigned char> AesGcmOpen(const Key32& key,
                                      const unsigned char iv[12],
                                      const unsigned char* blob, size_t blob_len,
                                      std::string_view aad) {
  if (blob_len < 16) throw std::runtime_error("GCM 数据过短");
  size_t ct_len = blob_len - 16;
  const unsigned char* tag = blob + ct_len;

  EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
  if (!ctx) ThrowOpenSsl("EVP_CIPHER_CTX_new");
  std::vector<unsigned char> out;
  try {
    out.resize(ct_len);
    int len = 0;
    const auto* ad = reinterpret_cast<const unsigned char*>(aad.data());
    if (EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, nullptr, nullptr) != 1 ||
        EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, 12, nullptr) != 1 ||
        EVP_DecryptInit_ex(ctx, nullptr, nullptr, key.data(), iv) != 1 ||
        EVP_DecryptUpdate(ctx, nullptr, &len, ad,
                          static_cast<int>(aad.size())) != 1) {
      ThrowOpenSsl("GCM open init/aad");
    }
    len = 0;
    int total = 0;
    if (ct_len > 0 &&
        EVP_DecryptUpdate(ctx, out.data(), &len, blob,
                          static_cast<int>(ct_len)) != 1) {
      ThrowOpenSsl("GCM open update");
    }
    total += len;
    if (EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, 16,
                            const_cast<unsigned char*>(tag)) != 1 ||
        EVP_DecryptFinal_ex(ctx, out.data() + total, &len) != 1) {
      throw std::runtime_error("GCM 认证失败");
    }
    total += len;
    out.resize(total);
  } catch (...) {
    EVP_CIPHER_CTX_free(ctx);
    throw;
  }
  EVP_CIPHER_CTX_free(ctx);
  return out;
}

}  // namespace ainvr_license
