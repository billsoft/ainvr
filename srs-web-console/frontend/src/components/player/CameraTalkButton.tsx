import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, MicOff } from 'lucide-react'
import workletUrl from './talkback-worklet.js?url&no-inline'
import { request } from '@/api/httpClient'

interface Capture {
  cancel: AbortController
  context?: AudioContext
  stream?: MediaStream
  node?: AudioWorkletNode
  watchdog?: ReturnType<typeof setTimeout>
  session?: string
}

let recording: Capture | undefined

function release(capture: Capture) {
  clearTimeout(capture.watchdog)
  capture.cancel.abort()
  capture.stream?.getTracks().forEach(track => track.stop())
  if (capture.node) {
    capture.node.port.onmessage = null
    capture.node.disconnect()
  }
  if (capture.context && capture.context.state !== 'closed') void capture.context.close().catch(() => {})
  if (capture.session) {
    void request('/talkback/' + capture.session, { method: 'DELETE', keepalive: true }).catch(() => {})
    capture.session = undefined
  }
  if (recording === capture) recording = undefined
}

export function CameraTalkButton({ channel }: {channel: string}) {
  const active = useRef<Capture | null>(null)
  const [phase, setPhase] = useState<'idle'|'permission'|'connecting'|'sending'>('idle')
  const [bars, setBars] = useState(0)
  const [error, setError] = useState('')
  const stop = useCallback(() => {
    const c = active.current
    active.current = null
    if (c) release(c)
    setPhase('idle')
    setBars(0)
  }, [])
  useEffect(() => {
    const hide = () => { if (document.hidden) stop() }
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('pagehide', stop)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('pagehide', stop)
      stop()
    }
  }, [channel, stop])
  async function toggle() {
    setError('')
    if (active.current) { stop(); return }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError('使用 HTTPS 或本机 localhost 地址打开控制台后可开启麦克风')
      return
    }
    if (recording) { setError('请先关闭另一路喊话'); return }
    const c: Capture = { cancel: new AbortController() }
    active.current = recording = c
    const current = () => active.current === c
    const fail = (e: unknown) => {
      if (!current()) return
      stop()
      setError(e instanceof DOMException && e.name === 'NotAllowedError' ? '浏览器未允许使用麦克风' :
        e instanceof Error ? e.message : '喊话连接中断')
    }
    try {
      setPhase('permission')
      c.context = new AudioContext()
      const resume = c.context.resume()
      void resume.catch(fail)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      if (!current()) { stream.getTracks().forEach(track => track.stop()); return }
      c.stream = stream
      const track = stream.getAudioTracks()[0]; if (!track) throw new Error('未找到麦克风'); track.onended = () => fail(new Error('麦克风已断开'))
      await resume
      await c.context.audioWorklet.addModule(workletUrl)
      if (!current()) return
      setPhase('connecting')
      const node = new AudioWorkletNode(c.context, 'camera-pcm', { numberOfOutputs: 0 })
      c.node = node
      c.watchdog = setTimeout(() => fail(new Error('未收到麦克风采样，请检查输入设备')), 3500)
      node.onprocessorerror = () => fail(new Error('麦克风采集已中断'))
      let busy = false
      let pending: ArrayBuffer | undefined
      let seq = 0
      const send = async (pcm: ArrayBuffer) => {
        if (busy) { pending = pcm; return }
        busy = true
        try {
          let next: ArrayBuffer | undefined = pcm
          while (next && current() && c.session) {
            await request('/talkback/' + c.session + '/audio/' + seq++, { method:'POST',
              signal: AbortSignal.any([c.cancel.signal, AbortSignal.timeout(2500)]),
              headers:{'Content-Type':'application/octet-stream'}, body:next })
            if (current()) setPhase('sending')
            next = pending
            pending = undefined
          }
        } catch (e) { fail(e) } finally { busy = false }
      }
      node.port.onmessage = ({data}) => {
        if (!current()) return
        clearTimeout(c.watchdog)
        c.watchdog = setTimeout(() => fail(new Error('麦克风停止输出，请重新开启喊话')), 3500)
        const db = 20 * Math.log10(Math.max(data.rms, 0.00001))
        setBars(Math.max(0,Math.min(6,Math.ceil((db+60)/9))))
        if (c.session) void send(data.pcm)
      }
      c.context.createMediaStreamSource(stream).connect(node)
      const result = await request<{session:string}>('/talkback/channels/' + channel, { method:'POST',
        signal:AbortSignal.any([c.cancel.signal,AbortSignal.timeout(16000)]) })
      c.session = result.session
      if (!current()) release(c)
    } catch (e) { fail(e) }
  }
  const label = phase === 'idle' ? '开启麦克风喊话' : '关闭麦克风喊话'
  const message = error || ({idle:'',permission:'等待麦克风授权',connecting:'正在连接摄像头',sending:'正在喊话'}[phase])
  return <div className="flex items-center gap-1 text-xs text-white">
    <button type="button" title={label} aria-label={label} aria-pressed={phase !== 'idle'} onClick={() => void toggle()}
      className={'flex h-8 min-w-8 items-center justify-center rounded-base hover:bg-white/10 ' + (phase === 'sending' ? 'bg-blue-700' : '')}>
      {phase === 'idle' ? <MicOff size={15}/> : <Mic size={15}/>}
    </button>
    {phase !== 'idle' && <span role="meter" aria-label="本地麦克风电平" aria-valuemin={0} aria-valuemax={6} aria-valuenow={bars}
      className="flex h-4 items-end gap-px">{[0,1,2,3,4,5].map(i => <i key={i}
        className={i < bars ? 'bg-emerald-400' : 'bg-slate-600'} style={{width:3,height:4+i*2}}/>)}</span>}
    <span role="status" className={error ? 'max-w-52 text-amber-200' : 'text-slate-300'}>{message}</span>
  </div>
}
