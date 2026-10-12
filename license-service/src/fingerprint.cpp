#include "fingerprint.hpp"

#include "crypto.hpp"
#include "encoding.hpp"

#include <glob.h>
#include <sys/stat.h>

#include <algorithm>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace ainvr_license {

namespace {
std::string ReadTrimmed(const std::string& path) {
  std::ifstream f(path, std::ios::binary);
  if (!f) return "";
  std::ostringstream ss;
  ss << f.rdbuf();
  std::string s = ss.str();
  // device-tree 文件末尾可能带 NUL
  while (!s.empty() && (s.back() == '\0' || s.back() == '\n' ||
                        s.back() == '\r' || s.back() == ' ')) {
    s.pop_back();
  }
  size_t start = 0;
  while (start < s.size() && (s[start] == '\0' || s[start] == ' ')) ++start;
  return s.substr(start);
}

std::string FirstGlob(const std::string& pattern) {
  glob_t g;
  std::string result;
  if (glob(pattern.c_str(), 0, nullptr, &g) == 0 && g.gl_pathc > 0) {
    result = ReadTrimmed(g.gl_pathv[0]);
  }
  globfree(&g);
  return result;
}
}  // namespace

std::string LinuxFingerprintProvider::ReadChipUid() {
  std::string uid = ReadTrimmed("/proc/device-tree/serial-number");
  if (uid.empty()) {
    throw std::runtime_error("无法读取设备板卡序列号（/proc/device-tree/serial-number）");
  }
  return uid;
}

std::string LinuxFingerprintProvider::ReadNvmeSerial() {
  return FirstGlob("/sys/block/nvme*/device/serial");
}

std::string LinuxFingerprintProvider::ReadSocModel() {
  std::string m = ReadTrimmed("/sys/devices/soc0/machine");
  if (m.empty()) {
    std::string compatible =
        ReadTrimmed("/proc/device-tree/compatible");
    // compatible 是多段 NUL 分隔字符串，取第一段
    size_t nul = compatible.find('\0');
    if (nul != std::string::npos) m = compatible.substr(0, nul);
  }
  if (m.empty()) m = ReadTrimmed("/proc/device-tree/model");
  if (m.empty()) m = "RDK S100P";
  return m;
}

MachineInfo BuildMachineInfo(FingerprintProvider& provider,
                             const std::string& salt_hex) {
  auto salt_opt = HexDecode(salt_hex);
  if (!salt_opt || salt_opt->size() != 32) {
    throw std::runtime_error("FINGERPRINT_SALT 不是合法的 32 字节 hex");
  }
  Key32 salt{};
  std::copy(salt_opt->begin(), salt_opt->end(), salt.begin());

  MachineInfo mi;
  mi.chip_uid = provider.ReadChipUid();
  if (mi.chip_uid.size() < 4 || mi.chip_uid.size() > 128 || mi.chip_uid.find_first_not_of("0") == std::string::npos) {
    throw std::runtime_error("invalid board serial");
  }
  mi.nvme_serial = ""; // v2 binds the board; replacing storage does not change identity.
  mi.soc_model = provider.ReadSocModel();

  mi.raw = "AINVR/device-id/v2|" + mi.chip_uid;

  auto mac = HmacSha256(salt, mi.raw);
  mi.code = CrockfordEncode(mac.data(), 15);
  mi.code_grouped = GroupCode(mi.code);
  if (mi.code.size() != 24) {
    throw std::runtime_error("申请码长度异常：" + std::to_string(mi.code.size()));
  }
  return mi;
}

bool CodeEquals(const std::string& a, const std::string& b) {
  return CrockfordNormalize(a) == CrockfordNormalize(b);
}

}  // namespace ainvr_license
