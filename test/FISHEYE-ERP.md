# 鱼眼到 ERP：RDK S100P 专用 GDC 实验

2026-10-09，开发目录 `/home/sunrise/ainvr/test/`。

## 结论与硬件边界

已验证 GDC 的 CUSTOM 坐标映射能够执行鱼眼→经纬展开 ERP，逐帧运行不调用 GPU。
这是一种球面到图像的重投影；不能把“鱼眼成像”和“ERP 输出”都叫成普通畸变。
也不能因官方有名为 Equidistant/Universal 的预设，就直接断言该预设等于 ERP。
这里明确写出 ERP 光线公式，再通过官方自定义网格/API 生成 GDC 配置，实际送帧验证。

S100 有一个 GDC，官方输入、输出上限均为 3840×2160，NV12，DDR→GDC→DDR，
规格列出 3840×2160@60fps。本实验有限帧合成数据的速度高于该典型指标，不构成
对所有镜头、映射、频率、并发链路或长期稳定性的峰值认证。不能直接输入 8K 整帧。
GDC 不自动推断镜头模型或相机朝向；这些参数必须由标定或已知几何提供。

单个 180° 鱼眼最多看到一个半球。180°×180° 的 ERP 半图可由它展开；要生成
完整 360°×180° ERP，需要覆盖另一半球的镜头。STITCH 可承担后续区域拼接/融合，
投影映射仍由 GDC 完成。本轮没有把双镜头、STITCH、解码和流媒体串成整条实测链路，
没有把两次单项帧率直接当作完整全景视频帧率。8K 的分块或先缩小方案也尚未实测。

## 数学定义

采用相机正前方 +Z、右方 +X、上方 +Y，源图像 y 向下；输出 ERP 图像 y 向下。
对于输出像素索引 `(u,v)`、尺寸 `(W,H)`、水平与垂直角度范围 `HFOV,VFOV`：

```text
lambda = ((u + 0.5) / W - 0.5) * HFOV
phi    = (0.5 - (v + 0.5) / H) * VFOV
direction = (cos(phi)*sin(lambda), sin(phi), cos(phi)*cos(lambda))
theta = atan2(hypot(direction.x, direction.y), direction.z)
r = f * theta                         # 理想等距鱼眼，角度为弧度
source.x = cx + r*direction.x/sin(theta)
source.y = cy - r*direction.y/sin(theta)
```

中心方向使用极限值，避免除零。`f=radius/(lens_fov/2)`。
这使输出横坐标与经度等间隔、纵坐标与纬度等间隔，并非透视去畸变或简单圆柱变换。
默认 160°×80° 裁剪在已知可见半球内；完整半球使用 180°×180°。

映射网格包含 `(W+1)×(H+1)` 个端点，连续覆盖输出像素域 `[0,W]×[0,H]`，
二进制格式为小端 float64 XY，坐标单位为源像素。传给 CUSTOM 的 w/h 为 W/H，
中心为 W/2、H/2。最初按 W×H 网格实现会产生一像素的整体压缩；通过 identity
控制实验发现并修复，早期失败记录保留，未拿旧配置的数据作为最终结果。

脚本还预留等立体角、立体投影、正交鱼眼及 OpenCV fisheye k1～k4 径向多项式。
本文性能与独立球面几何校验都使用理想等距鱼眼；其他实际镜头的标定准确性没有
在本轮验证，默认各向同性焦距，不能据此替代真实镜头内参和外参标定。

## 单路性能

每种模式测 120 帧，另有 3 帧预热。`shared_input` 表示输入已在 hbmem 共享缓冲，
重复提交同一张合成 NV12；输出由 GDC 写入共享缓冲。`cpu_copy_and_flush` 每一帧
先复制 CPU NV12 到输入缓冲并刷新缓存。两种时间均包含 sendframe、getframe 完成
和 releaseframe；首尾校验、输出缓存检查、磁盘写入在计时范围之外。

