from pathlib import Path
import json,sys
ROOT=Path(sys.argv[1]);j=json.loads((ROOT/'comparison.json').read_text());ident=json.loads((ROOT/'model-identity.json').read_text())
v,q=j['vl'],j['q35']
pc=lambda x:f'{100*x:.2f}%'
sec=lambda x:f'{x/1000:.3f} 秒'
gib=lambda x:f'{x/2**30:.3f} GiB（{x/1e9:.3f} GB）'
def accuracy(x):
 c=x['classification'];return f"{pc(c['accuracy'])}（{c['correct']}/{c['n']}）；按图像聚类95%区间 {pc(c['image_cluster_bootstrap_ci95'][0])}–{pc(c['image_cluster_bootstrap_ci95'][1])}"
rows=[
 ('实测模型包','Qwen3-VL-4B O2 v3','Qwen3.5-4B O2 v1'),
 ('决策任务完整重跑',str(v['n']),str(q['n'])),
 ('进程内模型加载，未清空文件缓存',f"{v['load_seconds']:.2f} 秒",f"{q['load_seconds']:.2f} 秒"),
 ('单条总耗时中位数',sec(v['timings']['total']['median_ms']),sec(q['timings']['total']['median_ms'])),
 ('单条总耗时平均数',sec(v['timings']['total']['mean_ms']),sec(q['timings']['total']['mean_ms'])),
 ('单条总耗时 p95',sec(v['timings']['total']['p95_ms']),sec(q['timings']['total']['p95_ms'])),
 ('读取图像与切片预处理中位数',sec(v['timings']['patchify']['median_ms']),sec(q['timings']['patchify']['median_ms'])),
 ('视觉阶段中位数',sec(v['timings']['vision']['median_ms']),sec(q['timings']['vision']['median_ms'])),
 ('文字阶段中位数，含宿主布局操作',sec(v['timings']['text']['median_ms']),sec(q['timings']['text']['median_ms'])),
 ('决策头中位数',sec(v['timings']['head']['median_ms']),sec(q['timings']['head']['median_ms'])),
 ('串行吞吐，按总耗时平均数计算',f"{60000/v['timings']['total']['mean_ms']:.2f} 条/分钟",f"{60000/q['timings']['total']['mean_ms']:.2f} 条/分钟"),
 ('408 条有标签样本准确率',accuracy(v),accuracy(q)),
 ('误确认，负例判为是',str(v['classification']['fp']),str(q['classification']['fp'])),
 ('漏确认，正例判为否',str(v['classification']['fn']),str(q['classification']['fn'])),
 ('正例召回率',pc(v['classification']['recall']),pc(q['classification']['recall'])),
 ('精确率',pc(v['classification']['precision']),pc(q['classification']['precision'])),
 ('F1',f"{v['classification']['f1']:.4f}",f"{q['classification']['f1']:.4f}"),
 ('与各自冻结 BF16 判定一致率，559 条',pc(v['bf16_agreement']['0.5']),pc(q['bf16_agreement']['0.5'])),
 ('相对 BF16 翻转条数',str(len(v['bf16_flips_0_5'])),str(len(q['bf16_flips_0_5']))),
 ('各自 BF16 冻结参考的标签准确率',pc(v['bf16_classification']['accuracy']),pc(q['bf16_classification']['accuracy'])),
 ('告警测试进程 RSS 高水位',f"{v['resources']['rss_high_watermark_bytes']/2**20:.1f} MiB",f"{q['resources']['rss_high_watermark_bytes']/2**20:.1f} MiB"),
 ('告警测试 ION 进程可见缓冲峰值下限',gib(v['resources']['ion_fdinfo_lower_bound_peak_bytes']),gib(q['resources']['ion_fdinfo_lower_bound_peak_bytes'])),
 ('运行期间系统可用内存最低值',gib(v['resources']['system_mem_available_min_bytes']),gib(q['resources']['system_mem_available_min_bytes'])),
 ('运行期间最高温度',f"{v['resources']['temperature_max_C']:.1f} °C",f"{q['resources']['temperature_max_C']:.1f} °C"),
 ('HBM 包数量',str(len(ident['vl']['packages'])),str(len(ident['q35']['packages']))),
 ('HBM 文件总量',gib(ident['vl']['package_bytes']),gib(ident['q35']['package_bytes'])),
 ('文字分包／预填充档位','4 个九层组／256 行','32 个单层组／64 行'),
 ('每条文字阶段 BPU 调用次数中位数，按执行计划计算',str(v['text_bpu_calls_median']),str(q['text_bpu_calls_median'])),
 ('受限问答正确数，另设 32 题',f"{v['dialog']['correct']}/32（{pc(v['dialog']['accuracy'])}）",f"{q['dialog']['correct']}/32（{pc(q['dialog']['accuracy'])}）"),
 ('受限问答耗时中位数',sec(v['dialog']['timings']['total']['median_ms']),sec(q['dialog']['timings']['total']['median_ms'])),
 ('受限问答进程 RSS 高水位',f"{v['dialog']['resources']['rss_high_watermark_bytes']/2**20:.1f} MiB",f"{q['dialog']['resources']['rss_high_watermark_bytes']/2**20:.1f} MiB"),
 ('受限问答 ION 峰值下限',gib(v['dialog']['resources']['ion_fdinfo_lower_bound_peak_bytes']),gib(q['dialog']['resources']['ion_fdinfo_lower_bound_peak_bytes'])),
 ('自由文字对话／完整生成输出 token/s','当前包不支持，未测','当前包不支持，未测'),
]
text='# S100P：Qwen3-VL-4B 与 Qwen3.5-4B 同机 O2 实测（2026-10-26）\n\n'
text+='## 统一测试口径\n\n'
text+='- 同一 S100P、同一 BPU 核 0，两个模型串行测试；生产识别、大模型及参考审核任务暂停，原始接入与录像持续运行。\n'
text+='- 同一 559 条输入；所有图片逐项 SHA-256 相同，固定 896×448、392 个图像占位词元，容量 1024。模型使用各自原生聊天模板并关闭思考模式；分词器已复现冻结样例的完整词元序列。\n'
text+='- 408 条有标签 COCO 样本（219 正例、189 负例）用于准确率；标签由 COCO 类别／人数标注映射生成，并非逐条重新人工复审的告警金标。少数描述如“有人拿着手机”“出现车辆”比类别映射更宽或多出关系条件，因此主指标仅代表冻结标签口径；100 条现场画面及51条无明确标签 COCO 样本不计入准确率。559 条均用于 BF16 一致率和性能。\n'
text+='- 准确率及翻转以固定阈值 0.5 计算。BF16 为同一批 ID 的已冻结原版参考，本次没有重跑 PC BF16。\n'
text+='- 单条总耗时不含加载和外部排队，包含 CPU 图像预处理、宿主嵌入行查询／布局、BPU 视觉／文字／决策头；这是一套独立模型实验脚本，并非生产 HTTP 多帧审核端到端耗时。无神经网络 CPU 回退。\n'
text+='- 内存每 0.5 秒安全读取 /proc，按缓冲 inode 去重；没有读取 /sys/kernel/debug/ion。ION 是进程可见缓冲的下限；RSS 与 ION 可能存在映射口径重叠，不能简单相加后称精确物理峰值。GiB=2^30 字节，GB=10^9 字节。\n\n'
text+='## 完整对比\n\n| 指标 | Qwen3-VL-4B | Qwen3.5-4B |\n|---|---|---|\n'+''.join(f'| {a} | {b} | {c} |\n' for a,b,c in rows)
text+='\n## 按目标类别\n\n| 类别 | 样本数 | Qwen3-VL 准确率 | Qwen3.5 准确率 |\n|---|---:|---:|---:|\n'
for kind,c in v['categories'].items():text+=f"| {kind} | {c['n']} | {pc(c['accuracy'])} | {pc(q['categories'][kind]['accuracy'])} |\n"
text+='\n## 参考双门限（非生产准入结论）\n\n仅统计408条有标签样本，p≤0.05判否，p≥0.95判是，中间保留未定；分数未经概率校准，不能凭这一小集启用或更改生产审核。\n\n| 指标 | Qwen3-VL | Qwen3.5 |\n|---|---:|---:|\n'
for label,key in [('可作二选一决定的条数','decided'),('保留未定的条数','left_for_manual'),('高分误确认','false_supported'),('低分漏确认','false_rejected')]:text+=f"| {label} | {v['reference_gate_0_05_0_95'][key]} | {q['reference_gate_0_05_0_95'][key]} |\n"
text+='\n## 受限问答与对话范围\n\n'
text+='两个已编译决策头都只有 22 个候选词元：是／否、A–F、0–9、Yes／No 等。本次使用统一空白附图、文字题和整段历史重放，按事先冻结答案测试指令理解、推理、多轮上下文及证据边界。是／否题以0.5阈值，其余题在题目允许的候选答案间取最大logit。它不是完整词表自由解码，不支持据此评价长文、代码生成、输出 token/s 或通用聊天排名。\n\n'
text+='| 类别 | 题数 | Qwen3-VL 正确 | Qwen3.5 正确 |\n|---|---:|---:|---:|\n'
for c,a in v['dialog']['categories'].items():text+=f"| {c} | {a['n']} | {a['correct']} | {q['dialog']['categories'][c]['correct']} |\n"
text+='\n逐题结果：\n\n| ID | 类别 | 标准答案 | Qwen3-VL | Qwen3.5 |\n|---|---|---|---|---|\n'
for a,b in zip(v['dialog']['cases'],q['dialog']['cases']):text+=f"| {a['id']} | {a['category']} | {a['expected']} | {a['predicted']} | {b['predicted']} |\n"
p=j['paired'];text+=f"\n## 解释边界\n\n两者在有标签集上，只有 Qwen3-VL 答对的样本 {len(p['vl_only_correct'])} 条，只有 Qwen3.5 答对的样本 {len(p['q35_only_correct'])} 条；条目级配对 McNemar 双侧 p={p['mcnemar_exact_two_sided_p']:.4f}。同图多题存在相关性，因此表中区间按图像整体重采样（10000次）计算，条目级p值仅作描述参考。不要将有限样本上的准确率差异当作所有现场场景的能力结论。\n\n"
text+='O2 是编译优化级别，不代表两个模型使用相同量化配方或相同运行实现。本次对比的是实际可运行产物；分包数量、档位与宿主布局都影响文字阶段速度，不能仅凭耗时就把差距全部归因于底座架构。模型分数未被证明是校准概率；本次不修改生产阈值、不替换生产模型。\n\n'
text+='## 复现与原始证据\n\n模型路径／HBM 哈希见 model-identity.json；词元身份见 tokenization-identity.json；全部逐条分数、阶段耗时、内存／温度采样、问题与标准答案见同目录 JSON/JSONL；结构化汇总为 comparison.json。服务暂停前及恢复后记录为 services-before.json 与 services-restored.json。测试脚本位于 test/qwen_compare_20261026/。\n'
(ROOT/'REPORT.md').write_text(text,encoding='utf-8')
print('report generated',ROOT/'REPORT.md')
