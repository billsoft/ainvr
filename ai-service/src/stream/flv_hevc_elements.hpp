// GStreamer 元件:ainvrflvdemux(FLV → H.265 hvc1 AU)、ainvrflvmux(H.265 hvc1 AU → FLV tag)。
// 只是 flv_hevc 核心外面的薄壳;在 ai-service 进程内静态注册,不单独部署插件 .so。
//
//   拉流:rtmpsrc ! ainvrflvdemux ! h265parse ! video/x-h265,stream-format=byte-stream,alignment=au
//   推流:... ! h265parse ! video/x-h265,stream-format=hvc1 ! ainvrflvmux [format=codec12] ! rtmp2sink
//
// ainvrflvdemux
//   - 只处理 HEVC(codec12 / Enhanced);其他视频编码 → 元件错误"不支持的 FLV 视频封装"
//   - 序列头:首个决定 caps(codec_data=hvcC);相同内容的重复序列头忽略;内容变化 →
//     元件错误"源参数变化",由上层重连状态机重建整条管线(设计 §5.2 E3)
//   - 帧:DTS=tag 时间戳,PTS=DTS+CTS;首个 VCL 为 IDR 的帧不带 DELTA_UNIT
//   - 损坏的帧只丢弃并计数;连续 50 个损坏帧或一次重同步跳过超过 1 MiB → 元件错误
//   - CTS≠0(源含 B 帧)只告警一次
//   属性(只读):dropped-frames、resyncs、format("codec12"/"enhanced",最近一次的写法)
//
// ainvrflvmux
//   - 属性 format:"codec12"(默认)/ "enhanced"
//   - 第一个 IDR 之前不输出;起始依次输出 FLV 头、onMetaData、序列头,之后每帧一个 tag
//   - 每个 tag 一个 buffer,不设 HEADER 标志(rtmp2sink 会跳过 HEADER buffer,实测)
//   - CTS 写真实值 PTS−DTS
//   属性(只读):frames
// 设计:docs/h265-codec12-support-design-2026-09-29.md §6.2/§6.3。
#pragma once

namespace ai_service::stream {

// 注册两个元件(进程内幂等);失败返回 false
bool RegisterTecheFlvElements();

}  // namespace ai_service::stream