| 输入 | ERP 输出/角度 | 镜头 FOV | 共享输入 FPS | CPU 每帧复制输入 FPS |
|---|---|---:|---:|---:|
| 1920×1080 | 1920×960，160°×80° | 180° | 504.986 | 437.684 |
| 3840×2160 | 3840×1920，160°×80° | 180° | 130.267 | 113.962 |
| 3840×2160 | 1920×1920，180°×180° 半球 | 180° | 223.716 | 179.946 |
| 3840×2160 | 1920×1920，180°×180° 半球 | 190° | 226.575 | 179.205 |

关键 4K→3840×1920 一项：共享输入平均 7.677 ms、P95 7.709 ms，
当前进程 CPU 时间约 0.024 ms/帧；每帧复制输入平均 8.775 ms、P95 8.877 ms，
CPU 时间约 1.105 ms/帧。按 30 FPS 换算，后者约为单核 3.3% 的 CPU 时间。
没有包含接收、解码或流媒体进程，也没有与这些工作同时争用 DDR 的实测。
复用 VPU 或相机缓冲时，应遵守 hbmem 引用、缓存与完成同步规则，不能仅传一个
物理地址就忽略缓冲生命周期。本轮输入缓冲在整个实验期间保持有效。

Python 的三角计算与 GDC bin 生成仅发生在初始化；固定相机固定 ERP 映射可复用
生成的 bin。4K 裁剪的 native bin 生成约 0.329 秒、bin 19492 字节；这不包括
Python 生成合成图像、密集坐标网格和写文件的时间。动态逐帧改变映射的成本未验证。

## 正确性与圆边缘、极点

控制实验采用平滑笛卡尔坐标图，检查 CUSTOM 格点定位。4K identity 的 Y、UV
内部像素均与 CPU 参考完全一致；控制实验排除外侧两像素边框，因为 GDC 的源边缘
填充与 CPU 的 clamp 规则不同。ERP 的 CPU 对比遍历整个输出平面，没有排除边框。

合成鱼眼用 Y 编码世界经度、U 编码世界纬度、V 编码非恒定角度图案。CPU OpenCV
remap 独立采样源图，与 GDC 首尾 NV12 比较；另用直接球面角度公式验证经度、纬度
展开，不仅比较一次预先生成的坐标文件。首尾结果、完成帧数、尺寸、哈希、native
源码哈希及完整错误统计均保存。误差门限为各平面平均绝对误差≤1.25、P99≤4；
PASS 是功能和这些门限通过，不代表每个像素完全相同或实拍画质已验收。

| 实验 | Y 平均误差 | UV 平均误差 | Y/UV 最大误差 | P99 Y/UV |
|---|---:|---:|---|---|
| 4K，160°×80° ERP | 0.0074 | 0.0311 | 1 / 1 | 0 / 1 |
| 4K，180°镜头，完整半球 | 0.1187 | 0.1420 | 139 / 79 | 1 / 1 |
| 4K，190°镜头，完整半球 | 0.0506 | 0.0654 | 32 / 2 | 1 / 1 |

180° 完整半球的最大 Y 差异位置为输出 `(x=1916,y=1899)`，映射源半径
1036.673 像素，而鱼眼圆半径是 1036.8：它极接近鱼眼圆的截断边缘。
Y 误差大于 4 的像素占约 0.409%，大于 16 占约 0.202%。这项如实保留，不能用
“99% 像素误差小”宣称圆边缘完全可靠。190° 模拟镜头给 180° 输出留下视场余量，
圆边缘差异减少；仍有约 0.117% Y 像素误差>4，最大 32，集中在高梯度/极点区域。
这些是合成角度图案、离散输入采样与硬件映射/插值共同作用的差异，尚未拆出所有成因。

