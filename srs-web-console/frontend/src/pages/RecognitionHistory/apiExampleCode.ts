/**
 * "识别历史"页 → "检测接口示例"弹窗的代码生成器（2026-09-17）。
 *
 * 目的：给外部系统（比如公安人脸库比对程序）一份能直接改改连接信息就跑
 * 的查询示例——不经过控制台/AI微服务，直接连只读 MongoDB 账号读结构化
 * 识别结果 + 截图。纯函数，不碰 DOM/React，方便单测锁死两个最容易踩的坑：
 * - timestamp 是 Unix **秒**级浮点数，不是毫秒（页面内部时间范围是
 *   datetime-local 字符串，调用方按 `new Date(x).getTime()/1000` 换算）。
 * - 集合名是 `snapshots_{通道ID}`，不是通道显示名——ID 和显示名经常不一样
 *   （比如 ID "demo-detect"，显示名"大门口_人脸识别"），这是最容易踩的坑，
 *   生成的每份代码都要把这句话钉在注释里，不能假设读者会自己想到。
 */

export interface ApiExampleParams {
  mongoHost: string
  mongoPort: number
  dbName: string
  readonlyUser: string
  readonlyPassword: string
  channelId: string
  channelName: string
  /** Unix 秒级时间戳（可以带小数），不是毫秒 */
  fromTs: number
  toTs: number
  /** 0~1，0 表示不按置信度过滤 */
  minConfidence: number
}

function fmtTs(ts: number): string {
  return Number.isFinite(ts) ? ts.toFixed(3) : '0'
}

function fmtHuman(ts: number): string {
  if (!Number.isFinite(ts)) return ''
  try {
    return new Date(ts * 1000).toLocaleString('zh-CN')
  } catch {
    return ''
  }
}

