# S100P BPU监控采样与已验证修复

2026-10-17，保持大门通道每10秒采集，224×448模型输入不变。

## 现象与根因

仪表盘361个历史点全为0，模型实际仍在BPU执行。原监控每10秒只读取一次 `/sys/devices/system/bpu/ratio`，与每10秒识别周期发生相位锁定，持续读到空闲时刻。该值是监控读数，不是算力限制。
不修改采集间隔，0.5秒一次、61次驱动读数实测均值16.6721%、峰值95%。均值包含空闲期，不代表模型执行期间平均利用率或MAC饱和度。
证据：`test/results/locateanything-bpu-sampling-alias-v173.json`。

## 值得保留的实现与测试

- `shared/host-restart-helper/observability.py`：`bpu_percent()`读取真实驱动；`BpuWindow`独立线程每0.5秒采样。每10秒资源记录改为最近10秒按覆盖时间加权的均值。
- 仅64条内存记录，不增加数据库写入频率。单次读数最多覆盖1秒，至少8秒有效覆盖才出值；缺失、启动未满窗口及长调度间断为null，真实空闲为0。
- `test/test_bpu_observability.py`：23项通过，包括5种相位的周期漏采回归、有效0、缺失/过期、长间断及加权计算。
- 复验：`.venv/bin/python -m pytest -q test/test_bpu_observability.py`。

## 部署实证

只重启 `ainvr-restart-helper.service`。AI PID2288523、模型后端PID2288389、录像PID2418、接入PID2386前后一致；用户配置哈希保持42a17b36cba8e04c1d4ab582240f34413d6fab6b7fae0570fcc320b40a2c3de6。
新接口两点18.72%、18.82%，启动覆盖不足时为null。
证据：`test/results/locateanything-bpu-window-live-v174.json`。
旧历史0点原样保留，没有伪造回填。页面峰值是记录的10秒均值峰值，不等于0.5秒观测的瞬时95%。刷新页面即可看到新记录。
原文件备份后缀 `.before-bpu-window-v173`；不需要重启AI、录像或SRS。

## 官方依据

地瓜官方S100压力测试文档说明ratio是百分比利用率，支持单次读取与每秒观测。相位锁定根因由本次现网对照实验确认。
https://developer.d-robotics.cc/rdk_s_doc/Advanced_development/linux_development/hardware_unit_test/bpu_cpu_ddr_stress
