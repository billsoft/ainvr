import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AiChannelCard } from '@/pages/AiChannels/AiChannelCard'
import type { AiChannel } from '@/types/aiChannel'

describe('AI input recovery status', () => {
  it('shows a stopped output and actionable capacity message without claiming it is reconnecting', () => {
    const channel = {
      id: 'open', name: '开放词汇', state: 'running',
      config: { stream: { url: 'rtmp://127.0.0.1/live/camera' },
        model: { name: 'locateanything-3b', adapter: 'locateanything_trt' }, inference_fps: 1 / 15,
        publish: { enabled: true, effective_target_url: 'rtmp://127.0.0.1/live/output' } },
      stats: { inference_fps_actual: 1 / 15, source_fps: 30,
        publish: { running: false, reconnecting: false, last_error: '输出缓存容量不足以等待识别结果' } },
    } as AiChannel
    render(<AiChannelCard channel={channel} disabled={false}
      onStart={vi.fn()} onStop={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
      onViewResult={vi.fn()} onPreview={vi.fn()} />)
    expect(screen.getByText(/输出已停止/)).toBeInTheDocument()
    expect(screen.getByText(/缓存超过设备容量/)).toBeInTheDocument()
    expect(screen.queryByText(/重连中|SEI ✓/)).not.toBeInTheDocument()
  })
  it('shows incomplete open vocabulary output while inference remains running', () => {
    const channel = {
      id: 'open', name: '开放词汇', state: 'running',
      config: {
        stream: { url: 'rtmp://127.0.0.1/live/camera' },
        model: { name: 'locateanything-3b', adapter: 'locateanything_trt' },
        inference_fps: 1 / 15,
        publish: { enabled: false },
      },
      stats: {
        inference_fps_actual: 1 / 15,
        inference_fps_target: 1 / 15, source_fps: 30,
        last_error: '本次识别结果未完整生成，已保存有效目标',
        timing: { total: { p95_ms: 3000 } },
      },
    } as AiChannel
    render(<AiChannelCard channel={channel} disabled={false}
      onStart={vi.fn()} onStop={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
      onViewResult={vi.fn()} onPreview={vi.fn()} />)
    expect(screen.getByTestId('ai-card-last-error')).toHaveTextContent('已保存有效目标')
    expect(screen.getByTestId('ai-card-frames')).toHaveTextContent('每 15.0 秒采集')
  })
  it('shows fast open vocabulary request failures while the channel keeps running', () => {
    const channel = {
      id: 'fast', name: '开放词汇高速', state: 'running',
      config: {
        stream: { url: 'rtmp://127.0.0.1/live/camera' },
        model: { name: 'yoloe-26x', adapter: 'yoloe_pt' }, inference_fps: 5,
        publish: { enabled: false },
      },
      stats: { inference_fps_actual: 5, inference_fps_target: 5, source_fps: 30,
        last_error: '本次识别未完成，请查看运行日志', timing: { total: { p95_ms: 90 } } },
    } as AiChannel
    render(<AiChannelCard channel={channel} disabled={false}
      onStart={vi.fn()} onStop={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
      onViewResult={vi.fn()} onPreview={vi.fn()} />)
    expect(screen.getByTestId('ai-card-last-error')).toHaveTextContent('本次识别未完成')
  })
  it('shows source failure and hides old FPS, latency and SEI success while reconnecting', () => {
    const channel = {
      id: 'camera', name: '真实相机', state: 'reconnecting',
      config: {
        stream: { url: 'rtmp://127.0.0.1/live/camera' },
        model: { name: 'yolo26m', adapter: 'yolo26_trt' }, inference_fps: 15,
        publish: { enabled: true, effective_target_url: 'rtmp://127.0.0.1/live/camera_ai' },
      },
      stats: {
        inference_fps_actual: 14.8, last_error: '实际 SPS 无效或截断',
        timing: { total: { p95_ms: 50.6 } },
        publish: { running: true, reconnecting: false },
      },
    } as AiChannel
    render(<AiChannelCard channel={channel} disabled={false}
      onStart={vi.fn()} onStop={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
      onViewResult={vi.fn()} onPreview={vi.fn()} />)
    expect(screen.getByText(/等待视频恢复/)).toBeInTheDocument()
    expect(screen.getByTestId('ai-card-last-error')).toHaveTextContent('实际 SPS 无效或截断')
    expect(screen.getByText(/SEI 等待源视频恢复/)).toBeInTheDocument()
    expect(screen.queryByText(/14\.8|50\.6|SEI ✓/)).not.toBeInTheDocument()
  })
})
