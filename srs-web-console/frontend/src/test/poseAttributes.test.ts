import { describe, expect, it, vi } from 'vitest'
import { parseSeiJson } from '@/components/player/seiDetections'
import { parsePoseAttribute } from '@/components/player/poseAttributes'
import { drawDetections } from '@/components/player/detectionDrawing'
import { computeContainLayout } from '@/components/player/overlayGeometry'
import { parseRecordingSei } from '@/pages/Playback/recordingSei'

const pose = () => ({ schema_version:'1.0', type:'keypoints', status:'observed', layout:'coco17',
  coordinate_space:'original_image',image_size:[1920,1080],visibility_threshold:0.5,
  source_model_sha256:'a'.repeat(64),points:Array.from({length:17},(_,i)=>({x:100+i*10,y:200+i*10,score:0.9})) })
const payload = () => ({pts:1000000000,det:[{c:0,n:'person',p:0.9,b:[50,100,400,700],a:{pose:pose()}}]})
describe('pose attribute on live and recorded source frames', () => {
  it('preserves pose separately from face landmarks through both players', () => {
    const live = parseSeiJson(JSON.stringify(payload()))!
    const recorded = parseRecordingSei({frames:[{timeMs:1000,payload:payload()}]})[0]!.result
    expect(recorded.detections).toEqual(live.detections)
    expect(live.detections[0]!.model_extra!.attributes!.pose).toEqual(pose())
    expect(live.detections[0]!.landmarks).toBeUndefined()
  })
  it('rejects incorrect shape, model identity, coordinate space and scores', () => {
    for (const patch of [{points:pose().points.slice(0,5)},{source_model_sha256:''},
      {coordinate_space:'normalized'},{status:'predicted'},{visibility_threshold:0},
      {points:pose().points.map(p=>({...p,score:2}))}]) expect(parsePoseAttribute({...pose(),...patch})).toBeNull()
  })
  it('renders only observed, visible joints on matching image geometry', () => {
    const ctx = Object.fromEntries(['setLineDash','strokeRect','fillRect','fillText','beginPath','moveTo','lineTo','stroke','arc','fill'].map(k=>[k,vi.fn()])) as unknown as CanvasRenderingContext2D
    ctx.measureText=()=>({width:10}) as TextMetrics
    const d=parseSeiJson(JSON.stringify(payload()))!.detections[0]!
    const layout=computeContainLayout(1920,1080,960,540)
    drawDetections(ctx,[d],layout,1920,1080)
    expect(ctx.arc).toHaveBeenCalledTimes(17)
    vi.mocked(ctx.arc).mockClear()
    drawDetections(ctx,[{...d,predicted:true}],layout,1920,1080)
    drawDetections(ctx,[d],layout,1280,720)
    expect(ctx.arc).not.toHaveBeenCalled()
  })
})
