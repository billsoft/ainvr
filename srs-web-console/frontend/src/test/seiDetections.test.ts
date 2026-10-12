import { describe, expect, it } from 'vitest'
import {
  extractSeiDetections, findSeiJson, inspectSeiDetections, parseSeiJson, SeiFrameCache, SEI_UUID,
} from '@/components/player/seiDetections'

/** 造一段"带 SEI 的编码帧"：前后各垫一些非 SEI 字节，中间是
 *  [NAL头][payload类型/长度][UUID][JSON]，模拟真实码流里 UUID 不在开头。 */
function frameWithSei(json: string, opts: { prefix?: number[]; suffix?: number[] } = {}) {
  const enc = new TextEncoder().encode(json)
  const prefix = opts.prefix ?? [0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x00, 0x00, 0x00, 0x01, 0x06, 0x05, 0x40]
  const suffix = opts.suffix ?? [0x80, 0x00, 0x00, 0x01, 0x41, 0x9a]
  const out = new Uint8Array(prefix.length + SEI_UUID.length + enc.length + suffix.length)
  out.set(prefix, 0)
  out.set(SEI_UUID, prefix.length)
  out.set(enc, prefix.length + SEI_UUID.length)
  out.set(suffix, prefix.length + SEI_UUID.length + enc.length)
  return out
}

// 生产实采样本（2026-09-17 无头 chromium 从真实衍生流的编码帧里抓到的原文）
const REAL_PAYLOAD =
  '{"v":1,"ch":"demo-detect","pts":8304976000000,"age_ms":48.3,' +
  '"det":[{"c":0,"n":"face","p":0.7163,"b":[1058.2,574.1,74.2,74.2]},' +
  '{"c":0,"n":"face","p":0.5869,"b":[452.6,715.5,42,42]}]}'

describe('findSeiJson —— 从编码帧字节里定位 SEI 载荷', () => {
  it('parses an escaped NAL captured after the original publisher and real SRS', () => {
    const hex = '06056241494e56522d5345492d763100000300017b2276223a312c226368223a2261696e76722d7365692d7472616e73706f72742d746573742d31343635333530222c22707473223a36363030303030302c226167655f6d73223a302c22646574223a5b5d7d80'
    const bytes = new Uint8Array(hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16)))
    expect(inspectSeiDetections(bytes)).toEqual({
      present: true, result: { ptsNs: 66_000_000, ageMs: 0, detections: [] },
    })
  })
  it('distinguishes a truncated escaped SEI from a frame with no metadata', () => {
    const escapedUuid = [ ...SEI_UUID.slice(0, 12), 0, 0, 3, 0, 1 ]
    const truncated = new Uint8Array([0x06, ...escapedUuid, ...new TextEncoder().encode('{"det":[')])
    expect(inspectSeiDetections(truncated)).toEqual({ present: true, result: null })
    const corrupted = new Uint8Array([ ...SEI_UUID.slice(0, 12), 0, 0, 3, 4, 1, ...new TextEncoder().encode('{"det":[]}') ])
    expect(inspectSeiDetections(corrupted)).toEqual({ present: false, result: null })
  })
  it('uses the 16-byte AINVR protocol identifier', () => {
    expect(Array.from(SEI_UUID)).toEqual([
      ...new TextEncoder().encode('AINVR-SEI-v1'), 0, 0, 0, 1,
    ])
  })
  it('distinguishes absent, truncated and explicit empty inference metadata', () => {
    expect(inspectSeiDetections(new Uint8Array([1, 2, 3]))).toEqual({ present: false, result: null })
    expect(inspectSeiDetections(frameWithSei('{"det":['))).toEqual({ present: true, result: null })
    expect(inspectSeiDetections(frameWithSei('{"det":[]}'))).toMatchObject({ present: true, result: { detections: [] } })
  })
  it('does not treat escaped quotes or braces in labels as JSON structure', () => {
    const payload = JSON.stringify({ det: [{ n: 'face } \\" {', b: [1, 2, 3, 4] }] })
    expect(findSeiJson(frameWithSei(payload))).toBe(payload)
  })
  it('能从夹在码流中间的 SEI 里取出完整 JSON', () => {
    expect(findSeiJson(frameWithSei(REAL_PAYLOAD))).toBe(REAL_PAYLOAD)
  })

  it('没有 SEI 的帧返回 null（正常情况：没有结果可注的帧不打 SEI）', () => {
    const plain = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x12, 0x34])
    expect(findSeiJson(plain)).toBeNull()
  })

  it('UUID 只匹配上一部分时不误判', () => {
    const partial = new Uint8Array([...SEI_UUID.slice(0, 10), 0x11, 0x22, 0x33])
    expect(findSeiJson(partial)).toBeNull()
  })

  it('JSON 里嵌套对象时花括号配对正确，不会在第一个 } 就截断', () => {
    const nested = '{"v":1,"meta":{"a":{"b":2}},"det":[]}'
    expect(findSeiJson(frameWithSei(nested))).toBe(nested)
  })

  it('UUID 之后的 JSON 被截断（花括号没配平）时返回 null，不抛错', () => {
    const truncated = new Uint8Array([
      ...SEI_UUID, ...new TextEncoder().encode('{"v":1,"det":['),
    ])
    expect(findSeiJson(truncated)).toBeNull()
  })
})

