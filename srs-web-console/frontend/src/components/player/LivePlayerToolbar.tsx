import { PROTO_LABEL } from './protocolLabels'
import type { Dispatch, SetStateAction } from 'react'
import { Play, Pause, VolumeX, Volume2, Scan } from 'lucide-react'
import type { PlayProtocol } from '@/utils/playerMachine'
import { PlayerViewControls, type usePlayerView } from './PlayerViewControls'

interface Props {
  isFullscreen: boolean
  paused: boolean
  isMuted: boolean
  togglePlay: () => void
  toggleMute: () => void
  aiChannelId: string | undefined
  overlayEnabled: boolean
  setOverlayEnabled: Dispatch<SetStateAction<boolean>>
  showTrails?: boolean
  setShowTrails?: Dispatch<SetStateAction<boolean>>
  chain: PlayProtocol[]
  selectedProtocol: string
  onProtocol: (protocol: PlayProtocol) => void
  view: ReturnType<typeof usePlayerView>
  allowPanorama: boolean
  videoEl: HTMLVideoElement | null
  canConnect: boolean
}
export function LivePlayerToolbar({
  isFullscreen,
  paused,
  isMuted,
  togglePlay,
  toggleMute,
  aiChannelId,
  overlayEnabled,
  setOverlayEnabled,
  showTrails = false,
  setShowTrails,
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
          className={`pointer-events-auto absolute inset-x-0 bottom-0 z-40 flex items-center gap-2 bg-black/65 px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] transition-opacity ${isFullscreen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100'}`}>
          <button
            type="button"
            onClick={togglePlay}
            className="rounded-base p-1 text-white hover:bg-white/10"
            title={paused ? '播放' : '暂停'}
            data-testid="btn-toggle-play"
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
          </button>
          <button
            type="button"
            onClick={toggleMute}
            className="rounded-base p-1 text-white hover:bg-white/10"
            title={isMuted ? '取消静音' : '静音'}
            data-testid="btn-toggle-mute"
          >
            {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
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
                'rounded-base p-1 hover:bg-white/10',
                overlayEnabled ? 'text-primary-300' : 'text-white',
              ].join(' ')}
              title={overlayEnabled ? '隐藏识别框' : '显示识别框'}
              data-testid="btn-toggle-ai-overlay"
            >
              <Scan size={14} />
            </button>
          )}
          {aiChannelId && setShowTrails && <button type="button"
            aria-label="显示运动轨迹" aria-pressed={showTrails}
            disabled={view.panorama}
            title={view.panorama ? '请切回原始画面查看轨迹' : '显示最近30秒轨迹，需要AI处理器开启跟踪'}
            className={`rounded px-2 py-1 text-xs disabled:opacity-40 ${showTrails ? 'text-primary-300' : 'text-white'}`}
            onClick={e => { e.stopPropagation(); setShowTrails(value => !value) }}
            data-testid="btn-toggle-trails">轨迹</button>}
          {chain.length > 1 && (
            <select
              value={selectedProtocol}
              onChange={(e) =>
                onProtocol(e.target.value as PlayProtocol)
              }
              className="rounded-base bg-black/40 px-1.5 py-0.5 text-xs text-white outline-none"
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
