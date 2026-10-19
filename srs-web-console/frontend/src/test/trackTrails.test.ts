import { describe, expect, it } from 'vitest'
import { TrackTrailBuffer } from '@/components/player/trackTrails'
import type { AiDetection } from '@/types/aiChannel'
const box = (id: string, x = 10): AiDetection => ({class_id:0,class_name:'person',confidence:null,track_id:id,bbox:{x,y:10,w:20,h:30}})
describe('display-time trajectory buffer', () => {
  it('uses the box centre and does not duplicate held observations', () => {
    const cache = new TrackTrailBuffer()
    expect(cache.update(0,[box('a')])[0]!.points[0]!).toEqual({x:20,y:25,ptsNs:0})
    expect(cache.update(0,[box('a')])[0]!.points).toHaveLength(1)
    expect(cache.update(1e9,[box('a',20)])[0]!.points).toHaveLength(2)
  })
  it('resets on backwards seek and long discontinuity', () => {
    const cache = new TrackTrailBuffer()
    cache.update(2e9,[box('a')])
    expect(cache.update(1e9,[box('a')])[0]!.points).toHaveLength(1)
    expect(cache.update(20e9,[box('a')])[0]!.points).toHaveLength(1)
  })
  it('clears trails of an earlier tracking session even when time is continuous', () => {
    const cache = new TrackTrailBuffer()
    cache.update(0,[box('chan:inst:1:7')])
    cache.update(1e9,[box('chan:inst:1:7',30)])
    // The service restarted tracking (new session) without a time jump.
    const trails=cache.update(2e9,[box('chan:inst:2:7'),box('')])
    expect(trails.map(t=>t.id)).toEqual(['chan:inst:2:7'])
    expect(trails[0]!.points).toHaveLength(1)
    // A frame without tracked targets does not end the session.
    expect(cache.update(3e9,[box('')]).map(t=>t.id)).toEqual(['chan:inst:2:7'])
  })
  it('keeps several targets of one session and ignores absent identity', () => {
    const cache = new TrackTrailBuffer()
    cache.update(0,[box('chan:inst:1:1'),box('chan:inst:1:2',50)])
    const trails=cache.update(1e9,[box('chan:inst:1:1'),box('chan:inst:1:2',60),box('')])
    expect(trails).toHaveLength(2)
    expect(trails.every(t=>t.points.length===2)).toBe(true)
  })
  it('keeps 30 seconds of history by default, enough points for 10 detections per second', () => {
    const cache = new TrackTrailBuffer()
    let trails = cache.update(0,[box('a')])
    // 10 FPS for 30 s: every observation of the last 30 s stays drawn.
    for (let i = 1; i <= 300; i++) trails = cache.update(i*1e8,[box('a',10+i)])
    expect(trails[0]!.points).toHaveLength(301)
    expect(trails[0]!.points[0]!.ptsNs).toBe(0)
    // Older than 30 s is dropped.
    trails = cache.update(30.5e9,[box('a')])
    expect(trails[0]!.points[0]!.ptsNs).toBeGreaterThanOrEqual(0.5e9)
  })
  it('bounds total tracks and per-track points', () => {
    const cache = new TrackTrailBuffer(10,2,2)
    cache.update(0,[box('a'),box('b'),box('c')])
    expect(cache.update(1e9,[box('c')])).toHaveLength(2)
    expect(cache.update(2e9,[box('c')]).find(t=>t.id==='c')?.points).toHaveLength(2)
  })
  it('expires old tracks, rejects invalid points and supports explicit session clear', () => {
    const cache = new TrackTrailBuffer(1)
    cache.update(0,[box('a')])
    expect(cache.update(2e9,[])).toHaveLength(0)
    expect(cache.update(3e9,[box('b',NaN)])).toHaveLength(0)
    cache.update(4e9,[box('c')]);cache.clear()
    expect(cache.update(5e9,[])).toHaveLength(0)
  })
  it('does not return mutable internal point references', () => {
    const cache = new TrackTrailBuffer()
    cache.update(0,[box('a')])[0]!.points[0]!.x=999
    expect(cache.update(0,[])[0]!.points[0]!.x).toBe(20)
  })
})