export function buildPythonExample(p: ApiExampleParams): string {
  const collection = `snapshots_${p.channelId}`
  const confLine = p.minConfidence > 0
    ? `MIN_CONFIDENCE = ${p.minConfidence.toFixed(4)}      # 置信度下限 0~1，页面上设的是 ${(p.minConfidence * 100).toFixed(0)}%`
    : `MIN_CONFIDENCE = 0.0                 # 0 表示不按置信度过滤（页面上当前也没设下限）`

  return `"""
识别历史只读查询示例——直接连 AI识别历史库只读账号，不经过控制台/AI微服务。
用途：外部系统（如人脸库比对程序）按时间范围拉取识别结果做二次处理。

依赖：pip install pymongo
"""
from pymongo import MongoClient

# ---- 连接信息（只读账号，专门为公开分享而建，可以直接给外部系统用） ----
MONGO_HOST = "${p.mongoHost}"
MONGO_PORT = ${p.mongoPort}
DB_NAME = "${p.dbName}"
READONLY_USER = "${p.readonlyUser}"
READONLY_PASSWORD = "${p.readonlyPassword}"

# ---- 查询参数（取自页面当前选中的通道 + 时间范围，改成你需要的值即可） ----
CHANNEL_ID = "${p.channelId}"        # 通道 ID（不是显示名"${p.channelName}"）
                                       # ⚠️ 集合名固定是 snapshots_{通道ID}，
                                       # 拼错成显示名会查到一个不存在的集合（空结果，不会报错）
FROM_TS = ${fmtTs(p.fromTs)}${fmtHuman(p.fromTs) ? `  # ${fmtHuman(p.fromTs)}` : ''}
TO_TS = ${fmtTs(p.toTs)}${fmtHuman(p.toTs) ? `  # ${fmtHuman(p.toTs)}` : ''}
# ⚠️ 上面两个是 Unix 秒级时间戳（可以带小数），不是毫秒；数据库里 timestamp
# 字段就是秒级——如果你自己拼时间戳，记得除以 1000（常见错误是拿毫秒直接查，
# 会因为数值差 1000 倍导致查不到任何结果）。
${confLine}

uri = f"mongodb://{READONLY_USER}:{READONLY_PASSWORD}@{MONGO_HOST}:{MONGO_PORT}/{DB_NAME}?authSource={DB_NAME}"
client = MongoClient(uri, serverSelectionTimeoutMS=5000)
collection = client[DB_NAME]["${collection}"]

query = {"timestamp": {"$gte": FROM_TS, "$lte": TO_TS}}
if MIN_CONFIDENCE > 0:
    query["confidence"] = {"$gte": MIN_CONFIDENCE}

# 默认不取截图二进制（image.data）——时间范围一长可能是几百 MB，不加这行
# projection 极容易看起来像"卡住"了，其实只是在传大量图片数据。
projection = {"image.data": 0}

for doc in collection.find(query, projection).sort("timestamp", 1):
    print(doc["timestamp"], doc["class_name"], doc["confidence"], doc["bbox"])

client.close()

# ---- 如果需要连截图一起取（数据量会明显变大，按需再打开用） ----
# for doc in collection.find(query).sort("timestamp", 1):
#     image_bytes = doc["image"]["data"]          # bytes，JPEG 原始数据
#     with open(f"{doc['image_id']}.jpg", "wb") as f:
#         f.write(image_bytes)
`
}

export function buildMongoshExample(p: ApiExampleParams): string {
  const collection = `snapshots_${p.channelId}`
  const confClause = p.minConfidence > 0
    ? `, confidence: { $gte: ${p.minConfidence.toFixed(4)} }`
    : ''
  return `# 只读账号连接串（可以直接复制这行去连，账号密码是特意公开分享的）
mongosh "mongodb://${p.readonlyUser}:${p.readonlyPassword}@${p.mongoHost}:${p.mongoPort}/${p.dbName}?authSource=${p.dbName}"

# 连上后在交互界面执行（或整段拼进 --eval 一次性跑）：
# ⚠️ 集合名是 snapshots_{通道ID}，这里的 "${p.channelId}" 是通道 ID，
#    不是显示名"${p.channelName}"；下面 timestamp 是 Unix 秒级，不是毫秒。
db.getCollection("${collection}").find(
  {
    timestamp: { $gte: ${fmtTs(p.fromTs)}, $lte: ${fmtTs(p.toTs)} }${confClause}
  },
  { "image.data": 0 }   // 默认不取截图二进制，数据量大
).sort({ timestamp: 1 })
`
}

export function buildSchemaExample(p: ApiExampleParams): string {
  return `// 一条识别结果记录的字段结构说明（集合 snapshots_${p.channelId}，即
// "${p.channelName}"这个通道；每个 AI 通道各自一个集合，格式完全一样）。
// 这不是严格 JSON（带了注释），照着字段名读就行。
{
  "_id": "68a3f1c2...",                 // MongoDB 内部主键，业务上不用管
  "image_id": "35061f1a-a44b-...",      // 这条记录的唯一标识（uuid）
  "channel_id": "${p.channelId}",       // AI 通道 ID
  "channel_name": "${p.channelName}",   // AI 通道显示名，仅供人看，集合名要用上面的 ID
  "frame_pts_ns": 1687843000000,        // 源视频帧时间戳（纳秒）；同一帧的多个检测框这个值相同
  "timestamp": 1789653328.524,          // Unix 秒级时间戳——不是毫秒，查询按它过滤
  "model_name": "yolo26x-face",         // 推理用的模型名
  "task_type": "face_detection",
  "class_id": 0,
  "class_name": "face",                 // 类别名
  "confidence": 0.4612,                 // 置信度 0~1
  "bbox": { "x": 287.4, "y": 624.0, "w": 46.5, "h": 46.5 },  // 检测框在原图像素坐标系下的位置
  "landmarks": null,                    // 人脸关键点坐标；没开启人脸模型时为 null
  "image": {
    "format": "jpg",
    "width": 256,                       // 裁剪截图宽度（像素）
    "height": 256,
    "data": "<binary>"                  // JPEG 原始字节；不带 projection 查询会一起返回，
                                         // 默认建议排除（{"image.data": 0}），数据量大
  },
  "enhanced": true,                     // 这张截图是否经过人脸增强处理
  "enhance_model": "gpen",              // 增强用的模型（gpen / codeformer），未增强为 null
  "brightness_corrected": true,         // 是否做过亮度校正
  "embedding": null,                    // 人脸特征向量；未开启时为 null
  "embedding_model": null               // 特征向量对应的模型；未开启时为 null
}
`
}
