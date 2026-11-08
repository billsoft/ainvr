import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AiChannelCard } from '@/pages/AiChannels/AiChannelCard'
import type { AiChannel } from '@/types/aiChannel'

describe('tracking continuity and throughput are separate', () => {
  const show = (gap: boolean, meets: boolean) => {
    const channel = {
      id: 'tracking', name: 'Tracking', state: 'running',
      config: { stream: { url: 'rtmp://127.0.0.1/live/test' }, model: { name: 'yolo26x', adapter: 'yolo26_bpu' }, inference_fps: 2, publish: { enabled: false } },
      stats: { inference_fps_actual: 2, source_fps: 30, tracking_capability: { status: 'active', continuity_gap: gap, cadence: { meets_target: meets, measured_fps: 2, minimum_configured_fps: 2 } } },
    } as AiChannel
    render(<AiChannelCard channel={channel} disabled={false} onStart={vi.fn()} onStop={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onViewResult={vi.fn()} onPreview={vi.fn()} />)
  }
  it('reports a cadence warning without claiming that tracking stopped', () => {
    show(false, false)
    expect(screen.getByText(/跟踪持续运行/)).toBeInTheDocument()
    expect(screen.queryByText(/仅检测：/)).not.toBeInTheDocument()
  })
  it('explains that missing crossing evidence is not reconstructed', () => {
    show(true, false)
    expect(screen.getByText(/不补算缺少证据的穿越/)).toBeInTheDocument()
  })
  it('does not warn about healthy continuous observations', () => {
    show(false, true)
    expect(screen.queryByText(/实际检测节奏低于目标|检测画面出现间断/)).not.toBeInTheDocument()
  })
})