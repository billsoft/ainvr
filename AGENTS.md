# 当前对话工作约定

- 当前对话的默认开发目录是远程 Git 仓库 /home/sunrise/ainvr/；除非用户特别指定，不在本机项目中开发。
- 用户授权的开发板连接目标：root@192.168.100.187，SSH 端口 22。不要在文件中保存认证密码。
- 开发板型号：地瓜 RDK S100P。
- 硬件实验代码统一放在 /home/sunrise/ainvr/test/，说明见 test/README.md，结果见 test/results/。
- 保存已有修改；硬件测试串行、有限帧数、有超时；SKIP 和接口存在不能当作硬件功能通过。

## 当前会话长期约定（2026-10-11）

- 当前研发对象是地瓜 RDK S100P 开发板，目标是在 /home/sunrise/ainvr/ 开发 AINVR 产品。
- 其他项目代码，尤其 Git 子模块（例如 TecheAI），仅作为只读参考；不得修改、提交、更新其内容或子模块引用，除非用户明确另行要求。
- 当前会话开发的 AINVR 项目自身代码、产品品牌与版权署名统一使用 AINVR；与 teche、TecheAI、泰科易没有品牌或版权归属关系。
- 本机 D:/code/kakadeai 等其他项目不是本会话的开发目标；继续遵守远程工作目录和 test/ 实验目录约定。
- 开发板当前有线 SSH 地址为 192.168.100.189，Wi-Fi 地址为 192.168.100.187，端口均为 22；不保存认证密码。

## Migration compatibility (user direction, 2026-10-11)

- Reuse mature TecheAI code for non-hardware business logic and preserve its API contracts. Restrict adaptations to required deployment settings and AINVR branding. TecheAI remains read-only.
- Match pinned SRS and FFmpeg versions where possible; verify both executable and linked library versions in each running service.
- Replace Jetson/CUDA-specific implementations behind hardware adapters, not by simplifying established product behavior.

## Hardware execution policy (2026-10-11)

- User requires all deployable models to be compiled and validated for the S100P BPU. CPU inference is not an accepted production fallback.
- Use dedicated VPU/PYM/GDC/JPU hardware for supported media/image operations; use OpenGL ES GPU for remaining supported image operations. CUDA is not available on S100P.
- CPU reference algorithms may remain as explicitly labeled test oracles only. Do not silently enable CPU inference/image processing in production. Unsupported hardware paths must report unavailable until implemented and verified.

## Model source storage and priority (user direction, 2026-10-12)

- Original PT/ONNX/PTH/TorchScript/safetensors are stored on mounted SSD at
  /mnt/ainvr-ssd/model-sources/ainvr-20261012/models/. The checksummed relocation
  manifest is /mnt/ainvr-ssd/model-sources/ainvr-20261012/migration-manifest.json.
- /home/sunrise/ainvr/ai-service/models/ is for compiled HBM deployment artifacts
  and their required .hbm.ainvr.json sidecars only. Keep ONNX exports, compiler
  work directories, calibration data, package caches and source weights on SSD.
- Prioritize successful BPU conversion and real channel verification for
  YOLO26x COCO 80 classes, YOLO26x-face and GPEN256. YOLOE-26x is the sole
  intended open-vocabulary option, subject to actual BPU feasibility. Keep new
  UI model selection limited to these targets; preserve old-record rendering.

## Host-side model compilation (user direction, 2026-10-12)

- The user explicitly authorizes model compilation on the ordinary local
  computer, followed by uploading compiled artifacts to 192.168.100.189.
  Keep first-party source development in the remote AINVR repository; local
  task staging, official toolchains and model compilation outputs are allowed.
- Use official OE 3.7.0 on an x86_64 host and target nash-m for S100P. The
  board /etc/version still reads 4.0.4-Beta, while installed hobot-dnn and
  multimedia packages are 4.0.5; confirm actual HBM runtime compatibility.
- CPU Docker means host-side compilation. It does not authorize CPU model
  inference in the deployed production service.

