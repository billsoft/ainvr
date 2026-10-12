// SEI 注入器 —— 对应 Python stream/sei.py,逐函数移植。纯函数,零 GStreamer
// 依赖。这是和浏览器端 Encoded Transform 解码器的线上字节级契约,任何格式
// 改动都要同步改浏览器那一侧,不能当内部实现细节随便调整。
#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "../output/result.hpp"
#include "video_codec.hpp"

namespace ai_service::sei {

// ---- 常量(必须和 Python 侧逐字节一致)----
inline const std::vector<uint8_t> SEI_UUID = {
    'A', 'I', 'N', 'V', 'R', '-', 'S', 'E', 'I', '-', 'v', '1',
    0x00, 0x00, 0x00, 0x01};  // 16 字节; matches web and recorder
constexpr int SEI_PAYLOAD_TYPE = 5;          // user_data_unregistered
constexpr int SEI_PAYLOAD_BUDGET = 1024;     // 载荷预算(字节,§8.3 ≤1KB)

// ========== RBSP/EBSP 转义 ==========
std::vector<uint8_t> escape_emulation(const std::vector<uint8_t>& data);
std::vector<uint8_t> unescape_emulation(const std::vector<uint8_t>& data);

// ========== SEI NAL 构造 / 解析 ==========
// H.264:NAL 头 0x06;H.265:前缀 SEI(类型 39),2 字节头 0x4E 0x01。
// SEI 载荷(UUID + JSON)两种编码完全一致,浏览器按 UUID 扫描不受影响。
using stream::VideoCodec;

std::vector<uint8_t> build_sei_nal(const std::vector<uint8_t>& user_data,
                                   VideoCodec codec = VideoCodec::kH264);

// 解析 SEI NAL(含头字节),返回 [(payload_type, payload_bytes), ...]。
// 非 SEI NAL 抛 std::invalid_argument。
std::vector<std::pair<int, std::vector<uint8_t>>> parse_sei_nal(
    const std::vector<uint8_t>& nal, VideoCodec codec = VideoCodec::kH264);

// ========== Annex-B AU 扫描 / 注入 ==========
// 返回 [(NAL头偏移, 起始码长度), ...]
std::vector<std::pair<size_t, int>> find_annexb_nals(
    const std::vector<uint8_t>& data);

// 插在首个 VCL 之前(参数集/AUD 之后)
std::vector<uint8_t> inject_sei_annexb(const std::vector<uint8_t>& au,
                                        const std::vector<uint8_t>& sei_nal,
                                        VideoCodec codec = VideoCodec::kH264);

// ========== 检测结果 → SEI 载荷 ==========
// 预算不足以容纳基础元数据(即使 detections 为空)时抛 std::runtime_error,
// 消息文本与 Python 版一致 —— 这不是可以悄悄改成返回空 bytes 的地方,
// Python 端就是这么设计的(见 sei_fixtures.json 里
// budget_too_small_for_one_envelope_raises 这条 fixture)。
std::vector<uint8_t> build_result_payload(
    const std::string& channel_id, int64_t pts_ns, double age_ms,
    std::vector<Detection> detections,  // 按值传入,内部会排序,不改调用方的
    int budget = SEI_PAYLOAD_BUDGET);

}  // namespace ai_service::sei
