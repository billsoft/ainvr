import { RecordingToolbar } from './RecordingToolbar'
import { Download, Play } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RecordingSegment, RecorderChannelKind, VideoCodec } from '@/types/recording'
import { buildSnapshotFilename } from '@/utils/recording'
import { toast } from '@/store/toast'
import { canPlayHevcFile, formatCodec, getCodecSupport, hevcLevelIdc } from '@/utils/codec'
import { PanoramaView } from '@/components/player/PanoramaView'
import { usePlayerView } from '@/components/player/PlayerViewControls'
import { RecordingDetectionOverlay } from './RecordingDetectionOverlay'

const SKIP_SECONDS = 10

/** 标题透明层需要的通道元信息（由页面传入，播放器只管渲染） */
export interface PlayerChannelMeta {
  kind?: RecorderChannelKind
  recording?: boolean
  recordingState?: string
  recordingDetail?: string
  codec?: VideoCodec | null
  width?: number | null
  height?: number | null
  fps?: number | null
  hasAudio?: boolean | null
  seiPresent?: boolean
}

interface Props {
  channelName: string
  /** 顶部透明标题层的通道元信息（编解码/分辨率/录制状态等） */
  channelMeta?: PlayerChannelMeta
  segment: RecordingSegment | null
  checking?: boolean
  /** 段内起播偏移 ms（点击时间轴跨段 seek 时非 0） */
  offsetMs: number
  playUrl: string | null
  downloadUrl: string | null
  /** 是否显示"跳到现在"（仅查看今天时有意义） */
  isToday?: boolean
  onJumpNow?(): void
  /** 绝对时间戳（段起始 + video.currentTime） */
  onTimeUpdate?(absTs: number): void
  /** 播放自然结束：页面决定是否续播下一段 */
  onNext?(): void
  onSeek?(absTs: number): void
  seekVersion?: number
  playbackRange?: { from: number; to: number }
  onError?(): void
  onRetry?(): void
}

/**
 * 录像播放器（YouTube 风格，2026-09-14 按用户要求改版）：原生 <video> 播 MP4（HTTP Range）。
 *  - 视频铺满整个播放器区域（object-contain 不裁剪）——源视频 3840×1920 (2:1)，
 *    套 16:9 盒子会出现双重黑边（左右+上下），即用户反馈的"窄条视频左右空白"
 *  - 通道标题/元信息合并为顶部透明渐变层，控制条悬浮底部（渐变透明）：
 *    细进度条 hover 变粗可拖拽、播放/暂停、绝对时钟/段长、
 *    右下角倍速菜单（点击弹出）、抓拍、下载、音量、全屏
 *  - 点击画面任意处暂停/播放；键盘：空格、←→ ±10s、↑↓ 音量、F 全屏
 *  - 跨段衔接由页面控制（换 src），这里只管单段
 */