190° 测试的独立经度、纬度平均误差分别约 0.255、0.253；这项几何校验排除
离圆边缘不足 4 像素或纬度绝对值≥85° 的区域。全幅 CPU 对比仍保留这些位置。
把配置计算步长从 8 改成 1 后，bin 生成耗时从约 0.093 秒增至 0.672 秒，
相同首尾图像和误差没有改善，不能把减小步长当作已经解决圆边缘问题。
实际使用要先确认鱼眼有效圆、镜头 FOV、标定和边缘余量，再验收实拍画质。

## 实现与复跑

代码：`test_fisheye_erp.py`、`native/gdc_erp_probe.c`。native 使用官方
`hbn_gen_gdc_cfg`、`hbn_vnode_open(HB_GDC,0,...)`、sendframe/getframe 接口。
ELF 的直接依赖为 libvpf、libhbmem、libc 和系统加载器；没有链接 EGL/GLES/OpenCL/Vulkan。
参考板上 `/app/multimedia_samples/sample_gdc/3-gdc_static_valid/gdc_static_valid.c`
的节点与缓冲设置，并保留官方文件。输出为连续缓冲时 fd[1] 可为 -1，正确使用
fd[0] 对两平面缓存失效；首个版本因此失败，已修复，没有把失败记为通过。

```sh
cd /home/sunrise/ainvr/test
# 默认 1080p 源，160°×80° ERP
python3 test_fisheye_erp.py --frames 120
# 4K 源和较大 ERP 裁剪
python3 test_fisheye_erp.py --width 3840 --height 2160 --output-width 3840 --output-height 1920 --frames 120
# 190° 理想鱼眼展开为完整 180°×180° 半球
python3 test_fisheye_erp.py --width 3840 --height 2160 --output-width 1920 --output-height 1920 --hfov 180 --vfov 180 --lens-fov 190 --projections erp --frames 120
# 实际 NV12 输入：镜头参数需替换为自己的标定值
python3 test_fisheye_erp.py --input /path/to/frame.nv12 --projections erp --cx 959.5 --cy 539.5 --radius 518.4 --lens-fov 180
```

输入/输出宽度 16 对齐，高度偶数，限制在 96..3840×96..2160。输出请求超出镜头
可见方向或坐标越界会拒绝；不会将不可见半球凭空补成图像。其他资源实验共享互斥锁，
native 每次 getframe 超时 2 秒，默认每个子实验最长 180 秒；不修改系统或启动服务。
代码已在当前板端使用现有 Python、NumPy、OpenCV、SDK 开发库编译、执行。

原始结果：

- 1080p：`results/20261009-162754-090475-fisheye_erp/`
- 4K 裁剪与 identity：`results/20261009-162819-866422-fisheye_erp/`
- 180° 完整半球：`results/20261009-162855-564806-fisheye_erp/`
- 190° 完整半球，经纬独立检查：`results/20261009-163337-299953-fisheye_erp/`
- 190°、配置步长 1：`results/20261009-163505-242965-fisheye_erp/`
- 最终小图控制：`results/20261009-163336-710977-fisheye_erp/`

每个目录保留 projection.json、map-xy-f64.bin、gdc-erp.bin、input.nv12、
首尾输出、gdc-erp.png、cpu-reference.png、原始 log 和 result.json。较早的 120 帧
数据记录独立经度检查；最终脚本与后续结果同时记录独立纬度检查。

依据：

- [官方 S100 Camsys：GDC 限制、CUSTOM 网格和配置 API](https://developer.d-robotics.cc/rdk_s_doc/en/Advanced_development/multimedia_development/S100/camsys)
- [官方 sample_gdc：自定义配置、bin 生成与硬件回灌](https://developer.d-robotics.cc/rdk_s_doc/en/Advanced_development/multimedia_development/S600_multimedia_application/sample_gdc)
- [Paul Bourke：鱼眼与球面经纬展开](https://paulbourke.net/dome/fish2/index.html)
- [Paul Bourke：双鱼眼覆盖完整球面](https://paulbourke.net/dome/dualfish2sphere/index.html)
