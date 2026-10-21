import { PROTO_LABEL } from './protocolLabels'
import type { Dispatch, SetStateAction } from 'react'
import { Play, Pause, VolumeX, Volume2, Scan, ShieldCheck } from 'lucide-react'
import type { PlayProtocol } from '@/utils/playerMachine'
import { PlayerViewControls, type usePlayerView } from './PlayerViewControls'

interface Props {
  paused: boolean
  isMuted: boolean
  togglePlay: () => void
  toggleMute: () => void
  aiChannelId: string | undefined
  overlayEnabled: boolean
  setOverlayEnabled: Dispatch<SetStateAction<boolean>>
  onArming?: (video: HTMLVideoElement) => void
  chain: PlayProtocol[]
  selectedProtocol: string
  onProtocol: (protocol: PlayProtocol) => void
  view: ReturnType<typeof usePlayerView>
  allowPanorama: boolean
  videoEl: HTMLVideoElement | null
  canConnect: boolean
}
export function LivePlayerToolbar({
  paused,
  isMuted,
  togglePlay,
  toggleMute,
  aiChannelId,
  overlayEnabled,
  setOverlayEnabled,
  onArming,
  chain,
  selectedProtocol,
  onProtocol,
  view,
  allowPanorama,
  videoEl,
  canConnect,
}: Props) {
  return (
        <div data-testid="player-toolbar"
          onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}
          className="pointer-events-auto relative z-40 opacity-100 flex shrink-0 flex-wrap items-center gap-1 bg-black/80 px-2 py-1 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={togglePlay}
            className="flex h-10 w-10 items-center justify-center rounded-base text-white hover:bg-white/10 disabled:opacity-40"
            title={paused ? '播放' : '暂停'} aria-label={paused ? '播放' : '暂停'}
            data-testid="btn-toggle-play"
          >
            {paused ? <Play size={18} /> : <Pause size={18} />}
          </button>
          <button
            type="button"
            onClick={toggleMute}
            className="flex h-10 w-10 items-center justify-center rounded-base text-white hover:bg-white/10 disabled:opacity-40"
            title={isMuted ? '取消静音' : '静音'} aria-label={isMuted ? '取消静音' : '静音'}
            data-testid="btn-toggle-mute"
          >
            {isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <span className="flex-1" />
          {aiChannelId && (
            <button
              type="button"
              onClick={(e) => {
                // 宫格瓦片场景下 VideoPlayer 外面包着一层"点击进聚焦"的容器
                // （见 Monitor/index.tsx 的 slot-tile），控制栏按钮嵌在里面，
                // 不挡住冒泡的话点"识别框"会顺带把用户带进聚焦大画面。
                e.stopPropagation()
                setOverlayEnabled((v) => !v)
              }}
              className={[
                'flex h-10 w-10 items-center justify-center rounded-base hover:bg-white/10',
                overlayEnabled ? 'bg-white/15 text-primary-300' : 'text-white',
              ].join(' ')}
              title={overlayEnabled ? '隐藏识别框' : '显示识别框'} aria-label={overlayEnabled ? '隐藏识别框' : '显示识别框'} aria-pressed={overlayEnabled}
              data-testid="btn-toggle-ai-overlay"
            >
              <Scan size={18} />
            </button>
          )}
          {onArming&&<button type="button" className="flex h-10 items-center gap-1.5 rounded-base px-2.5 text-xs font-medium text-white hover:bg-white/10 disabled:opacity-40" disabled={!videoEl||!canConnect} title="编辑热区，并为热区或整个画面选用触发器" onClick={e=>{e.stopPropagation();if(videoEl)onArming(videoEl)}}><ShieldCheck size={18} aria-hidden="true"/>布防</button>}
          {chain.length > 1 && (
            <select
              value={selectedProtocol}
              onChange={(e) =>
                onProtocol(e.target.value as PlayProtocol)
              }
              className="h-8 rounded-base bg-black/40 px-1.5 text-xs text-white outline-none" aria-label="播放协议"
              data-testid="proto-select"
            >
              {chain.map((p) => (
                <option key={p} value={p}>
                  {PROTO_LABEL[p]}
                </option>
              ))}
            </select>
          )}
          <PlayerViewControls view={view} allowPanorama={allowPanorama} disabled={!videoEl || !canConnect} />
        </div>
  )
}