describe('parseSeiJson —— 紧凑编码还原成可画的检测', () => {
  it('还原生产实采样本的全部字段', () => {
    const r = parseSeiJson(REAL_PAYLOAD)!
    expect(r.ptsNs).toBe(8304976000000)
    expect(r.ageMs).toBeCloseTo(48.3, 3)
    expect(r.detections).toHaveLength(2)
    expect(r.detections[0]).toEqual({
      class_id: 0, class_name: 'face', confidence: 0.7163,
      bbox: { x: 1058.2, y: 574.1, w: 74.2, h: 74.2 },
    })
  })

  it('带关键点（人脸 5 点）时还原成 {x,y} 数组', () => {
    const r = parseSeiJson(
      '{"v":1,"pts":1,"age_ms":0,"det":[{"c":0,"n":"face","p":0.9,' +
      '"b":[10,20,30,40],"k":[[11,21],[12,22],[13,23],[14,24],[15,25]]}]}',
    )!
    expect(r.detections[0]!.landmarks).toEqual([
      { x: 11, y: 21 }, { x: 12, y: 22 }, { x: 13, y: 23 },
      { x: 14, y: 24 }, { x: 15, y: 25 },
    ])
  })

  it('没有关键点的模型不产出 landmarks 字段（不是空数组——语义不同）', () => {
    const r = parseSeiJson('{"v":1,"pts":1,"age_ms":0,"det":[{"c":1,"n":"person","p":0.8,"b":[1,2,3,4]}]}')!
    expect(r.detections[0]!.landmarks).toBeUndefined()
  })

  it('det 为空数组时返回空检测列表，而不是 null——"这一帧确实没检测到目标"', () => {
    const r = parseSeiJson('{"v":1,"pts":7,"age_ms":3,"det":[]}')!
    expect(r.detections).toEqual([])
    expect(r.ptsNs).toBe(7)
  })

  it('坏掉的单条检测被跳过，其余照常还原——一个坏包不该让整层崩掉', () => {
    const r = parseSeiJson(
      '{"v":1,"pts":1,"age_ms":0,"det":[{"c":0,"n":"face","p":0.9,"b":[1,2]},' +
      '{"c":0,"n":"face","p":0.8,"b":[10,20,30,40]}]}',
    )!
    expect(r.detections).toHaveLength(1)
    expect(r.detections[0]!.bbox).toEqual({ x: 10, y: 20, w: 30, h: 40 })
  })

  it('整条 JSON 非法时返回 null 而不是抛错', () => {
    expect(parseSeiJson('{not json')).toBeNull()
  })
})

describe('extractSeiDetections —— 端到端', () => {
  it('从完整编码帧直出检测结果', () => {
    const r = extractSeiDetections(frameWithSei(REAL_PAYLOAD))!
    expect(r.detections).toHaveLength(2)
    expect(r.ptsNs).toBe(8304976000000)
  })

  it('无 SEI 的帧返回 null', () => {
    expect(extractSeiDetections(new Uint8Array([1, 2, 3, 4]))).toBeNull()
  })
})

describe('SeiFrameCache —— 收到帧与显示帧之间的缓冲', () => {
  const mk = (n: number) => ({ ptsNs: n, ageMs: 0, detections: [] })

  it('按 rtpTimestamp 取回对应帧的结果', () => {
    const c = new SeiFrameCache(10)
    c.put(3000, mk(1))
    c.put(6000, mk(2))
    expect(c.getForDisplay(3000)!.ptsNs).toBe(1)
    expect(c.getForDisplay(6000)!.ptsNs).toBe(2)
  })

  it('查不到的时间戳返回 null（不能瞎给最新的——那等于框又绑回收到的帧）', () => {
    const c = new SeiFrameCache(10)
    c.put(3000, mk(1))
    expect(c.getForDisplay(30001)).toBeNull()
  })

  it('必须能存一整段而不是只留最新一条：解码+抖动缓冲期间收到的帧要全留着', () => {
    const c = new SeiFrameCache(300)
    for (let i = 0; i < 300; i++) c.put(i * 3000, mk(i))
    // 300 帧 @30fps = 10s，远大于实测的百毫秒级抖动缓冲
    expect(c.getForDisplay(0)!.ptsNs).toBe(0)
    expect(c.getForDisplay(299 * 3000)!.ptsNs).toBe(299)
    expect(c.size).toBe(300)
  })

  it('超容量时淘汰最老的，内存有界', () => {
    const c = new SeiFrameCache(3)
    c.put(1, mk(1)); c.put(2, mk(2)); c.put(3, mk(3)); c.put(4, mk(4))
    expect(c.size).toBe(3)
    expect(c.getForDisplay(1)).toBeNull()
    expect(c.getForDisplay(4)!.ptsNs).toBe(4)
  })

  it('重复写同一个时间戳不会把容量算重，也不会提前淘汰别人', () => {
    const c = new SeiFrameCache(2)
    c.put(1, mk(1)); c.put(1, mk(11)); c.put(2, mk(2))
    expect(c.size).toBe(2)
    expect(c.getForDisplay(1)!.ptsNs).toBe(11)
    expect(c.getForDisplay(2)!.ptsNs).toBe(2)
  })

  it('clear 清空——播放器会话重建时旧会话的帧必须丢掉', () => {
    const c = new SeiFrameCache(10)
    c.put(1, mk(1))
    c.clear()
    expect(c.size).toBe(0)
    expect(c.getForDisplay(1)).toBeNull()
  })
})
