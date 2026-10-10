#!/usr/bin/env python3
"""Build a reviewable resource report from actual result.json files."""
import datetime as dt
import json
from pathlib import Path
import subprocess
from common import ROOT, RESOURCES, digest


def main():
    records = []
    for file in sorted((ROOT / "results").glob("*/result.json")):
        data = json.loads(file.read_text())
        if data.get("resource") in RESOURCES:
            records.append((file, data))
    latest = {data["resource"]: (file, data) for file, data in records}
    lines = ["# RDK S100P 板端硬件实验实测", "", dt.datetime.now().astimezone().isoformat(), "",
             "代码位置：`/home/sunrise/ainvr/test/`。本表使用每类资源最后一次完成的记录；原始日志全部保留。",
             "PASS 表示指定参数下的有限帧实验通过；PARTIAL 表示有接口/功能通过，但仍有项目缺少条件。",
             "微基准、单路离线循环和合成输入的结果不能直接视为官方峰值、长期性能或业务吞吐量。", "",
             "## 各资源结果", "", "| 资源 | 结果 | 通过/失败/跳过 | 原始记录 |",
             "|---|---|---|---|"]
    review = {}
    for name in RESOURCES:
        if name not in latest:
            lines.append(f"| {name} | NOT_RUN | — | — |")
            continue
        file, data = latest[name]
        counts = [sum(c["status"] == v for c in data["checks"]) for v in ["PASS", "FAIL", "SKIP"]]
        relative = file.relative_to(ROOT)
        lines.append(f"| {name} | {data['status']} | {'/'.join(map(str, counts))} | [{relative.parent.name}]({relative.as_posix()}) |")
        review[name] = {"file": str(file), "status": data["status"], "parameters": data["parameters"]}
    lines += ["", "## CPU、内存、GPU 和 BPU", ""]
    for name in ["cpu", "memory", "gpu", "bpu"]:
        if name not in latest:
            continue
        _, data = latest[name]
        for case in data["checks"]:
            for row in case.get("detail", {}).get("measurements", []):
                if row.get("mode") == "all-cores":
                    lines.append(f"- CPU：{row['cores']} 核自定义整数混合运算 {row['mix_iterations_per_second']/1e9:.3f} Giteration/s，独立 Python 校验通过；不是 DMIPS。")
                if "payload_copy_GBps" in row:
                    lines.append(f"- 内存：64MiB×40 次复制 {row['payload_copy_GBps']:.2f} GB/s，逐字节读回检查通过；不是 DDR 理论带宽。")
                if row.get("operation") == "float4_fma":
                    lines.append(f"- GPU：OpenCL float4 FMA {row['GFLOPS']:.2f} GFLOPS；结果经过 CPU 参考校验，未验证显示渲染。")
                if "model_name" in row:
                    lines.append(f"- BPU：{row['model_name']}，平均 {row['latency_ms_mean']:.3f} ms，P95 {row['latency_ms_p95']:.3f} ms；同步推理，检查有限/非空/确定性输出，不证明分类准确率。")
    metrics = {}
    for file, data in records:
        for case in data["checks"]:
            if case["status"] != "PASS":
                continue
            detail = case.get("detail", {})
            for direction in ["encode", "decode"]:
                for row in detail.get(direction, {}).get("measurements", []):
                    key = (case["name"].split("-")[0], row["width"], row["height"], direction)
                    metrics[key] = (row, file)
            if data["resource"] == "pym":
                for row in detail.get("measurements", []):
                    if "sequential_fps" in row:
                        key = (f"PYM{row['hw_id']}", row["width"], row["height"], "六通道离线循环")
                        metrics[key] = (row, file)
    lines += ["", "## 编解码和 PYM 分辨率测试", "",
              "编解码用合成 NV12 灰度渐变，并验证帧数、尺寸、像素误差及独立 ffprobe；文件写入不在接口计时内。",
              "PYM 对启用层检查尺寸和恒定图像保持，记录 sendframe 到 getframe 完成时间。",
              "1080p 30 帧、4K 12 帧、尺寸边界 8 帧；预热帧不计入下表均值。输入简单，不能推断复杂运动场景的编码极限。", "",
              "| 模块 | 输入分辨率 | 操作 | 完成帧数 | 平均 ms | 顺序 FPS |",
              "|---|---|---|---:|---:|---:|"]
    for key, (row, file) in sorted(metrics.items()):
        module, w, h, operation = key
        frames = row.get("completed_frames", row.get("frames"))
        lines.append(f"| {module} | {w}×{h} | {operation} | {frames} | {row['latency_ms_mean']:.3f} | {row['sequential_fps']:.2f} |")
    lines += ["", "## ISP 失败与未完成项", "",
              "ISP 回灌在 hbn_camera_create 阶段报 -65667，官方 hb_camera_error.h 定义为 HBN_STATUS_CAM_MOD_VERSION_ERROR (0x10083)。",
              "板端相机日志实际报：check dummystd v1.0.0 ko v1.3 > v1.2 error。当前驱动版本超出该相机库接受范围，尚未获得 ISP 输出帧。",
              "诊断见 results/isp-driver-diagnosis.log；没有绕过版本检查或更换系统驱动。", ""]
    for name in RESOURCES:
        if name in latest:
            for case in latest[name][1]["checks"]:
                if case["status"] == "SKIP":
                    lines.append(f"- {name}/{case['name']}：{case['reason']}")
    lines += ["", "## 记录解释与复现", "",
              "早期 CPU 循环被 GCC 提出计时循环，早期性能数据作废；最终 CPU 代码使用 volatile 输入防止提出，并已重新实测和校验。",
              "曾向 PYM 提交 8192×4096，超过官方 4096×4096 范围，旧日志中的拒绝不作为硬件故障证据；入口已增加范围校验。",
              "旧日志用于开发排错；以本报告链接的记录和 reviewed-summary.json 为本次审阅结果。", "",
              "```sh", "cd /home/sunrise/ainvr/test", "python3 selfcheck.py", "python3 run_all.py",
              "python3 test_jpu.py --width 8192 --height 8192 --frames 8",
              "python3 test_pym.py --width 4096 --height 4096 --frames 8", "python3 summarize.py", "```", "",
              "官方资料和每个实验的计时口径见 README.md。编译记录保留 SDK 来源路径、SHA256、参数、温度和频率快照。"]
    packages = subprocess.run(["dpkg-query", "-W", "hobot-camera", "hobot-multimedia", "hobot-multimedia-dev", "hobot-multimedia-samples", "hobot-dnn"],
                              capture_output=True, text=True, timeout=5)
    review["_packages"] = packages.stdout
    review["_source_sha256"] = {str(p.relative_to(ROOT)): digest(p) for p in ROOT.rglob("*")
                                if p.is_file() and p.suffix in [".py", ".c", ".md"] and not {"results", "build", "reference"}.intersection(p.relative_to(ROOT).parts)}
    (ROOT / "results/reviewed-summary.json").write_text(json.dumps(review, ensure_ascii=False, indent=2))
    (ROOT / "REPORT.md").write_text("\n".join(lines) + "\n")
    print(ROOT / "REPORT.md")


if __name__ == "__main__":
    main()
