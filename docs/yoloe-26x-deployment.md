# YOLOE-26x 开放词汇推理与部署

## 产品契约

用户填写识别描述，模型按该描述检测目标，没有预设的业务类别。标签 ID 用于检索，标签名称用于显示，两者由用户定义，不能反向替代识别描述。新建开放词汇通道时三个字段为空，必须填写；切换高速和高级模型时保留输入。

自由输入不代表任何对象都能可靠识别。建议先使用明确、简短的英文描述，并通过真实画面验证准确率。单个通道当前对应一个描述和一组标签，不支持一次配置多个独立类别。

## 两条推理路径

| 界面名称 | 执行路径 | 修改识别描述 | 检测分数 |
| --- | --- | --- | --- |
| 开放词汇模型（高速） | YOLOE-26x 原始权重，CUDA FP16 | 下一次请求生效，不编译引擎 | 模型原生检测分数 |
| 开放词汇模型（高级） | LocateAnything-3B，TensorRT FP16 | 下一次请求生效，动态文本输入 | 未提供时标记未知，不伪造 0% |

高速模型使用 `yoloe_pt` 适配器。常驻本机执行器通过 `set_classes` 更新文本嵌入，最多缓存 16 个描述。首次使用新描述有文本编码和预测器准备开销，同一个描述后续请求复用模型。文本缓存淘汰只影响性能，不限制用户输入的对象。

使用 `YOLOE('yoloe-26x.yaml').load('yoloe-26x-seg.pt')` 加载检测结构，不输出分割蒙版。输入经过 640×640 等比例补边；返回原图像素坐标和真实检测分数。推理时使用 `quantize=16`，并检查实际预测后端的参数类型，防止只修改配置却没有运行 FP16。通道的置信度阈值和目标上限在 AI 服务端裁决。

执行器返回结果后，AI 服务补充用户标签，组织统一 JSON、写入 SEI，并按通道配置进行截图、投影、亮度调整、增强和归档。每个实际完成识别且符合筛选条件的目标都归档；归档积压通过反压降低该通道实际识别帧率。调整描述时，在途请求仍使用它原来的描述与标签。

早期试验过把描述编译进 TensorRT 引擎的固定词汇版本，它不能通过修改配置改变识别对象，已被本路径取代并从代码中移除；页面和配置只接受上述两条路径。

## 离线材料和运行环境

- 原始权重：`ai-service/models/yoloe-26x-seg.pt`。
- 文本编码器：`ai-service/models/yoloe-text-encoder/mobileclip2_b.ts`。
- Python 环境：`ai-service/runtime/yoloe/venv`，继承设备已经验证的 CUDA PyTorch，不能替换成通用 CPU 轮子。
- 已验证组合：PyTorch 2.3.0、Ultralytics 8.4.142，以及 CLIP、ftfy、wcwidth。部署前备齐依赖；业务启动期间不联网下载。
- 启动入口：`ai-service/runtime/yoloe/launch.sh`。
- 服务模板：`ai-service/deploy/ainvr-yoloe.service.example`。

将服务模板安装为 `/etc/systemd/system/ainvr-yoloe.service`，更新 systemd 配置并启用服务。服务建立本机接口后发送就绪通知；通道启动时才初始化模型，停止通道后释放。AI 通道填写 `data/yoloe/worker.sock`；目录和套接字仅允许服务用户访问。两种开放模型共用设备资源额度，同一时间仅允许一路开放词汇通道运行。完整离线安装约定见 [执行器部署](open-vocabulary-runtime-deployment.md)。

不要在原生产二进制目录中构建。先在独立构建目录编译，备份并替换程序，再启动执行器和 AI 服务。前端需要同步构建发布，否则旧页面仍可能显示旧固定类别的说明。

## 验证

单元验证：

```sh
ai-service/runtime/yoloe/venv/bin/python ai-service/runtime/yoloe/test_runtime.py
```

真机 GPU 验证使用测试图，连续切换 `person → bus → person`，检查类别变化、坐标、分数、FP16 和重复请求结果：

```sh
AI_YOLOE_PT_TEST=/absolute/path/to/bus.jpg \
  ai-service/runtime/yoloe/venv/bin/python ai-service/runtime/yoloe/test_runtime.py
```

同时验证配置、工厂、API 和前端表单测试，以及任意描述和标签可保存、切换模型不覆盖输入、归档交付账目和 SEI 计数持续增长。不要把某一提示词的演示结果当成开放词汇准确率保证。

高速路径的压缩视频发布使用约 3 秒结果等待窗口；高级路径保留较长等待窗口。这些都是有限预算，异常慢的请求仍可能晚于对应视频帧的发布时间，必须监控延迟和发布指标，不能承诺无上限缓存。
