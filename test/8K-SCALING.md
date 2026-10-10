# 7680×3840 接收、解码与缩放实测

板端：RDK S100P，2026-10-09。所有代码位于 `/home/sunrise/ainvr/test/`。

结论：当前 PYM 驱动拒绝整幅 7680×3840 输入。CPU 和 GPU 的精确 1/2 NV12
缩放均超过 30 FPS；VPU 能完成该尺寸编解码，但本次只有 H.265 解码超过 30 FPS。
“支持尺寸”与“支持该尺寸的 30 FPS”需要分别验收。

| 独立实验 | 平均 ms/帧 | 实测 FPS | 本次 30 FPS 目标 |
|---|---:|---:|---|
| PYM0/1/4 整幅输入 | — | — | set_attr 均返回 -983049，没有帧完成 |
| H.264 编码 | 41.603 | 24.04 | 未达到 |
| H.264 解码 | 38.806 | 25.77 | 未达到 |
| H.265 编码 | 38.784 | 25.78 | 未达到 |
| H.265 解码 | 29.365 | 34.05 | 独立单路测试达到 |
| CPU 单线程 NV12 1/2 缩放 | 17.937 | 55.75 | 独立缩放测试达到 |
| GPU NV12 1/2 缩放，仅核函数 | 12.519 | 79.88 | 独立缩放测试达到 |
| GPU 每帧上传+缩放+下载 | 18.355 | 54.48 | 独立缩放测试达到；P95 18.549 ms |

缩放输出为 3840×1920，采用 2×2 box 滤波，分别处理 NV12 的 Y 与交错 U/V。
GPU 首尾帧全幅 11,059,200 字节与 C 参考结果一致。不是任意倍率、任意滤波算法的性能承诺。
CPU 参考实现测 12 次；GPU 测 60 帧，剔除 3 帧预热。各缓冲区预分配，
GPU 每帧复制 CPU 输入到设备，并复制设备输出回 CPU；不包含网络接收、VPU 解码、分配和显示。

编解码各测 120 帧，剔除 3 帧预热。输入是合成灰度渐变，低延迟 GOP，
接口计时包含取输入缓冲、编码输入复制、提交与输出完成，不包含文件落盘。
本次 --sample-decoded 保存并检查首尾两帧像素；全部输出完成帧数及独立 ffprobe
码流帧数检查仍为 120。真实高运动、高码率素材、B 帧或不同 GOP 的性能需要另外测量。

## 整条接收/解码/缩放链路仍需验证

如果 H.265 解码和 GPU 缩放串行运行，按本次独立测时相加约 47.72 ms/帧，
估算仅约 20.96 FPS。这不是整链实测，也不能用独立环节都快于 30 FPS 来宣称整链达到 30 FPS。
多缓冲流水线可让解码第 N 帧与缩放第 N−1 帧重叠；共享内存带宽、缓冲交接、队列
与实际码流仍可能降低性能。当前尚未完成并行 VPU→GPU 流水线的端到端实测。

PYM 直接大幅输入在设置参数阶段被拒绝；进程正常返回，SSH 连接保持。
随后重新测试 PYM0/1/4 的 4096×4096 输入，三个模块仍全部通过。
分块 PYM 与 DMA buffer 零拷贝 GPU 导入尚未实现或实测，不把它们当成已验证方案。

## 原始证据与复现

- [PYM 超规格输入](results/20261009-153456-785329-pym_8k/result.json)
- [VPU 120 帧编解码](results/20261009-153457-130670-vpu/result.json)
- [CPU/GPU 缩放](results/20261009-153528-400637-gpu_scale/result.json)
- [拒绝大幅输入后的正常 PYM 测试](results/20261009-153719-344786-pym/result.json)

```sh
cd /home/sunrise/ainvr/test
python3 test_pym_8k.py --frames 8 --timeout 10
python3 test_vpu.py --width 7680 --height 3840 --frames 120 --sample-decoded --timeout 90
python3 test_gpu_scale.py --frames 60 --timeout 90
```

[官方 Camsys 文档](https://developer.d-robotics.cc/rdk_s_doc/en/Advanced_development/multimedia_development/S100/camsys)
规定 S100 PYM 输入宽高各不超过 4096；
[官方 Codec 文档](https://developer.d-robotics.cc/rdk_s_doc/en/Advanced_development/multimedia_development/S100/codec)
给出 VPU 最大输入 8192×4096、性能 4K@90FPS，并没有给出 7680×3840@30FPS 保证。
本次测试尺寸在 VPU 最大输入范围内；常见 UHD 8K 的 7680×4320 高度超过该范围。