## BPU-only inference clarification (user direction, 2026-10-12)

- Model inference must use compiled HBM on BPU. Do not pursue GPU model
  inference. PYM and other dedicated engines take priority for preprocessing;
  GPU OpenGL is reserved for image operations unsupported by dedicated engines
  or dimensions exceeding their limits.
- First test FP16, or FP16/FP32 mixed floating precision. Do not label integer
  convolution mixed with floating operators as an all-floating model. Preserve
  original FP32 references for numerical checks; file storage precision alone
  does not establish actual BPU execution precision.
- For each requested model, correct BPU output and measured throughput above
  5 FPS authorize direct AI-service integration without asking again. Speed
  alone does not authorize a model with failed accuracy checks.
- If the official BPU compiler cannot support the requested floating operators,
  report that limitation explicitly. Do not silently substitute GPU inference
  or deploy random-calibrated integer probes.

## INT8 calibration authorization (latest user direction, 2026-10-12)

- The user now explicitly requests INT8 quantization of the selected models.
  This supersedes the earlier floating-first restriction for these experiments.
- Use D:/code/yolovt/data/coco1920x3840/images/train2014 for YOLO26x COCO80
  calibration, rather than only a few frames from the current live camera.
- Use E:/数据集下载/dataset/CelebA/Img/img_celeba for face-model calibration,
  with the accompanying official face boxes and train/validation partition.
- Separate calibration and validation samples. GPEN256 requires face crops
  and its own RGB normalization, not entire COCO scene images. Do not claim
  good accuracy solely because compilation or throughput checks succeed.
- BPU-only inference and dedicated image hardware priority remain in effect.

## Completion authorization (latest user direction, 2026-10-12)

- Docker may be restarted when necessary to repair the local compilation
  environment. Restore and verify previously running application containers.
- Choose the recommended precision strategy that preserves useful model
  quality and produces functional HBM inference. Start with representative
  INT8 calibration; use supported INT16/FP16 sensitive-layer mixing if needed.
- Completion requires the requested HBM models, real S100P inference,
  AI-service integration and the corresponding Web UI; compilation alone is
  not completion. The latest objective now includes YOLOE-26x as a required
  fourth model, with runtime vocabulary switching; it is no longer optional.

## HBM compilation optimization (user direction, 2026-10-12)

- Follow docs/S100P-HBM-COMPILATION.md for subsequent HBM development.
- Validate an O0 HBM first, retain quantized BC and calibration artifacts on SSD,
  then reuse the same BC for O2 runtime optimization without recalibration.
- Compare outputs and board throughput before deployment; do not extrapolate
  GPEN's measured 5.67x inference gain to other models without testing.
- GPEN O2 achieved 92.749 inference FPS and 75.247 warm snapshot-archive FPS;
  128 independent outputs were exactly equal to the visually accepted O0 model.
- The user's explicit visual acceptance permits this GPEN model and its verified
  identical-output optimization. Preserve its failed strict FP32 numerical gate
  in metadata; this exception does not approve inaccurate detector models.

## GPU migration and resource controls (latest user direction, 2026-10-12)

- The user explicitly requested stopping CPU-image compilation and starting
  two GPU compilation containers. The old CPU and obsolete diagnostic jobs
  are stopped with their files retained. Do not restart those jobs merely
  because their saved status files still say compiling.
- Preserve existing calibration/PTQ/BC before migration. GPU image and O2 are
  separate choices: O2 optimizes BPU runtime, and final compiler CPU work is
  not automatically replaced by GPU computation.
- The two new containers are ainvr-gpu-face-o2-20261012 and
  ainvr-gpu-yoloe-20261012, both verified to access the RTX 4090. Start with
  jobs=4 and sufficient CPU/memory quota, then use actual memory evidence.
- Monitor VM, container RAM and GPU headroom. Pause only owned new compile
  containers under pressure; pausing retains allocations, so release memory
  by safely stopping a paused task if pressure remains critical. Preserve
  checkpoints and never touch miners, other projects or production services.

