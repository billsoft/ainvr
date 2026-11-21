"""Summarize saved, completed native observations. No inference or network."""
from collections import Counter
import csv
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys


def percentile(values, fraction):
    values=sorted(values)
    idx=(len(values)-1)*fraction
    frac=idx-math.floor(idx)
    return values[math.floor(idx)]*(1-frac)+values[math.ceil(idx)]*frac


def distribution(values):
    return dict(n=len(values),median=statistics.median(values),p95=percentile(values,.95),maximum=max(values)) if values else None


def report(root):
    groups={}
    pairs=[]
    regions=[]
    unavailable=[]
    all_cases=0
    for suite in (root,root/'subcell'):
        manifest=json.loads((suite/'manifest.json').read_text())
        logs=[json.loads(line) for line in (suite/'observations.jsonl').read_text().splitlines()]
        all_cases+=len(manifest['cases'])
        for case in manifest['cases']:
            attempts=[r for r in logs if r['name']==case['name']]
            successful=[r for r in attempts if r['http']==200]
            unavailable.extend(dict(name=r['name'],status=r['http'],attempt=r['attempt']) for r in attempts if r['http']!=200)
            if not successful:
                continue
            assert len(successful)==1
            r=successful[0]
            m=r['match']
            pairs.append(dict(name=r['name'],category=r['category'],ms=r['ms'],matched=m['matched'],
                              inliers=m['inliers'],candidates=m['candidateCount'],reproj=m['reprojectionErrorPx']))
            group=groups.setdefault(r['category'],Counter())
            group['pairs']+=1
            group['global_match']+=int(m['matched'])
            for v in r['regions']:
                regions.append(dict(pair=r['name'],category=r['category'],name=v['name'],policy=v['policy'],
                                    outcome=v['outcome'],maxPx=v['maxPx'],vertexErrorsPx=v['vertexErrorsPx']))
                group[v['outcome']]+=1
    positives=[r for r in regions if r['policy']=='visible']
    negatives=[r for r in regions if r['policy']!='visible']
    comparable=[r for r in regions if r['maxPx'] is not None]
    accurate=[r for r in comparable if r['outcome']=='accepted_accurate']
    false=[r for r in regions if r['outcome'].startswith('false_accept')]
    summary=dict(plannedPairs=all_cases,completedPairs=len(pairs),httpNon200=unavailable,globalMatches=sum(r['matched'] for r in pairs),
        polygons=len(regions),positivePolygons=len(positives),negativePolygons=len(negatives),
        positiveOutcomes=Counter(r['outcome'] for r in positives),negativeOutcomes=Counter(r['outcome'] for r in negatives),
        accurateMaxVertexPx=distribution([r['maxPx'] for r in accurate]),
        allAcceptedWithOracleMaxVertexPx=distribution([r['maxPx'] for r in comparable]),
        allAcceptedWithOracleVertexPx=distribution([error for r in comparable for error in r['vertexErrorsPx']]),
        falseAccepts=false,groups=groups,serviceMs=distribution([p['ms'] for p in pairs]))
    (root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    for name,data in [('pairs.csv',pairs),('regions.csv',regions)]:
        with (root/name).open('w',newline='') as f:
            writer=csv.DictWriter(f,fieldnames=list(data[0]))
            writer.writeheader()
            writer.writerows(data)
    lines=[
        '# 190 场景绑定定量实验',
        '',
        '2026-11-21，已部署 NeuFlow BPU 场景匹配端点及已部署 backend projectScene。输入为离线 JPEG。'
        '每次只提交一对，正常响应后让出至少 6 秒，429 后让出 12 秒。原始响应、时间和多边形判定保存在两个 observations.jsonl。',
        '',
        f"完成 {len(pairs)}/{all_cases} 对，{summary['globalMatches']} 对全局匹配；区域级结果共 {len(regions)} 个。"
        f"可见正例 {len(positives)} 个，准确接受 {len(accurate)} 个；负例 {len(negatives)} 个，误接受 {len(false)} 个。"
        f"非 200 响应 {len(unavailable)} 次，单列于 summary.json。",
        '',
        '正例要求按事先给定的真值矩阵投影，四角最大误差 ≤2.5 px。负例包括无合法对应及有已知独立位移两类。'
        '被完全遮挡且仍获准的区域没有可定义的定位误差。下表单位为 512×384 推理图像像素。',
        '',
        '| 用例 | 区域 | 错误 | 最大角点误差 px |','|---|---|---|---:|',
    ]
    for r in false:
        val='无对应' if r['maxPx'] is None else f"{r['maxPx']:.3f}"
        lines.append(f"| {r['pair']} | {r['name']} | {r['outcome']} | {val} |")
    lines.extend(['','| 类别 | 全局匹配/对数 | 区域准确接受 | 可见区域被拒 | 负例被拒 | 误接受 |','|---|---:|---:|---:|---:|---:|'])
    for k,g in groups.items():
        lines.append(f"| {k} | {g['global_match']}/{g['pairs']} | {g['accepted_accurate']} | {g['visible_rejected']} | {g['negative_rejected']} | {g['false_accept_wrong_geometry']+g['false_accept_no_correspondence']} |")
    lines.extend(['','| 已接受区域的四角最大误差 | 样本数 | 中位 px | P95 px | 最大 px |','|---|---:|---:|---:|---:|'])
    for name,metric in [('可见且正确接受','accurateMaxVertexPx'),('全部有坐标真值的接受','allAcceptedWithOracleMaxVertexPx')]:
        v=summary[metric]
        lines.append(f"| {name} | {v['n']} | {v['median']:.3f} | {v['p95']:.3f} | {v['maximum']:.3f} |")
    lines.extend(['','## 证据边界','',
       '冻结柜子图像及区域来自 scene-matching-20261121。CPU OpenCV 只生成变换、遮挡和离线真值。真实背景、不同平面和重复纹理均有单独标注。'
       '相同图像中的多个区域相关，以上计数是这组有意构造的挑战结果，不是现场故障率。',
       '',
       '单格前景的 8/16/24 px 三个物体覆盖的原始采样格点仅为 0/1/4 个，位移真值来自图层生成。'
       '周边背景仍给同一格提供支持。80% 的分母只含通过可见性、纹理和前后向检查后的候选。'
       '响应提供格布尔值，不能据此还原某个被过滤格点失败的具体原因。精确周期样本另有物理位置不可辨识性。'
       '本实验直接测单对匹配与产品区域投影；后台对没有静止位姿的设备另有双帧确认。持续歧义不会仅靠重复确认获得独立的局部证据。',
       '',
       '## 实拍离线对照','',
       '使用 PG 记录 SHA-256 核验的人工绑定原始 JPEG。仅在参考区域附近提取 SIFT，整张目标图搜索；双向 ratio 0.75 后去重。'
       '独立划分训练和留出集。RANSAC 阈值 1.5 个源图像素；先检查 30 px 邻域，再检查 80 px 邻域。'
       '两者的留出检验和内点凸包要求相同。四角不全在训练内点凸包内时，保留区域内直接测得的留出特征误差。'
       '后台当前点来自图像保存时的状态快照，证据帧和独立 JPEG 存在时差。坐标比较单位为 1280×960 源图像素。',
       '',
       '| 图像 | 产品状态 | 四角最大差 px | 区域内留出点 n/P95 px | JPEG 与证据时差 s |','|---|---|---:|---:|---:|'])
    oracle=root/'live-local-oracle.json'
    if oracle.exists():
        for v in json.loads(oracle.read_text())['cases']:
            corners=v.get('productVsOracleVertexErrorsPx')
            err=v.get('localHoldoutProductErrorPx')
            corner=f"{max(corners):.3f}" if corners else '未核定'
            hold=f"{err['n']} / {err['p95']:.3f}" if err else '无产品坐标或有效对照'
            lines.append(f"| {v['name']} | {v['state']} | {corner} | {hold} | {v.get('evidenceToJpegSec','—')} |")
    lines.extend(['','## 复现和原始数据','',
        '在仓库根目录运行。为防覆盖原观察记录，指定新输出目录。在线实验需业务窗口授权；离线汇总可独立运行。',
        '',
        '```sh',
        'python3 test/ptz/scene_match_benchmark.py "$out"',
        'python3 test/ptz/scene_match_benchmark.py "$out/subcell" --small-foreground',
        'node test/ptz/scene_match_benchmark.mjs "$out"',
        'sleep 6',
        'node test/ptz/scene_match_benchmark.mjs "$out/subcell"',
        'python3 test/ptz/scene_match_benchmark_report.py "$out"',
        '```','',
        'manifest.json 及 subcell/manifest.json 保存所有 JPEG 哈希、区域和真值矩阵，两个 fixtures 目录保存实际输入。'
        'pairs.csv、regions.csv、summary.json 保存每对与每区结果。live-local-oracle.json 保存实拍源哈希、独立估计与留出误差。'
        'provenance.sha256 保存运行版本和脚本哈希。'])
    (root/'report.md').write_text('\n'.join(lines)+'\n')
    return summary


if __name__=='__main__':
    print(json.dumps(report(Path(sys.argv[1])),indent=2))
