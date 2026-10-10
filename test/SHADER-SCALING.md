# 7680×3840 NV12：OpenGL ES 缩放与 CPU 开销

2026-10-09 在当前 RDK S100P 上执行，代码全部位于 `/home/sunrise/ainvr/test/`。
最终 `results/20261009-160721-546091-shader_scale/result.json` 为 PASS：
9 个分辨率/滤波组合、21 组性能测量，每组 60 帧另有 3 帧预热；42 份首尾输出
全部校验通过，最大 8 位像素误差 1。下面是单路有限帧实验，不包含解码、流媒体、
内存分配、输入生成、文件保存和像素校验；没有锁频，没有安装或更新系统组件。

## 直接回答滤波问题

之前 `test_gpu_scale.py` 的 OpenCL 实现对每个输出像素覆盖的 2×2 输入块取平均，
Y 与交错 U/V 分别处理，四个输入样本都参加计算。对齐的精确 1/2 缩放中，
它在数学上同时等价于四样本等权区域积分与中心位置双线性；不同实现的整数舍入
仍可能相差一个灰度值。不能把这个特例推广到任意缩放比例。

本轮 `shaders/` 中三个片元 shader：

| 方法 | 实际计算 | 注意事项 |
|---|---|---|
| bilinear.frag | 纹理单元在原始层做双线性，按输出像素中心采样 | 大比例缩小只覆盖相邻四个原始样本，可能混叠 |
| trilinear.frag | 两个相邻 mip 层分别双线性，再按 LOD 小数加权 | 先构造低通 mip 图像；不等同于任意比例的精确区域积分 |
| area.frag | 按输出像素覆盖输入像素的实际面积累计权重 | 非整数比例包含边缘部分像素；整数比例可省掉部分面积计算 |

区域加权的 2 倍缩小使用纹理单元完成等价四样本积分；3 倍缩小使用编译期固定
3×3 累计；2.5 倍缩小仍执行通用面积重叠计算。它们全部与 CPU float32
OpenCV INTER_AREA 参考比较，最终这三组输出误差均为零。
通用区域 shader 原始 2 倍缩小约 20.52 FPS，等价优化后约 43.80 FPS；
原始实验保存在 `results/20261009-160336-631805-shader_scale/`，没有覆盖旧数据。

三线性显式 LOD 为 `log2(max(input_width/output_width, input_height/output_height))`。
2、2.5、3 倍缩小的 LOD 分别为 1、1.321928、1.584963。
2 倍落在 mip 1 上；另外两组实际混合 mip 1 和 mip 2，从而验证两层插值。
`glGenerateMipmap` 的具体滤波由实现决定。测试保存实际 GPU mip 层，CPU 独立
计算其双线性采样与层间权重，验证结果；这不构成对驱动 mip 生成算法的独立认证。

## 包含每帧传输的实测结果

每帧把 CPU NV12 的 Y、UV 上传到 GL_R8、GL_RG8 两个纹理，渲染到同格式输出，
随后读回 CPU NV12；三线性在每一帧上传后生成完整 mip 链。没有 NV12↔RGB 转换。
同步完成后才结束计时，下面每一项都包含上传、渲染、读回和等待 GPU 完成。

| 输出尺寸 | 滤波 | 平均 ms/帧 | P95 ms/帧 | FPS | 进程 CPU ms/帧 |
|---|---|---:|---:|---:|---:|
| 3840×1920 | 双线性 | 22.778 | 22.913 | 43.902 | 5.136 |
| 3840×1920 | 三线性，每帧生成 mip | 18.497 | 19.112 | 54.064 | 5.989 |
| 3840×1920 | 区域加权，2×等价优化 | 22.833 | 22.926 | 43.796 | 5.288 |
| 3072×1536 | 双线性 | 21.390 | 22.266 | 46.751 | 5.048 |
| 3072×1536 | 三线性，每帧生成 mip | 15.733 | 16.131 | 63.560 | 5.497 |
| 3072×1536 | 区域加权，通用面积积分 | 36.417 | 36.565 | 27.460 | 4.949 |
| 2560×1280 | 双线性 | 19.821 | 19.890 | 50.451 | 4.527 |
| 2560×1280 | 三线性，每帧生成 mip | 14.041 | 14.302 | 71.219 | 5.240 |
| 2560×1280 | 区域加权，固定 3×3 | 27.381 | 27.468 | 36.521 | 4.618 |

三线性在本测试更快：采样阶段访问较小的 mip 图像，构造 mip 的开销另有实测；
这是当前驱动、格式和尺寸的结果，不能推成所有输入下三线性总比双线性快。

## 输入与输出留在 GPU 时

这些是离屏绘制并同步完成的墙钟帧率，并非 GPU 时间戳峰值。首尾结果仍读回
校验，但读回与校验在这一测量范围之外。三线性分别给出预先构造 mip 的纯采样
和每帧调用 glGenerateMipmap 后采样两种数据。后者更接近变化的视频纹理需要的工作。

