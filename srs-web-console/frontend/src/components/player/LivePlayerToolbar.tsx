import { CameraTalkButton } from './CameraTalkButton'
import { PROTO_LABEL } from './protocolLabels'
import { Play, Pause, VolumeX, Volume2, ShieldCheck, Move } from 'lucide-react'
import type { PlayProtocol } from '@/utils/playerMachine'
import { PlayerViewControls, type usePlayerView } from './PlayerViewControls'

interface Props {
  talkChannel?: string
  digitalZoom?:number
  setDigitalZoom?:(v:number)=>void
  panoramaActive?:boolean
  onPtz?:()=>void
  ptzOpen?:boolean
  paused: boolean
  isMuted: boolean
  togglePlay: () => void
  toggleMute: () => void
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
  digitalZoom=1,setDigitalZoom,panoramaActive,
  paused,
  isMuted,
  togglePlay,
  toggleMute,
  onArming,
  onPtz,
  ptzOpen, talkChannel,
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
            className="flex h-8 w-8 items-center justify-center rounded-base text-white hover:bg-white/10 disabled:opacity-40"
            title={paused ? '播放' : '暂停'} aria-label={paused ? '播放' : '暂停'}
            data-testid="btn-toggle-play"
          >
            {paused ? <Play size={15} /> : <Pause size={15} />}
          </button>
          <button
            type="button"
            onClick={toggleMute}
            className="flex h-8 w-8 items-center justify-center rounded-base text-white hover:bg-white/10 disabled:opacity-40"
            title={isMuted ? '取消静音' : '静音'} aria-label={isMuted ? '取消静音' : '静音'}
            data-testid="btn-toggle-mute"
          >
            {isMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
          {talkChannel && <CameraTalkButton key={talkChannel} channel={talkChannel}/>}
          <span className="flex-1" />
          {setDigitalZoom && !panoramaActive && <select title="播放器局部放大，镜头变焦请使用云台的拉近和拉远" aria-label="画面放大倍率" className="h-8 rounded bg-slate-900 px-1 text-xs text-white" value={digitalZoom} onChange={e=>setDigitalZoom(Number(e.target.value))}>
            {[1,1.5,2,3,4].map(v=><option key={v} value={v}>{v}×</option>)}
          </select>}
          {onPtz&&<button type="button" aria-label="摄像头云台" aria-expanded={!!ptzOpen} className={'flex min-h-8 items-center gap-1.5 rounded-base px-2 text-xs font-medium text-white hover:bg-white/10 '+(ptzOpen?'bg-blue-700':'')} onClick={e=>{e.stopPropagation();onPtz()}}><Move size={15} aria-hidden="true"/>云台</button>}
          {onArming&&<button type="button" className="flex h-8 items-center gap-1.5 rounded-base px-2 text-xs font-medium text-white hover:bg-white/10 disabled:opacity-40" disabled={!videoEl||!canConnect} title="编辑热区，并为热区或整个画面选用告警规则" onClick={e=>{e.stopPropagation();if(videoEl)onArming(videoEl)}}><ShieldCheck size={15} aria-hidden="true"/>布防</button>}
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
