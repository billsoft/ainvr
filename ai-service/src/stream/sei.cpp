#include "sei.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace ai_service::sei {

namespace {

constexpr uint8_t kNalHeaderSei = 0x06;
constexpr uint8_t kNalHeaderSeiHevc0 = 39 << 1;  // 前缀 SEI,forbidden_zero=0
constexpr uint8_t kNalHeaderSeiHevc1 = 0x01;     // nuh_layer_id=0, nuh_temporal_id_plus1=1
constexpr int kHevcPrefixSei = 39;
constexpr uint8_t kRbspTrailing = 0x80;
const std::vector<uint8_t> kStartCode = {0x00, 0x00, 0x00, 0x01};

std::vector<uint8_t> encode_sei_size(int size) {
  if (size < 0) {
    throw std::invalid_argument("size 不能为负: " + std::to_string(size));
  }
  std::vector<uint8_t> out(static_cast<size_t>(size / 255), 0xFF);
  out.push_back(static_cast<uint8_t>(size % 255));
  return out;
}

// 对应 Python _num():round(x,1),整数值去掉小数点。用 nearbyint(round-
// half-to-even,IEEE 默认舍入模式)而不是 std::round(round-half-away-
// from-zero),尽量贴近 Python round() 的舍入语义。
std::string format_num_1dp(double v) {
  double r = std::nearbyint(v * 10.0) / 10.0;
  auto truncated = static_cast<long long>(r);
  if (r == static_cast<double>(truncated)) {
    return std::to_string(truncated);
  }
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%.1f", r);
  return std::string(buf);
}

// 对应 "p": round(d.confidence, 4) —— Python round() 对 float 恒返回
// float,json.dumps 恒带小数点(哪怕整数值也是 "1.0"),不做 _num() 那种
// 整数折叠;但要去掉多余的尾随 0("0.9900" → "0.99")。
std::string format_confidence_4dp(double v) {
  double r = std::nearbyint(v * 10000.0) / 10000.0;
  char buf[64];
  std::snprintf(buf, sizeof(buf), "%.4f", r);
  std::string s(buf);
  size_t last_nonzero = s.find_last_not_of('0');
  if (s[last_nonzero] == '.') {
    last_nonzero += 1;  // 至少保留一位小数:"1." 不合法,要 "1.0"
  }
  s.erase(last_nonzero + 1);
  return s;
}

// 对应 json.dumps(..., ensure_ascii=False) 的字符串转义规则:结构字符转
// 义,控制字符转 \uXXXX,非 ASCII 字节原样透传(不转 \uXXXX)。
std::string json_escape_string(const std::string& s) {
  std::string out;
  out.reserve(s.size() + 2);
  out.push_back('"');
  for (unsigned char c : s) {
    switch (c) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  out.push_back('"');
  return out;
}

// 对应 Python _det_json():单个 detection → 紧凑 JSON object 字符串,
// 字段顺序 c/n/p/b/(k) 固定,不能用泛用 JSON 库的默认(常按 key 字母序)
// 序列化,否则和 Python 端的字节契约对不上。
std::string det_to_json(const Detection& d) {
  std::string s = "{\"c\":";
  s += std::to_string(d.class_id);
  s += ",\"n\":";
  s += json_escape_string(d.class_name);
  s += ",\"p\":";
  s += d.confidence_known ? format_confidence_4dp(d.confidence) : "null";
  if (!d.label_id.empty()) s += ",\"l\":" + json_escape_string(d.label_id);
  s += ",\"b\":[";
  for (size_t i = 0; i < d.bbox.size(); ++i) {
    if (i) s += ",";
    s += format_num_1dp(d.bbox[i]);
  }
  s += "]";
  // 空关键点与缺省同等对待(v1 `if d.landmarks:`;API/Mongo 同规则)。
  if (d.landmarks && !d.landmarks->empty()) {
    s += ",\"k\":[";
    for (size_t i = 0; i < d.landmarks->size(); ++i) {
      if (i) s += ",";
      const auto& p = (*d.landmarks)[i];
      s += "[" + format_num_1dp(p[0]) + "," + format_num_1dp(p[1]) + "]";
    }
    s += "]";
  }
  s += "}";
  return s;
}

}  // namespace

std::vector<uint8_t> escape_emulation(const std::vector<uint8_t>& data) {
  std::vector<uint8_t> out;
  out.reserve(data.size() + data.size() / 64 + 4);
  int zeros = 0;
  for (uint8_t b : data) {
    if (zeros == 2 && b <= 0x03) {
      out.push_back(0x03);
      zeros = 0;
    }
    out.push_back(b);
    zeros = (b == 0) ? zeros + 1 : 0;
  }
  return out;
}

std::vector<uint8_t> unescape_emulation(const std::vector<uint8_t>& data) {
  std::vector<uint8_t> out;
  out.reserve(data.size());
  size_t i = 0, n = data.size();
  while (i < n) {
    if (i + 2 < n && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 0x03) {
      out.push_back(0x00);
      out.push_back(0x00);
      i += 3;
    } else {
      out.push_back(data[i]);
      i += 1;
    }
  }
  return out;
}

std::vector<uint8_t> build_sei_nal(const std::vector<uint8_t>& user_data, VideoCodec codec) {
  std::vector<uint8_t> payload;
  payload.reserve(SEI_UUID.size() + user_data.size());
  payload.insert(payload.end(), SEI_UUID.begin(), SEI_UUID.end());
  payload.insert(payload.end(), user_data.begin(), user_data.end());

  std::vector<uint8_t> rbsp;
  rbsp.push_back(static_cast<uint8_t>(SEI_PAYLOAD_TYPE));
  auto size_enc = encode_sei_size(static_cast<int>(payload.size()));
  rbsp.insert(rbsp.end(), size_enc.begin(), size_enc.end());
  rbsp.insert(rbsp.end(), payload.begin(), payload.end());
  rbsp.push_back(kRbspTrailing);

  std::vector<uint8_t> out;
  if (codec == VideoCodec::kH265) {
    out.push_back(kNalHeaderSeiHevc0);
    out.push_back(kNalHeaderSeiHevc1);
  } else {
    out.push_back(kNalHeaderSei);
  }
  auto escaped = escape_emulation(rbsp);
  out.insert(out.end(), escaped.begin(), escaped.end());
  return out;
}

std::vector<std::pair<int, std::vector<uint8_t>>> parse_sei_nal(
    const std::vector<uint8_t>& nal, VideoCodec codec) {
  const size_t hdr = stream::NalHeaderSize(codec);
  const int want = codec == VideoCodec::kH265 ? kHevcPrefixSei : 6;
  if (nal.size() < hdr || stream::NalType(codec, nal[0]) != want) {
    std::string type_str = nal.empty() ? "None" : std::to_string(stream::NalType(codec, nal[0]));
    throw std::invalid_argument("不是 SEI NAL（type=" + type_str + "）");
  }
  std::vector<uint8_t> raw(nal.begin() + static_cast<std::ptrdiff_t>(hdr), nal.end());
  auto body = unescape_emulation(raw);

  std::vector<std::pair<int, std::vector<uint8_t>>> msgs;
  size_t pos = 0, n = body.size();
  while (pos < n) {
    if (body[pos] == kRbspTrailing) {
      bool rest_all_zero = true;
      for (size_t j = pos + 1; j < n; ++j) {
        if (body[j] != 0) {
          rest_all_zero = false;
          break;
        }
      }
      if (rest_all_zero) break;
    }
    int ptype = 0;
    while (pos < n && body[pos] == 0xFF) {
      ptype += 255;
      pos += 1;
    }
    if (pos >= n) break;
    ptype += body[pos];
    pos += 1;

    int psize = 0;
    while (pos < n && body[pos] == 0xFF) {
      psize += 255;
      pos += 1;
    }
    if (pos >= n) break;
    psize += body[pos];
    pos += 1;

    if (pos + static_cast<size_t>(psize) > n) {
      throw std::runtime_error("SEI payload 被截断");
    }
    msgs.emplace_back(
        ptype, std::vector<uint8_t>(body.begin() + pos, body.begin() + pos + psize));
    pos += psize;
  }
  return msgs;
}

std::vector<std::pair<size_t, int>> find_annexb_nals(
    const std::vector<uint8_t>& data) {
  std::vector<std::pair<size_t, int>> nals;
  const uint8_t* d = data.data();
  int64_t n = static_cast<int64_t>(data.size());
  int64_t i = 0;
  while (true) {
    int64_t idx = -1;
    for (int64_t p = i; p + 3 <= n; ++p) {
      if (d[p] == 0x00 && d[p + 1] == 0x00 && d[p + 2] == 0x01) {
        idx = p;
        break;
      }
    }
    if (idx == -1 || idx >= n - 3) break;
    int sc_len = (idx > 0 && d[idx - 1] == 0x00) ? 4 : 3;
    nals.emplace_back(static_cast<size_t>(idx + 3), sc_len);
    i = idx + 3;
  }
  return nals;
}

std::vector<uint8_t> inject_sei_annexb(const std::vector<uint8_t>& au,
                                        const std::vector<uint8_t>& sei_nal, VideoCodec codec) {
  for (const auto& [hdr_off, sc_len] : find_annexb_nals(au)) {
    if (stream::IsVcl(codec, stream::NalType(codec, au[hdr_off]))) {
      size_t insert_at = hdr_off - static_cast<size_t>(sc_len);
      std::vector<uint8_t> out;
      out.reserve(au.size() + kStartCode.size() + sei_nal.size());
      out.insert(out.end(), au.begin(), au.begin() + insert_at);
      out.insert(out.end(), kStartCode.begin(), kStartCode.end());
      out.insert(out.end(), sei_nal.begin(), sei_nal.end());
      out.insert(out.end(), au.begin() + insert_at, au.end());
      return out;
    }
  }
  return au;
}

std::vector<uint8_t> build_result_payload(const std::string& channel_id,
                                           int64_t pts_ns, double age_ms,
                                           std::vector<Detection> detections,
                                           int budget) {
  int json_budget = std::max(0, budget - static_cast<int>(SEI_UUID.size()));

  auto build_envelope = [&](const std::vector<std::string>& det_jsons) {
    std::string s = "{\"v\":1,\"ch\":";
    s += json_escape_string(channel_id);
    s += ",\"pts\":";
    s += std::to_string(pts_ns);
    s += ",\"age_ms\":";
    s += format_num_1dp(age_ms);
    s += ",\"det\":[";
    for (size_t i = 0; i < det_jsons.size(); ++i) {
      if (i) s += ",";
      s += det_jsons[i];
    }
    s += "]}";
    return s;
  };

  // A completed inference with no objects must clear a held live overlay.
  // The separate lo==0 case below still means metadata lost to the budget,
  // not a negative inference; it must never emit a false empty result.

  // Python: sorted(detections, key=..., reverse=True) —— 稳定排序,
  // reverse=True 不破坏同置信度检测项的原始相对顺序,stable_sort 对应。
  std::stable_sort(detections.begin(), detections.end(),
                    [](const Detection& a, const Detection& b) {
                      return a.confidence > b.confidence;
                    });

  std::vector<std::string> det_jsons;
  det_jsons.reserve(detections.size());
  for (const auto& d : detections) det_jsons.push_back(det_to_json(d));

  std::string empty_env = build_envelope({});
  if (static_cast<int>(empty_env.size()) > json_budget) {
    throw std::runtime_error("SEI 预算不足以容纳基础元数据");
  }

  std::string full = build_envelope(det_jsons);
  if (static_cast<int>(full.size()) <= json_budget) {
    return std::vector<uint8_t>(full.begin(), full.end());
  }

  // 超预算:按置信度降序保留(已排序),二分定位可保留数量。
  int lo = 0, hi = static_cast<int>(det_jsons.size());
  while (lo < hi) {
    int mid = (lo + hi + 1) / 2;
    std::vector<std::string> prefix(det_jsons.begin(), det_jsons.begin() + mid);
    if (static_cast<int>(build_envelope(prefix).size()) <= json_budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  if (lo == 0) return {};
  std::vector<std::string> prefix(det_jsons.begin(), det_jsons.begin() + lo);
  std::string result = build_envelope(prefix);
  return std::vector<uint8_t>(result.begin(), result.end());
}

}  // namespace ai_service::sei
