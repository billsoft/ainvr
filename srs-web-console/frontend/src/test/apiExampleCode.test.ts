import { describe, expect, it } from 'vitest'
import { buildMongoshExample, buildPythonExample, buildSchemaExample, type ApiExampleParams } from '@/pages/RecognitionHistory/apiExampleCode'

const BASE: ApiExampleParams = {
  mongoHost: '192.168.100.183',
  mongoPort: 27017,
  dbName: 'ai_snapshots',
  readonlyUser: 'ai_snapshots_readonly',
  readonlyPassword: 'c537b1fe2dba0fe0f4c8886e',
  channelId: 'demo-detect',
  channelName: '大门口_人脸识别',
  fromTs: 1789654920.123,
  toTs: 1789655520.456,
  minConfidence: 0,
}

describe('检测接口示例代码生成 · 集合名规则（最容易踩的坑）', () => {
  it('Python 示例里集合名是 snapshots_{通道ID}，不是显示名', () => {
    const code = buildPythonExample(BASE)
    expect(code).toContain('snapshots_demo-detect')
    expect(code).not.toContain('snapshots_大门口_人脸识别')
  })

  it('mongosh 示例同样用通道 ID 拼集合名', () => {
    const code = buildMongoshExample(BASE)
    expect(code).toContain('snapshots_demo-detect')
  })

  it('两份代码都显式提醒"不是显示名"，不能指望读者自己想到', () => {
    expect(buildPythonExample(BASE)).toContain('不是显示名')
    expect(buildMongoshExample(BASE)).toContain('不是显示名')
  })
})

describe('检测接口示例代码生成 · 时间戳是秒不是毫秒', () => {
  it('Python 示例按原样写入秒级时间戳，并有换算提醒', () => {
    const code = buildPythonExample(BASE)
    expect(code).toContain('FROM_TS = 1789654920.123')
    expect(code).toContain('TO_TS = 1789655520.456')
    expect(code).toContain('不是毫秒')
  })

  it('mongosh 示例同样写秒级时间戳', () => {
    const code = buildMongoshExample(BASE)
    expect(code).toContain('1789654920.123')
    expect(code).toContain('1789655520.456')
  })
})

describe('检测接口示例代码生成 · 连接信息与置信度', () => {
  it('Python 示例带上真实只读账号密码和地址', () => {
    const code = buildPythonExample(BASE)
    expect(code).toContain('MONGO_HOST = "192.168.100.183"')
    expect(code).toContain('MONGO_PORT = 27017')
    expect(code).toContain('READONLY_USER = "ai_snapshots_readonly"')
    expect(code).toContain('READONLY_PASSWORD = "c537b1fe2dba0fe0f4c8886e"')
  })

  it('minConfidence=0 时不生成置信度过滤条件', () => {
    const code = buildPythonExample(BASE)
    expect(code).toContain('MIN_CONFIDENCE = 0.0')
    const mongosh = buildMongoshExample(BASE)
    expect(mongosh).not.toContain('confidence')
  })

  it('minConfidence>0 时两份代码都带上过滤条件', () => {
    const withConf = { ...BASE, minConfidence: 0.6 }
    expect(buildPythonExample(withConf)).toContain('MIN_CONFIDENCE = 0.6000')
    expect(buildMongoshExample(withConf)).toContain('confidence: { $gte: 0.6000 }')
  })

  it('默认排除截图二进制字段，避免"查一天数据像卡住"', () => {
    expect(buildPythonExample(BASE)).toContain('"image.data": 0')
    expect(buildMongoshExample(BASE)).toContain('"image.data": 0')
  })
})

describe('检测接口示例代码生成 · 结果字段说明', () => {
  it('覆盖真实 schema 的关键字段，不是随手写的示例', () => {
    const schema = buildSchemaExample(BASE)
    for (const field of [
      'image_id', 'channel_id', 'channel_name', 'frame_pts_ns', 'timestamp',
      'confidence', 'bbox', 'landmarks', 'enhanced', 'enhance_model', 'embedding',
    ]) {
      expect(schema).toContain(`"${field}"`)
    }
  })

  it('明确标注 timestamp 是秒级、image.data 建议排除', () => {
    const schema = buildSchemaExample(BASE)
    expect(schema).toContain('不是毫秒')
    expect(schema.toLowerCase()).toContain('image.data')
  })
})