| 输出尺寸 | 双线性 FPS | 三线性纯采样 FPS | 三线性每帧生成 mip FPS | 区域加权 FPS |
|---|---:|---:|---:|---:|
| 3840×1920 | 182.844 | 228.719 | 93.527 | 183.326 |
| 3072×1536 | 199.836 | 322.544 | 107.608 | 49.092 |
| 2560×1280 | 207.970 | 418.339 | 115.661 | 81.274 |

3840×1920 驻留输入时，双线性 CPU 约 0.549 ms/帧，区域加权约 0.566 ms/帧，
三线性包含每帧生成 mip 约 0.856 ms/帧。按 30 FPS 换算约为单核 1.6%～2.6%
的 CPU 时间；含 CPU 上传/读回时约 15.4%～18.0%。这里统计当前进程各线程的
用户态与内核态 CPU 时间，包含测量范围内驱动调用，未统计流媒体和解码进程。
降低 CPU 消耗的关键是让解码与后续处理通过共享缓冲连接，避免反复上传/读回。
本轮没有完成 VPU DMA-BUF→EGLImage 导入或解码、缩放、流媒体并行实测；
不能据此保证整条 8K 视频链路的 30 FPS，也不能直接用两个模块 FPS 取最小值。

## 接口与验证证据

官方 S100 V4.0.2 发布说明列出 EGL 1.0～1.5、OpenGL ES 1.1～3.2、Vulkan 1.0～1.3。
当前板端实际枚举得到 Mali-G78AE、OpenGL ES 3.2、EGL 1.5、Vulkan 1.3.283。
Vulkan 本轮只做真实设备枚举，表中性能来自 GLES。
GL_MAX_TEXTURE_SIZE 实测 16383，GL_R8/GL_RG8 FBO 完整且原生读回成功。
复用板端官方 `sample_gpu_3d/gles/sample_bezier` 的 EGL/GLES/Wayland 接口路径，
改为离屏 pbuffer/FBO，不打开窗口、不换页、不修改桌面服务。

驱动列出 GL_EXT_disjoint_timer_query，但测量中有效时间戳数为零；JSON 明确保存
`gpu_timer_valid_frames=0`、`gpu_render_or_mips_ms_mean=-1`，不能把 -1 当作耗时。
所有表格采用 CLOCK_MONOTONIC 与 glFinish 的同步完成时间。
输入为有空间变化的合成 NV12，同一图像重复处理；不是实际变化内容的摄像机流。
前后温度约 45.7～48.9℃，CPU 频率读数 2 GHz；没有验证高温长时间稳定性。

双线性参考采用 NumPy float64 的像素中心公式；区域参考用 CPU OpenCV float32；
三线性参考使用下载的 mip 图像与独立层间混合。校验遍历整个 Y、UV 输出，
设定最大误差 2、平均绝对误差 0.75 的门限；最终实测最大误差 1、最大平均误差
0.179，精确区域加权全部为零。每一组均检查 60 帧完成、真实 Mali 渲染器、
首尾完整数据尺寸与哈希；初次探测的失败日志也保留在 results/ 中。

## 复跑与文件

```sh
cd /home/sunrise/ainvr/test
python3 test_shader_platform.py
python3 test_shader_scale.py
# 只测一项
python3 test_shader_scale.py --targets 3072x1536 --filters area --frames 120
# 小图验证
python3 test_shader_scale.py --width 1280 --height 640 --targets 512x256 --frames 8
```

当前环境已具备编译器、EGL/GLES/Wayland/Vulkan 开发头文件、Python、NumPy、OpenCV。
需要已有 `/run/user/1000/wayland-0`，可用 HW_WAYLAND_SOCKET 指向其他授权 socket。
所有硬件实验共享 results/.run.lock，默认每个子实验 120 秒超时；不会无限运行。
原始 log、JSON、源码 SHA256、首尾 NV12 和 mip 文件写在对应结果目录。
主要实现为 `test_shader_scale.py`、`native/gles_scale_probe.c`、`native/gles_context.h`
和 `shaders/` 下四个 GLSL 文件。

官方与标准依据：

- [S100 V4.0.2 GPU API 支持](https://developer.d-robotics.cc/rdk_s_doc/Release_Note/s100/v4_0_2)
- [官方 sample_gpu_3d：OpenCL、GLES 示例与 Wayland 连接](https://developer.d-robotics.cc/rdk_s_doc/en/Advanced_development/multimedia_development/S600_multimedia_application/sample_gpu_3d)
- [Khronos GLSL ES 3.20：textureLod、texelFetch](https://registry.khronos.org/OpenGL/specs/es/3.2/GLSL_ES_Specification_3.20.html)
- [Khronos OpenGL ES 3.1：纹理过滤与 mipmap 生成](https://registry.khronos.org/OpenGL/specs/es/3.1/es_spec_3.1.pdf)