## Latest delivery priority (user direction, 2026-10-12)

- Finish and audit YOLO26x COCO80, YOLO26x-face and GPEN256 HBM, the AI service
  and the Web UI first. YOLOE is placed last and must not delay delivery of these
  three working models. Preserve its research and failed quality/placement data;
  do not launch another long YOLOE compilation while this delivery is unfinished.
- GPEN snapshots retain an enhancement-before original as well as the processed
  JPEG. The large-image viewer offers explicit original/processed selection.
- Tiny archive crops are padded on GLES to the JPU minimum canvas, preserving
  the original pixels; metadata describes the actual encoded dimensions. No
  CPU image fallback is permitted. Old quarantined RGBA files are backed up
  before normal pending-file replay; respect the original deletion ledger.


## SRS channel ownership (user direction, 2026-10-17)

- All SRS input and output channels must be configured in Access Management.
- An AI channel is an AI processor: select one existing input SRS channel and
  one existing output SRS channel. Do not create SRS channels inside AI flows.
- Preserve manually configured channels and bindings. Do not recreate deleted
  agent-created trial channels or restore an earlier configuration.


## 全局弹窗关闭规范（用户长期要求，2026-10-22）

- AINVR 所有弹窗、弹窗向导和编辑窗口，除“取消”外，均提供清晰可见的右上角“×”关闭按钮，不能只依赖底部取消按钮。
- “×”与“取消”使用同一取消流程：放弃该窗口中尚未保存的操作，不得触发保存、提交或隐式生效。已成功保存的操作不因关闭而回滚。
- 有未保存修改或业务上要求二次确认的窗口，点击“×”仍须经过相同的放弃确认；确认前保留全部草稿，选择继续编辑则留在原窗口。无修改、纯查看窗口可直接关闭。
- Esc 与关闭/取消保持一致，不绕过确认；关闭后焦点返回打开窗口的控件。
- “×”需有可访问名称“关闭”，图标尺寸与全站协调，触摸点击区域至少 44×44 像素，兼顾 iPad 与键盘鼠标。后续新建、重构和验收弹窗均检查此规则。

## 部署备份规范（用户长期要求，2026-10-27）

- 源代码以 Git 为准。部署、迁移、安装前生成的回滚包、配置快照、旧发布产物等备份只用于短期应急回滚，不作为长期存档。
- 所有备份统一放在固态盘 `/mnt/ainvr-ssd/ainvr-rollback/<服务名>/<时间戳>/`，不得写入系统盘 eMMC（包括 `deploy/s100p/rollback-*`、`/var/backups`、代码目录）。固态盘不可用时不得退回写系统盘。
- 每个服务最多保留 3 份备份。部署成功后立即删除该服务最旧的备份，使总数不超过 3 份；同一服务不得因不同脚本或不同功能名称分散保存而绕过此上限。
- 新增或修改部署、迁移、安装脚本时，必须遵守以上位置和数量规则；验收时检查备份位置与份数。

## 统计分析页面设计约定（用户确认，2026-10-30）

- 视觉以 GitHub `ba43d3a` 统计分析原型及用户截图为基准，保持紧凑工具栏、下划线页签、清晰图表比例和留白；功能与交互依据真实数据能力调整。
- 编辑底图只规划布局和展示位置，不修改检测范围。浏览时底图、规划框与数据层使用同一坐标变换，居中、等比例自动适配，保留完整底图及已规划内容，不被固定空画布压小。
- 分布必须使用底图上的独立热力图层。规划框保持透明，不能以区域整块换色或加数字替代热力图。计数相对示意与原画面真实观测热度要明确区分口径，未经标定不宣称地面投影。
- 沿用现有前后端、PG/Mongo、观测消费者、绘图库与播放器；不为统计页面重复采集或另建并行技术栈。
- UI 修改后用内置浏览器自动化截图复测总览、热区和底图编辑/预览；检查 1366×768、1180×820、1920×1080 的布局、实际叠层、缩放与关键交互，不能只凭构建或单元测试判断美观和可用。