export function RecordingPlayer({
  channelName, channelMeta, segment, offsetMs, playUrl, downloadUrl,
  isToday, onJumpNow, onTimeUpdate, onNext, onSeek, seekVersion, onError, onRetry, playbackRange, checking = false,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const progressRef = useRef<HTMLDivElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const view = usePlayerView(wrapperRef)
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const receiveVideo = useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video
    setVideoEl(video)
  }, [])
  const { toggleFullscreen } = view
  const speedMenuRef = useRef<HTMLDivElement>(null)
  const stopDragRef = useRef<(() => void) | null>(null)
  useEffect(() => () => { stopDragRef.current?.() }, [])

  const [speed, setSpeed] = useState(1)
  const [showDetections, setShowDetections] = useState(true)
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [error, setError] = useState(false)
  const [absTs, setAbsTs] = useState<number | null>(null)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  /**
   * 期望落位的段内秒数。跨段/段内 seek 后，部分 MP4（尤其走 HTTP Range 的
   * 远端文件）不会立刻跳到目标，autoplay 先从 0 触发 timeupdate——旧逻辑把
   * 这个瞬间上报给页面，时间轴指针会"啪"地弹回段首。确认 seek 落地前，
   * 定位未完成时不发布假进度，确认实际落位后才上报媒体时钟。
   */
  const pendingSeekRef = useRef<number | null>(null)
  /**
   * 每次换段（新 <video> 挂载，含分段自然播完 onEnded→onNext 的自动续播）：
   * 新元素要重新拉取/缓冲，浏览器展示任何一帧之前有个天然的黑屏间隙；
   * 若这次换段还带非零初始偏移（时间轴段内点击/拖拽命中），还会先从第 0
   * 帧起播、等 apply()（见下一个 effect）把 currentTime 跳到目标位置——
   * 画面上就是"先闪一下段头，再突然黑一下跳到目标位置"。两种情况用户
   * 感知都是"加载了两次/黑屏一下"。用一层遮罩盖住这段过渡：偏移非零时
   * 等 seeked 事件确认落地才揭开；偏移为零（含自动续播下一段）时等原生
   * playing 事件（真正开始出画面）就可以揭开，外加超时兜底。
   */
  const [seekVeil, setSeekVeil] = useState(false)

  /**
   * 用户手动暂停意图：点击控制条按钮/画面/空格暂停时置 true，与"页面切到
   * 后台被自动暂停"区分开——恢复可见时只有后者会自动续播，人工暂停保持。
   */
  const manualPausedRef = useRef(false)
  /**
   * 页面 hidden（最小化/切标签页/切工作区）期间，浏览器会节流甚至暂停媒体，
   * NAS 上长时间静默的 HTTP 连接还可能直接演变成媒体 error。与其放任后台
   * 播放听天由命，hidden 时若仍在播放就主动暂停并标记，visible 时自动续播。
   */
  const wantResumeRef = useRef(false)
  /** 可见性变化期间的最新 checking（effect 闭包拿不到最新 prop） */
  const checkingRef = useRef(checking)
  checkingRef.current = checking
  /** 因页面隐藏而自动暂停：显示轻量提示（非错误遮罩），恢复后自动消失 */
  const [hidePaused, setHidePaused] = useState(false)

  useEffect(() => {
    if (checking) { videoRef.current?.pause(); setError(false) }
  }, [checking])

  // 换段：重置错误态与倍速、时钟落到段起始+初始偏移
  useEffect(() => {
    pendingSeekRef.current = null
    setError(false)
    setPlaying(false)
    setSpeedMenuOpen(false)
    // 新段默认自动起播，手动暂停/隐藏暂停标记都不带入新段
    manualPausedRef.current = false
    wantResumeRef.current = false
    setHidePaused(false)
    setAbsTs(segment ? segment.startTs + offsetMs : null)
    setDuration(0)
    setCurrentTime(0)
    setBuffered(0)
    setSeekVeil(!!segment)
    if (!segment) return
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment?.id, playUrl])

  // ---------- 页面可见性：后台主动暂停、回前台自动续播 ----------
  useEffect(() => {
    function onVisibilityChange() {
      const v = videoRef.current
      if (!v || !segment) return
      if (document.visibilityState === 'hidden') {
        // 只有"本来在播放、且不是用户手动暂停"时才托管：主动暂停，避免
        // 后台媒体节流/NAS 静默断连演变成 error；时间轴指针由页面保留。
        if (!v.paused && !manualPausedRef.current) {
          wantResumeRef.current = true
          setHidePaused(true)
          v.pause()
        }
      } else if (document.visibilityState === 'visible') {
        if (!wantResumeRef.current) return
        wantResumeRef.current = false
        // 隐藏期间用户手动暂停过，或正在重新确认文件：不自动起播
        if (manualPausedRef.current || checkingRef.current) { setHidePaused(false); return }
        void v.play().then(
          () => setHidePaused(false),
          // 浏览器拒绝自动播放（无用户激活等极端情况）：保持暂停，不显示
          // 错误遮罩，让用户点一下"继续播放"即可
          () => { manualPausedRef.current = true },
        )
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [segment?.id, playUrl])

  /** 用户主动暂停（按钮/画面/空格）：恢复可见时不自动续播 */
  function userPause() {
    const v = videoRef.current
    if (!v) return
    manualPausedRef.current = true
    wantResumeRef.current = false
    setHidePaused(false)
    v.pause()
  }
  /** 用户主动播放 */
  function userPlay() {
    const v = videoRef.current
    if (!v) return
    manualPausedRef.current = false
    void v.play().catch(() => { setError(true); onError?.() })
  }

  useEffect(() => {
    const v = videoRef.current
    if (!v || !segment) return
    const target = Math.max(0, offsetMs / 1000)
    pendingSeekRef.current = target
    setSeekVeil(true)
    setError(false)
    const timeoutId = window.setTimeout(() => {
      if (pendingSeekRef.current != null) {
        v.pause(); setError(true); setSeekVeil(false); onError?.()
      }
    }, 15000)
    if (v.error) v.load()
    const apply = () => {
      if (pendingSeekRef.current == null) return
      // duration 已知时不能越过段尾（极端边缘点击），留 50ms 余量
      const max = Number.isFinite(v.duration) && v.duration > 0 ? Math.max(0, v.duration - 0.05) : target
      const wanted = Math.min(target, max)
      pendingSeekRef.current = wanted
      if (Math.abs(v.currentTime - wanted) > 0.3) {
        try { v.currentTime = wanted } catch { /* 个别浏览器在 HAVE_NOTHING 赋值会抛，等 canplay 再来 */ }
      }
      setAbsTs(segment.startTs + wanted * 1000)
      void v.play().catch(() => { /* Autoplay may require an explicit play click. */ })
    }
    // 同段内拖动时间轴时元数据早已加载，直接 seek；换段则等 metadata，
    // canplay 再兜底一次（部分 MP4 在 loadedmetadata 时赋值会被重置到 0）
    if (v.readyState > 0) apply()
    v.addEventListener('loadedmetadata', apply)
    v.addEventListener('canplay', apply)
    return () => {
      window.clearTimeout(timeoutId)
      v.removeEventListener('loadedmetadata', apply)
      v.removeEventListener('canplay', apply)
    }
    // A refreshed index creates new segment objects. It must never re-seek a
    // playing video to the original offset every polling cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segment?.id, playUrl, offsetMs, seekVersion])

  useEffect(() => {
    const v = videoRef.current
    if (v) v.playbackRate = speed
  }, [speed, playUrl])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.volume = volume
    v.muted = muted
  }, [volume, muted, playUrl])

  // 点击倍速菜单外部时关闭（YouTube 同款交互）
  useEffect(() => {
    if (!speedMenuOpen) return
    function onDocMouseDown(e: MouseEvent) {
      if (speedMenuRef.current && !speedMenuRef.current.contains(e.target as Node)) {
        setSpeedMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [speedMenuOpen])

  // ---------- 快捷键 ----------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (checking) return
      // 输入框/弹窗中不响应
      const target = e.target as HTMLElement
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      // 有 modal 打开时不响应
      if (document.querySelector('[role="dialog"]')) return

      if (e.key === 'Escape') { setSpeedMenuOpen(false); return }

      const v = videoRef.current
      if (!v || !segment) return

      switch (e.key) {
        case ' ':
        case 'Spacebar':
          e.preventDefault()
          if (playing) userPause()
          else userPlay()
          break
        case 'ArrowLeft':
          e.preventDefault()
          skipBy(-SKIP_SECONDS)
          break
        case 'ArrowRight':
          e.preventDefault()
          skipBy(SKIP_SECONDS)
          break
        case 'ArrowUp':
          e.preventDefault()
          setVolume((vol) => Math.min(1, vol + 0.1))
          setMuted(false)
          break
        case 'ArrowDown':
          e.preventDefault()
          setVolume((vol) => Math.max(0, vol - 0.1))
          break
        case 'f':
        case 'F':
          e.preventDefault()
          toggleFullscreen()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [playing, segment, checking])

  function handleTimeUpdate() {
    if (checking) return
    const v = videoRef.current
    if (!v || !segment) return
    if (v.seeking) return
    const pending = pendingSeekRef.current
    if (pending != null && Math.abs(v.currentTime - pending) > 0.6) {
      // Do not publish a requested time as if it were a decoded frame.
      return
    }
    if (pending != null) pendingSeekRef.current = null
    setSeekVeil(false)
    if (playbackRange && segment.startTs + v.currentTime * 1000 >= playbackRange.to) {
      v.pause()
      const end = Math.max(0, (playbackRange.to - segment.startTs - 1) / 1000)
      if (v.currentTime > end) v.currentTime = end
    }
    setCurrentTime(v.currentTime)
    const ts = segment.startTs + v.currentTime * 1000
    setAbsTs(ts)
    onTimeUpdate?.(ts)
  }

  /** 浏览器确认一次寻址：落位到请求值附近就解除 pending */
  function handleSeeked() {
    if (checking) return
    const v = videoRef.current
    if (!v || !segment) return
    const pending = pendingSeekRef.current
    if (pending != null && Math.abs(v.currentTime - pending) > 0.6) return
    if (pending != null && Math.abs(v.currentTime - pending) <= 0.6) {
      pendingSeekRef.current = null
    }
    setSeekVeil(false)
    const ts = segment.startTs + v.currentTime * 1000
    setCurrentTime(v.currentTime)
    setAbsTs(ts)
    onTimeUpdate?.(ts)
  }

  function handleLoadedMetadata() {
    const v = videoRef.current
    if (!v) return
    setDuration(v.duration || 0)
  }

  /** 原生 playing 事件（真正开始出画面）：没有待落位的段内偏移时直接揭开
   *  遮罩；若还在等 apply() 把 currentTime 跳到目标偏移，须等 handleSeeked
   *  确认落地才能揭开，否则会在跳转前提前露出错误帧（frame 0）。 */
  function handlePlaying() {
    if (checking) { videoRef.current?.pause(); return }
    setError(false)
    setHidePaused(false)
    wantResumeRef.current = false
    const pending = pendingSeekRef.current
    if (pending == null || Math.abs((videoRef.current?.currentTime ?? 0) - pending) <= 0.6) {
      pendingSeekRef.current = null
      setSeekVeil(false)
    }
  }

  function handleProgress() {
    const v = videoRef.current
    if (!v || !v.buffered || v.buffered.length === 0 || !v.duration) return
    // 取最后一个缓冲段的结束位置
    const end = v.buffered.end(v.buffered.length - 1)
    setBuffered(end)
  }

  function skipBy(seconds: number) {
    const v = videoRef.current
    if (!v || !segment) return
    const next = Math.max(0, Math.min(v.duration || 0, v.currentTime + seconds))
    if (!onSeek) v.currentTime = next
    const ts = segment.startTs + next * 1000
    onSeek?.(ts)
  }

  function seekFromClientX(clientX: number, commit = true) {
    const track = progressRef.current
    const v = videoRef.current
    if (!track || !v || !segment || duration <= 0) return
    const rect = track.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const sec = frac * duration
    if (commit && !onSeek) v.currentTime = sec
    const ts = segment.startTs + sec * 1000
    if (!commit) setHoverTime(sec)
    if (commit) onSeek?.(ts)
  }

  function onProgressMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (!segment || duration <= 0) return
    setDragging(true)
    stopDragRef.current?.()
    seekFromClientX(e.clientX, false)
    function onMove(ev: MouseEvent) { seekFromClientX(ev.clientX, false) }
    function onUp(ev: MouseEvent) {
      seekFromClientX(ev.clientX)
      setDragging(false)
      setHoverTime(null)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      stopDragRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    stopDragRef.current = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }

  function onProgressMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const track = progressRef.current
    if (!track || !segment || duration <= 0) return
    const rect = track.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    setHoverTime(frac * duration)
  }

  function snapshot() {
    const v = videoRef.current
    if (!v || !segment || v.readyState < 2) {
      toast.error('画面还没准备好，稍后再试')
      return
    }
    try {
      const canvas = document.createElement('canvas')
      canvas.width = v.videoWidth
      canvas.height = v.videoHeight
      canvas.getContext('2d')?.drawImage(v, 0, 0)
      const a = document.createElement('a')
      a.href = canvas.toDataURL('image/jpeg', 0.92)
      a.download = buildSnapshotFilename(channelName, absTs ?? Date.now())
      a.click()
      toast.success('已保存抓拍')
    } catch {
      toast.error('抓拍失败（可能是跨域视频）')
    }
  }

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0
  const bufferedPct = duration > 0 ? (buffered / duration) * 100 : 0
  const hoverPct = hoverTime != null && duration > 0 ? (hoverTime / duration) * 100 : null


  return (
    <div
      ref={wrapperRef}
      className="relative aspect-video max-h-full w-full overflow-hidden rounded-panel border border-line bg-black"
      data-testid="recording-player"
    >
      {/* 视频层：16:9 画布内 object-contain，非 16:9 源自动加黑边 */}
      <div className="relative h-full w-full">
        {segment && segment.codec === 'h265'
          && !canPlayHevcFile(getCodecSupport(), hevcLevelIdc({ width: segment.width, height: segment.height })) ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-white/80"
            data-testid="recording-codec-unsupported">
            <p className="font-medium">此设备无法播放 H.265 录像</p>
            <p className="text-xs text-white/60">
              {segment.width && segment.height ? `本段为 H.265 ${segment.width}×${segment.height}；` : '本段为 H.265；'}
              需要 H.265 硬件解码（iPad/Safari，或开启硬件解码的 Chrome/Edge）。可下载后用本机播放器观看。
            </p>
            {downloadUrl && (
              <a href={downloadUrl} className="mt-1 inline-flex items-center gap-1 rounded-base border border-white/30 px-3 py-1.5 text-xs text-white hover:bg-white/10">
                <Download size={12} aria-hidden /> 下载此段
              </a>
            )}
          </div>
        ) : segment && playUrl ? (
          <video
            ref={receiveVideo}
            key={`video:${playUrl}`}
            src={playUrl}
            className="h-full w-full object-contain"
            autoPlay
            playsInline
            preload="metadata"
            onTimeUpdate={handleTimeUpdate}
            onSeeked={handleSeeked}
            onLoadedMetadata={handleLoadedMetadata}
            onProgress={handleProgress}
            onPlay={() => setPlaying(true)}
            onPlaying={handlePlaying}
            onPause={() => setPlaying(false)}
            onEnded={() => onNext?.()}
            onError={() => { setError(true); setSeekVeil(false); onError?.() }}
            onClick={() => {
              if (playing) userPause()
              else userPlay()
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-white/60">
            选择时间轴上的录像开始回看
          </div>
        )}
        {view.panorama && videoEl && !error && <PanoramaView video={videoEl}
          onError={view.panoramaFailed} resetToken={view.panoramaReset} onCamera={view.receivePanoramaCamera} />}
        {segment && playUrl && !error && (segment.seiPresent || channelMeta?.kind === 'ai') && (
          <RecordingDetectionOverlay key={`overlay:${playUrl}`} videoRef={videoRef} segmentId={segment.id} currentTime={currentTime} enabled={showDetections} drawFrame={view.panorama ? view.drawPanoramaFrame : undefined} />
        )}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-center text-sm text-white/80">
            <p className="font-medium">录像加载失败</p>
            <p className="text-xs text-white/50">
              {segment?.playable === false ? '文件不存在或存储位置不可达' : '文件可能已循环覆盖，或读取暂时失败；正在核对列表。'}
            </p>
            {onRetry && <button className="rounded border border-white/40 px-3 py-1.5 text-white" onClick={onRetry}>重新加载录像</button>}
          </div>
        )}
        {/* 段内起播偏移落地前的遮罩：盖住"先闪段头、再跳到目标位置"的过渡帧，
            仅在落位后揭开；超时显示可重试错误，不露出错误帧。 */}
        {(checking || seekVeil) && !error && (
          <div className="absolute inset-0 z-[1] flex items-center justify-center bg-black text-sm text-white/60" data-testid="recording-player-seek-veil">{checking ? '正在确认录像文件…' : '正在定位录像…'}</div>
        )}
        {/* 页面切到后台时的自动暂停提示：不是错误，回前台一般会自动续播并
            立即消失；仅当浏览器拒绝自动起播时停留，用户点一下即可继续。
            人工暂停不显示此遮罩，以此区分两种暂停。 */}
        {hidePaused && !error && !(checking || seekVeil) && (
          <div className="absolute inset-0 z-[2] flex flex-col items-center justify-center gap-3 bg-black/55 text-center" data-testid="recording-player-hide-paused">
            <p className="text-sm text-white/85">页面切到后台时已暂停播放</p>
            <button
              type="button"
              onClick={userPlay}
              className="flex items-center gap-1.5 rounded-base bg-white/10 px-3 py-1.5 text-sm text-white transition-colors hover:bg-white/20"
            >
              <Play size={15} /> 继续播放
            </button>
          </div>
        )}
      </div>

      {(view.panoramaError || view.fullscreenError) && <div role="status" className="pointer-events-none absolute bottom-24 left-3 z-30 rounded bg-black/75 px-2 py-1 text-xs text-white">
        {view.panoramaError || view.fullscreenError}
      </div>}
      {/* ===== 顶部透明标题层（原右主区标题栏合并进来，宽度让给画面） ===== */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 bg-gradient-to-b from-black/70 via-black/35 to-transparent px-4 pb-8 pt-3">
        <div className="min-w-0 text-white">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold">{channelName}</h2>
            {channelMeta?.kind === 'ai' && (
              <span className="shrink-0 rounded-full border border-primary/60 bg-black/30 px-2 py-0.5 text-[11px] text-primary-100">AI 输出</span>
            )}
            {channelMeta?.recording && (
              <span className="flex items-center gap-1.5 text-xs text-success">
                <span className="h-2 w-2 animate-pulse rounded-full bg-success" />
                录制中
              </span>
            )}
            {!channelMeta?.recording && channelMeta?.recordingState && (
              <span className="text-xs text-white/70" title={channelMeta.recordingDetail}>
                {channelMeta.recordingState === 'storage_error' ? '存储异常 / 停录'
                  : channelMeta.recordingState === 'codec_error' ? '缺少 H.265 录像组件 / 停录'
                    : channelMeta.recordingState === 'waiting_source' ? '等待录制'
                      : '未在录制'}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-white/70">
            <span className="font-mono">{formatCodec(channelMeta?.codec)}</span>
            <span>·</span>
            <span>{channelMeta?.width ?? '-'}×{channelMeta?.height ?? '-'}</span>
            <span>·</span>
            <span>{channelMeta?.fps ?? '-'} fps</span>
            <span>·</span>
            <span>{channelMeta?.hasAudio ? '有音频' : '无音频'}</span>
            {channelMeta?.seiPresent && <span className="text-primary-100">· 含 SEI</span>}
          </div>
        </div>

        {isToday && onJumpNow && (
          <button
            type="button"
            onClick={onJumpNow}
            className="pointer-events-auto flex shrink-0 items-center gap-1.5 rounded-base bg-white/10 px-3 py-1.5 text-xs text-white/90 backdrop-blur transition-colors hover:bg-white/20"
          >
            最近24小时
          </button>
        )}
      </div>

      {/* ===== 底部悬浮控制条（YouTube 风格渐变透明） ===== */}
      <RecordingToolbar
          duration={duration}
          currentTime={currentTime}
          bufferedPct={bufferedPct}
          progressPct={progressPct}
          speed={speed}
          dragging={dragging}
          playing={playing}
          speedMenuOpen={speedMenuOpen}
          muted={muted}
          showDetections={showDetections}
          error={error}
          hoverPct={hoverPct}
          hoverTime={hoverTime}
          absTs={absTs}
          checking={checking}
          segment={segment}
          channelMeta={channelMeta}
          downloadUrl={downloadUrl}
          videoEl={videoEl}
          view={view}
          progressRef={progressRef}
          speedMenuRef={speedMenuRef}
          onProgressMouseDown={onProgressMouseDown}
          onProgressMouseMove={onProgressMouseMove}
          setHoverTime={setHoverTime}
          setSpeed={setSpeed}
          setSpeedMenuOpen={setSpeedMenuOpen}
          setMuted={setMuted}
          setShowDetections={setShowDetections}
          userPause={userPause}
          userPlay={userPlay}
          snapshot={snapshot}
          volume={volume}
        />
    </div>
  )
}
