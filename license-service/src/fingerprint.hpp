// Device identity v2: RDK S100P device-tree board serial. Disk replacement does not change it.
// This is a stable board identifier, not a claim of hardware attestation.
#pragma once

#include <string>

namespace ainvr_license {

struct MachineInfo {
  std::string chip_uid;    // /proc/device-tree/serial-number
  std::string nvme_serial; // 首个 /sys/block/nvme*/device/serial，可能为空
  std::string raw;         // AINVR/device-id/v2|<board serial>
  std::string code;        // 申请码（无分隔符的 Crockford，24 字符）
  std::string code_grouped;// 展示用分组形式
  std::string soc_model;
};

class FingerprintProvider {
 public:
  virtual ~FingerprintProvider() = default;
  virtual std::string ReadChipUid() = 0;
  virtual std::string ReadNvmeSerial() = 0;
  virtual std::string ReadSocModel() = 0;
};

// Linux 真机实现。
class LinuxFingerprintProvider : public FingerprintProvider {
 public:
  std::string ReadChipUid() override;
  std::string ReadNvmeSerial() override;
  std::string ReadSocModel() override;
};

// Production uses a fixed public domain-separation salt (not a secret).HMAC-SHA256(SALT, raw) 前 15 字节 →
// Crockford Base32 24 字符。salt_hex 为 32B 十六进制。
MachineInfo BuildMachineInfo(FingerprintProvider& provider,
                             const std::string& salt_hex);

// 申请码规整比较：去分隔符/经典化后比较。
bool CodeEquals(const std::string& a, const std::string& b);

}  // namespace ainvr_license
