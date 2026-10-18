import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AiResultModal } from '@/pages/AiChannels/AiResultModal'
import type { AiFrameResult } from '@/types/aiChannel'

function show(extra: Record<string, unknown>) {
  const result: AiFrameResult = { schema_version: '1.2', channel_id: 'trial', stream_url: 'rtmp://127.0.0.1/live/xm', stream_protocol: 'rtmp', timestamp: 1, frame_pts_ns: 1,
    model: { name: 'locateanything-3b', format: 'hbm', provider: 'bpu', input_size: [224, 448], end2end: false, version: '1.0' }, task_type: 'open_vocabulary_detection', detections: [], model_extra: extra,
    frame_index: 1, frame_width: 3840, frame_height: 1920, timing_ms: { decode: 0, preprocess: 1605.07, inference: 27976.68, postprocess: .15, total: 29581.9 } }
  render(<AiResultModal channelName="Trial" loading={false} result={result} onClose={vi.fn()} />)
}

describe('point output result summary', () => {
  it('summarizes completed normalized points instead of claiming no target', () => {
    show({ grounding: { complete: true, coordinate_space: 'normalized_full_frame',
      points: [{x: .2, y: .4, class_name: 'person'}, {x: .8, y: .7, class_name: 'person'}] } })
    expect(screen.getByText('定位到 2 个目标点')).toBeInTheDocument()
    expect(screen.queryByText('未检测到目标')).not.toBeInTheDocument()
  })
  it('does not present unfinished points as completed detections', () => {
    show({ grounding: { complete: false, coordinate_space: 'normalized_full_frame', points: [{x: .2, y: .4}] } })
    expect(screen.queryByText(/定位到/)).not.toBeInTheDocument()
  })
  it('preserves empty output behavior for ordinary detectors', () => {
    show({})
    expect(screen.getByText('未检测到目标')).toBeInTheDocument()
  })
})
