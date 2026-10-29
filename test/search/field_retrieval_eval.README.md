# 现场检索离线评测工具

`field_retrieval_eval.py` 只读取人工标签和已导出的排序，不加载模型、不连接生产服务，也不生成标签。Python 3.10+ 标准库即可运行。

```sh
python3 test/search/field_retrieval_eval.py \
  --input test/results/my-labelled-field-runs.json \
  --output test/results/my-field-metrics.json --k 1,5,10,20
python3 -m unittest discover -s test/search -p field_retrieval_eval_test.py -v
```

输入结构见 `field_retrieval_eval.example.json`。它是**故意不能通过评测的模板**：`reviewed`、`complete` 保持 false，必须换成实际人工标注、冻结评测语料与真实导出结果后使用。元数据中的 human 是提交者声明，工具不能替代人工审计其真实性。

- `annotation.id/corpus_id` 标识人工标签版本和固定评测语料。所有时间为 UTC Unix 毫秒，范围为 `[from_ms,to_ms)`；来源使用明确的输出通道标识。
- 每条查询必须人工确认 `reviewed:true`、`complete:true`；complete 指该固定语料、该范围的相关事件集合已标完整。正例须有 relevant IDs；人工确认无匹配才可 `no_match:true` 且 relevant 为空。标签缺失、未复核、自动来源及矛盾标签会拒绝，退出码 2，不输出指标。
- relevant 可写 ID 字符串（标准二元相关性，grade=1），或 `{id,grade:1..3,channel_id,from_ms,to_ms}`。时间三字段可以整体省略，此时只算检索指标并报告时间维度缺失。
- runs 的 B1/B2/B3/final 分别是类别筛选、低频整帧图文、目标加场景不精排、最终链路的**外部真实导出**。工具不实现这四条推理链路。数组顺序就是排名；每项可为 ID 或带时间三字段的对象。必须与人工事件使用同一稳定 ID 命名空间，不用相似文本、文件名猜映射。重复 ID、错来源或越出评测范围会拒绝。
- **缺少 run 键**表示未测，指标为 null 并计入缺失；**存在但空数组**表示确实执行却未返回候选，正例 Recall/nDCG 计 0。不要把未运行的基线写成空数组。

输出给每个 run 提供样本数、逐查询结果及缺失维度。Recall@K 与 nDCG@K 对有该 run 的正例查询取宏平均；nDCG 使用 `(2^grade-1)/log2(rank+1)`。无匹配查询单独统计“前 K 个位置至少返回一个候选”的误返回比例，不混进正例分母。产品如果保留低相关候选，这个比例不等价于界面声称“找到匹配”；应在评测前冻结导出、截断及判断规则。

时间定位只测**相关的 Top-1**，不偷偷选后面更好的结果：报告起止边界、区间中点绝对偏差与两区间最短距离（重叠为 0），单位毫秒；同时列出 Top-1 不相关、无结果、缺时间及有效测量比例。均值/中位数/P95 都带样本数；P95 为 nearest-rank。没有可测样本时为 null，不写成零误差。

不同 run 有缺失查询时应先补齐相同查询集再比较。这里的单测数据是合成算术验证；工具通过、模板存在或报告生成均**不表示已完成现场效果验收**，也不自动设定/降低验收阈值。
