import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ptzService, type PtzVector } from '@/api/ptzService';
import type { ReadDisplayedTracks } from './AiDetectionOverlay';
import type { usePtzControl } from './usePtzControl';
import { usePtzFollow } from './usePtzFollow';
import { largestPatrolTarget, type PatrolLabel } from './ptzPatrol';
import { captureLandmark, landmarkErrorMessage, matchLandmark, nearLandmark } from './patrolLandmark';
import { approachSpeed, teachingSpeedLimit, validPatrolSpeed, isRightSeam, panDelta, readRoute, span, steerAxis, storeRoute, tolerance, type Position, type Route } from './horizontalPatrol';

interface Options {
  camera:string; identity?:string; processor?:string; video?:HTMLVideoElement|null; enabled:boolean;
  positionAvailable:boolean;
  /** Opt in only from the visual-route validation harness until field acceptance. */
  visualTrial?:boolean;
  displayedTracks?:{current:ReadDisplayedTracks|null};
  control:Pick<ReturnType<typeof usePtzControl>,'drive'|'stopConfirmed'>;
}
interface Job {
  signal:AbortController; camera:string; identity:string; video:HTMLVideoElement;
  teachDone:boolean; direction:1|-1; label:PatrolLabel|null; speed:number;
  route?:Route; resumeAt?:Position; ignoreUntil:number; circleAnchor?:number;
  firstIntent?:number; confirm?:()=>void;
}
const pause = (ms:number) => new Promise<void>(resolve => setTimeout(resolve,ms));
const right = (speed:number):PtzVector => ({pan:speed,tilt:0,zoom:0});
const problem = (message:string):never => {throw Error(message)};
function message(error:unknown) {
  const text=error instanceof Error ? error.message : '';
  if (text.startsWith('patrol_landmark:') || (error instanceof Error && error.name==='SecurityError')) return landmarkErrorMessage(error);
  return /[\u3400-\u9fff]/.test(text) ? text : '位置核验失败，请检查设备或重新设置范围';
}
const now = () => performance.now();

// Repeated stationary views can indicate a limit or a stalled feed.
// Pause without recording a limit or repeatedly commanding the motor.
function watchPanProgress(initial:string) {
  let reference=initial, changedAt=0, observations=0;
  return (frame:string, elapsed:number)=>{
    if (!matchLandmark(reference,frame)) {reference=frame;changedAt=elapsed;observations=0;}
    else if (++observations>=3 && elapsed-changedAt>7000) problem('多次未确认画面继续移动，请检查云台行程');
  };
}

export function usePtzPatrol(options:Options) {
  const {camera, identity, processor, enabled, video, displayedTracks} = options;
  const current = useRef(options);
  current.current=options;
  const run = useRef<Job|null>(null);
  const stopping = useRef<Promise<boolean>|null>(null);
  const [active,setActive]=useState(false), [teaching,setTeaching]=useState(false);
  const [canFinish,setCanFinish]=useState(false);
  const [confirmRequired,setConfirmRequired]=useState(false);
  const [status,setStatus]=useState('');
  const [route,setRoute]=useState<Route|null>(null);
  const [targetLabel,setTarget]=useState<PatrolLabel|null>(null);
  useEffect(()=>{const saved=readRoute(identity);
    setRoute(saved?.kind==='visual' && !options.visualTrial ? null : saved);setStatus('');
  },[identity,camera,options.visualTrial]);

  function check(j:Job) {
    j.signal.signal.throwIfAborted();
    if (run.current!==j || !current.current.enabled || document.hidden || j.video.paused ||
        j.video.ended || j.video.readyState<2) problem('实时画面不可用，巡航已暂停');
  }
  async function position(j:Job) {
    check(j);
    const p=await ptzService.patrolPosition(j.camera,j.identity);
    check(j);
    return p;
  }
  async function landmark(j:Job) {
    check(j); const s=await captureLandmark(j.video); check(j); return s;
  }
  function finish(j:Job,text:string) {
    if (run.current!==j) return;
    j.signal.abort();run.current=null;
    setActive(false);setTeaching(false);setCanFinish(false);setTarget(null);setStatus(text);
  }
  function create(label:PatrolLabel|null,speed:number):Job|null {
    if (!enabled || !identity || !video || run.current || stopping.current || !validPatrolSpeed(speed)) return null;
    if (video.paused || video.ended || video.readyState<2 || document.hidden) {
      setStatus('等待实时画面后开始');return null;
    }
    const j:Job={camera,identity,video,signal:new AbortController(),teachDone:false,direction:1,label,speed,ignoreUntil:0,firstIntent:now()};
    run.current=j;setActive(true);
    return j;
  }

  // Keep the motor watchdog independent of observation latency. A late read cannot restart motion.
  async function drive(j:Job,initial:PtzVector,budget:number,sample:(elapsed:number)=>Promise<PtzVector|null>,
    verifyStart:()=>Promise<void>, teachingLeg=false) {
    check(j);
    let motor:PtzVector|null=initial, error:unknown, closed=false, started:number|undefined, stoppedAt:number|undefined;
    let brake:(()=>void)|undefined;
    const intent=j.firstIntent??now();
    j.firstIntent=undefined;
    const end=()=>{
      if (closed || stoppedAt!==undefined) return;
      motor=null;stoppedAt=now();brake?.();
    };
    let fresh=now(), videoAt=now(), mediaTime=j.video.currentTime;
    const motion=current.current.control.drive(()=>{
      check(j);
      if (started===undefined) { started=now();fresh=started;videoAt=started; }
      if (j.video.currentTime!==mediaTime) {mediaTime=j.video.currentTime;videoAt=now();}
      if (now()-fresh>2400 || now()-videoAt>2400) {
        error=Error('画面或位置反馈中断，巡航已暂停');return null;
      }
      return motor;
    },budget,async(signal,stopMotor)=>{
      brake=stopMotor;
      const firstFrameTime=j.video.currentTime;
      const firstFrames=j.video.getVideoPlaybackQuality?.().totalVideoFrames;
      const ready=()=>{
        signal.throwIfAborted();check(j);
        if(now()-intent>=2400) problem('画面或位置反馈中断，请重新开始');
      };
      ready();
      await Promise.all([verifyStart().catch(e=>{error=e;throw e;}),(async()=>{
        while(firstFrames ? j.video.getVideoPlaybackQuality().totalVideoFrames<=firstFrames :
          j.video.currentTime<=firstFrameTime) {ready();await pause(25);}
      })()]);
      ready();
      if(teachingLeg) j.confirm=()=>{j.teachDone=true;end();};
    });
    // Keep Stop independent of a pending command ACK or position/sample request.
    const watchdog=setInterval(()=>{
      if(closed || stoppedAt!==undefined || j.signal.signal.aborted) return;
      if(started===undefined ? now()-intent>=2400 : now()-fresh>2400 || now()-videoAt>2400) {
        error=Error('画面或位置反馈中断，请重新开始');
        end();
        if(!brake) void current.current.control.stopConfirmed();
      }
    },100);
    const observe=async()=>{
      try {
        while (!closed && motor && !j.signal.signal.aborted) {
          if (started!==undefined) {
            const next=await sample(now()-started);
            if (closed || stoppedAt!==undefined || j.signal.signal.aborted) return;
            if (!next) {end();return;}
            motor=next;fresh=now();
          }
          if (motor) await pause(160);
        }
      } catch(e) { if (!closed && stoppedAt===undefined) {error=e;end();} }
    };
    void observe();
    let ok:boolean;
    try { ok=await motion; } finally { closed=true;clearInterval(watchdog);j.confirm=undefined; }
    check(j);
    if (error) throw error;
    if (!ok || motor!==null) problem('行程未确认，巡航已暂停，请核对画面');
    return ((stoppedAt??now())-(started??now()))/1000;
  }
  async function verifyPosition(j:Job,ref:Position) {
    const p=await position(j);
    if(p.wrap!==ref.wrap || Math.abs(panDelta(ref.pan,p.pan,ref.wrap))>tolerance ||
       Math.abs(p.tilt-ref.tilt)>.025 || Math.abs(p.zoom-ref.zoom)>.012)
      problem('准备期间位置已改变，请重新开始');
  }
  async function settled(j:Job, visual=false) {
    const video=j.video;
    // Frames already buffered at the Stop ACK can still show the moving lens.
    let bufferedEnd=video.currentTime;
    if(visual) for(let i=0;i<video.buffered.length;i++) {
      if(video.buffered.start(i)<=video.currentTime && video.buffered.end(i)>=video.currentTime)
        bufferedEnd=video.buffered.end(i);
    }
    const deadline=now()+3000;
    await pause(400);check(j);
    while(visual && video.currentTime<=bufferedEnd) {
      if(now()>=deadline) problem('停转后画面仍有延迟，请核对端点');
      await pause(40);check(j);
    }
  }
  async function stationaryView(j:Job) {
    // WebRTC playout can still show motion after the device has acknowledged Stop.
    let last=await landmark(j), stable=0;
    const deadline=now()+3200;
    while (now()<deadline) {
      await pause(140);
      const frame=await landmark(j);
      stable=matchLandmark(last,frame) ? stable+1 : 0;
      if (stable>=2) return frame;
      last=frame;
    }
    return problem('停转后画面仍在变化，请检查视频延迟或更换参照位置');
  }
  async function teach(j:Job,circle:boolean) {
    setTeaching(true);setConfirmRequired(false);setStatus('正在记录起点…');
    const native=current.current.positionAvailable;
    let start:Position|null=null;
    if(native) {
      try {start=await position(j);}
      catch(e) {
        if(!(e instanceof Error && e.message==='ptz_position_unavailable' && 'status' in e && e.status===422)) throw e;
        check(j);
      }
    }
    if (!start && !current.current.visualTrial) problem('此设备无法回读完整云台位置，水平巡航不可用');
    let cyclic = start?.wrap === true;
    let crossedSeam = false, lastAdvance = 0, sinceAdvance = 0;
    const left=start ? '' : await landmark(j);
    setConfirmRequired(!circle || !start);
    let prev=start?.pan??0, travelled=0, departed=false, lastViewAt=-1500;
    const progress=watchPanProgress(left);
    const samples:{time:number; ref:string}[]=[];
    setStatus(circle ? (start ? '正在测量一圈，返回起点后自动停止' : '向右试扫，回到起点时确认') : '向右试扫，到右端时确认');
    const seconds=await drive(j,right(j.speed),180000,async elapsed=>{
      if (start) {
        const p=await position(j);
        if(j.teachDone) return null;
        if (isRightSeam(prev,p.pan)) { cyclic=true;crossedSeam=true; }
        const delta=panDelta(prev,p.pan,cyclic);prev=p.pan;
        if (Math.abs(delta)>.35 || delta<-.018 || Math.abs(p.tilt-start.tilt)>.025 || Math.abs(p.zoom-start.zoom)>.012)
          problem('试扫方向或高度异常，请重新设置');
        travelled+=delta;departed=travelled>.06;
        if (travelled-lastAdvance>.003) {lastAdvance=travelled;sinceAdvance=elapsed;}
        if (elapsed-sinceAdvance>5000) problem('镜头未继续转动，可改设左右端点');
        if (circle && crossedSeam && travelled>=2-tolerance) return null;
      } else if (!j.teachDone && (!departed || circle || elapsed-lastViewAt>=1500)) {
        lastViewAt=elapsed;
        const ref=await landmark(j);
        if(j.teachDone) return null;
        if (departed) progress(ref,elapsed);
        if (!matchLandmark(left,ref)) {
          departed=true;
          if (circle && elapsed-(samples.at(-1)?.time ?? -1000)>=1000) samples.push({time:elapsed,ref});
        }
      }
      setCanFinish(departed && elapsed>=2000 && (!circle || !start));
      if (j.teachDone) return null;
      if (!departed && elapsed>8000) problem('未确认镜头移动，请更换起点');
      return right(j.speed);
    },async()=>{
      if(start) await verifyPosition(j,start);
      else if(!matchLandmark(left,await landmark(j))) problem('准备期间起点画面已改变');
    },true);
    setCanFinish(false);
    await settled(j,!start);
    let learned:Route;
    if (start) {
      const end=await position(j);
      if (isRightSeam(prev,end.pan)) {cyclic=true;crossedSeam=true;}
      const tail=panDelta(prev,end.pan,cyclic);
      if(tail<-.018 || tail>.35 || Math.abs(start.zoom-end.zoom)>.012) problem('停转后行程异常，请重新设置');
      travelled+=tail;
      const width=span(start.pan,end.pan,cyclic);
      if (!departed || Math.abs(start.tilt-end.tilt)>.025 ||
          (circle ? !crossedSeam || travelled<1.94 || travelled>2.08 || Math.abs(panDelta(start.pan,end.pan,true))>.035 :
            width<.06 || Math.abs(width-travelled)>.045)) problem('端点行程未确认，请重新设置');
      learned={kind:'position',left:start.pan,right:end.pan,wrap:cyclic,speed:j.speed,seconds,circle};
    } else {
      const end=await stationaryView(j);
      if (!departed || (circle ? !matchLandmark(left,end) : nearLandmark(left,end))) problem('端点参考画面无法区分或未回到起点');
      const mid=samples.filter(v=>v.time>seconds*200 && v.time<seconds*800)
        .sort((a,b)=>Math.abs(a.time-seconds*500)-Math.abs(b.time-seconds*500))[0];
      if (circle && !mid) problem('缺少可辨认的中途参照，请重新设置');
      learned={kind:'visual',left,right:end,via:mid?.ref??'',speed:j.speed,seconds,circle};
    }
    if (seconds<2 || seconds>180) problem('行程用时超出可验证范围');
    if (learned.kind==='visual') {
      setCanFinish(false);setConfirmRequired(false);setStatus('向左复核起点…');
      await visualLeg(j,learned,-1);
    }
    check(j);storeRoute(j.identity,learned);setRoute(learned);finish(j,'范围已保存');
  }
  async function visualLeg(j:Job,r:Extract<Route,{kind:'visual'}>,dir:1|-1) {
    const from=dir===1?r.left:r.right, target=dir===1?r.right:r.left;
    let seenVia=false, departed=false;
    const progress=watchPanProgress(from);
    const atTarget=(frame:string)=>nearLandmark(frame,target) && (r.circle || !nearLandmark(frame,from));
    const expected=r.seconds*1000;
    await drive(j,right(dir*j.speed),expected*1.5+2200,async elapsed=>{
      if(elapsed>expected*1.5+1000) problem('端点未确认，请重新设置范围');
      // Observe departure, the mid-route landmark and the expected arrival window.
      const frame=await landmark(j);
      progress(frame,elapsed);
      if(!nearLandmark(frame,from)) departed=true;
      if(r.circle && elapsed>expected*.15 && elapsed<expected*.85 && matchLandmark(frame,r.via)) seenVia=true;
      if(!r.circle && nearLandmark(frame,target)) {
        if(!atTarget(frame)) problem('端点参考画面有歧义，请重新设置范围');
        return null;
      }
      if(r.circle && departed && atTarget(frame)) {
        if(!seenVia || elapsed<=expected*.60) problem('整圈回到起点过早或缺少中途参照，请重新设置范围');
        return null;
      }
      // Brake at the taught travel time even if buffered video has not shown
      // the endpoint yet. Accept the leg only against fresh stationary views.
      if (elapsed>=expected) {
        if (!departed || (r.circle && !seenVia)) problem('未确认离开起点或经过中途参照，请重新设置范围');
        return null;
      }
      return right(dir*j.speed);
    },async()=>{
      const view=await landmark(j);
      if(!nearLandmark(from,view) || (!r.circle && nearLandmark(target,view))) problem('准备期间端点画面已改变');
    });
    await settled(j,true);
    const first=await stationaryView(j), second=await landmark(j);
    if(!atTarget(first) || !atTarget(second) || !nearLandmark(first,second)) problem('停转后端点未确认，请核对范围');
  }
  async function returnToRoute(j:Job) {
    const ref=j.resumeAt!;
    const p=await position(j);
    if (Math.abs(p.zoom-ref.zoom)>.012) problem('倍率已变更，巡航已暂停');
    const towards=(s:Position)=>{
      if (Math.abs(s.zoom-ref.zoom)>.012) problem('倍率已变更，巡航已暂停');
      const pan=steerAxis(panDelta(s.pan,ref.pan,ref.wrap),.18);
      const tilt=steerAxis(ref.tilt-s.tilt,.18);
      return pan||tilt ? {pan,tilt,zoom:0} : null;
    };
    const initial=towards(p);
    if (initial) {
      setStatus('正在返回原巡航路线');
      await drive(j,initial,35000,async()=>towards(await position(j)),()=>verifyPosition(j,p));
      await settled(j);
      if (towards(await position(j))) problem('未确认回到原路线，巡航已暂停');
    }
    j.resumeAt=undefined;j.ignoreUntil=now()+2000;
  }
  async function scan(j:Job) {
    const r=j.route!;
    if (j.resumeAt) await returnToRoute(j);
    const native=r.kind==='position';
    const origin=native ? await position(j) : null;
    if (origin && native) {
      // A seam can be established by the stored trial on this exact binding.
      if (!r.circle) {
        const nearLeft=Math.abs(panDelta(origin.pan,r.left,r.wrap))<=tolerance*2;
        const fromLeft=span(r.left,origin.pan,r.wrap);
        if (!nearLeft && (fromLeft < -tolerance*2 || fromLeft>span(r.left,r.right,r.wrap)+tolerance*2)) problem('镜头在范围外，请移回范围或重新设置');
        if (Math.abs(panDelta(origin.pan,r.right,r.wrap))<=tolerance*2) j.direction=-1;
        if (nearLeft) j.direction=1;
      }
    } else if (r.kind==='visual') {
      const currentView=await landmark(j);
      const left=nearLandmark(r.left,currentView), right=nearLandmark(r.right,currentView);
      if(!r.circle && left && right) problem('端点参考画面有歧义，请重新设置范围');
      if(r.circle && !matchLandmark(r.left,currentView)) problem('请对准整圈起点');
      if (left) j.direction=1;
      else if (right) j.direction=-1;
      else problem('请将画面对准已保存的端点，或重新设置范围');
    }
    while (true) {
      check(j);
      const dir=j.direction;
      if (r.kind==='visual') {
        setStatus(dir>0?'向右扫描':'向左扫描');
        await visualLeg(j,r,dir);
        j.direction=dir===1?-1:1;continue;
      }
      const target=r.circle ? (j.circleAnchor??=origin!.pan) : dir===1?r.right:r.left;
      const begin=native ? await position(j) : null;
      let prev=begin?.pan??0, distance=0, found=false;
      let lastProgress=now(), checkpoint=0;
      const expected=r.seconds*(r.speed/j.speed);
      const dist=begin ? (dir===1 ? span(begin.pan,target,r.wrap) : span(target,begin.pan,r.wrap)) : 0;
      const endTravel=r.circle && (dist<.04 || dist>1.96) ? 2+panDelta(begin!.pan,target,true)*dir : dist;
      setStatus(dir>0?'向右扫描':'向左扫描');
      const speedAt = (remaining: number) => right(dir * (j.speed <= teachingSpeedLimit ? j.speed : approachSpeed(j.speed, remaining)));
      await drive(j,speedAt(endTravel),Math.min(300000,Math.max(16000,expected*2600+5500)),async ()=>{
        if (j.label && now()>j.ignoreUntil && largestPatrolTarget(j.label,current.current.displayedTracks?.current?.()??[])) {
          found=true;return null;
        }
        if (native && origin) {
          const p=await position(j);
          if (Math.abs(p.zoom-origin.zoom)>.012 || Math.abs(p.tilt-origin.tilt)>.025) problem('高度或倍率已改变，巡航已暂停');
          const delta=dir*panDelta(prev,p.pan,r.wrap);prev=p.pan;
          if (delta<-.02 || Math.abs(delta)>.35) problem('位置变化异常，巡航已暂停');
          distance+=delta;
          if (distance-checkpoint>.003) {lastProgress=now();checkpoint=distance;}
          if (now()-lastProgress>4000) problem('未检测到继续转动，请检查端点');
          const remaining=endTravel-distance;
          if (remaining<=tolerance) return null;
          return speedAt(remaining);
        }
        return right(dir*j.speed);
      },()=>verifyPosition(j,begin!));
      await settled(j);
      if (found) {
        const here=await position(j);
        j.resumeAt={...here,wrap:r.wrap,tilt:origin!.tilt,zoom:origin!.zoom};setStatus('正在锁定目标');setTarget(j.label);return;
      }
      if (native && begin) {
        const p=await position(j);
        if (Math.abs(panDelta(p.pan,target,r.wrap))>.03)
          problem('未确认到达端点，巡航已暂停');
      }
      j.direction=dir===1?-1:1;
    }
  }
  const resume=useRef(scan);resume.current=scan;
  const ended=useCallback((canResume:boolean,text:string)=>{
    const j=run.current;if(!j)return;setTarget(null);
    if (!canResume || !j.resumeAt) {finish(j,text);return;}
    void resume.current(j).catch(e=>finish(j,message(e)));
  },[]);
  const automatic=useMemo(()=>targetLabel?{label:targetLabel,ended}:undefined,[targetLabel,ended]);
  const follow=usePtzFollow({camera,identity,processor,displayedTracks,enabled:enabled&&!!automatic,automatic});
  const stop=useCallback(()=>{
    if(stopping.current)return stopping.current;
    const j=run.current;
    if(!j)return follow.stop();
    j.signal.abort();run.current=null;setCanFinish(false);setStatus('正在停止…');
    const pending=Promise.all([current.current.control.stopConfirmed(),follow.stop()]).then(parts=>{
      const ok=parts.every(Boolean);
      setActive(false);setTeaching(false);setTarget(null);setStatus(ok?'巡航已停止':'停止尚未确认');return ok;
    }).finally(()=>{stopping.current=null;});
    stopping.current=pending;return pending;
  },[follow.stop]);
  useLayoutEffect(()=>{
    const leave=()=>{if(run.current)void stop();};
    const hidden=()=>{if(document.hidden)leave();};
    window.addEventListener('blur',leave);window.addEventListener('pagehide',leave);
    document.addEventListener('visibilitychange',hidden);
    for (const evt of ['ended','pause','emptied']) video?.addEventListener(evt,leave);
    return ()=>{window.removeEventListener('blur',leave);window.removeEventListener('pagehide',leave);
      document.removeEventListener('visibilitychange',hidden);
      for(const evt of ['ended','pause','emptied'])video?.removeEventListener(evt,leave);leave();};
  },[camera,identity,processor,video,enabled,stop]);
  return {active,teaching,canFinish,confirmRequired,status:targetLabel && follow.statusText ? follow.statusText : status,
    selectedId:targetLabel?follow.selectedId:null,ownsLease:!!targetLabel&&follow.ownsLease,route,stop,
    start:(speed:number,label:PatrolLabel|null)=>{
      if(!route || (route.kind==='visual' && !options.visualTrial) || (label && (!processor || route.kind!=='position')))return;
      const j=create(label,route.kind==='visual'?route.speed:speed);if(!j)return;
      j.route=route;void scan(j).catch(e=>finish(j,message(e)));
    },
    teach:(speed:number,circle:boolean)=>{if (!validPatrolSpeed(speed)) return;
      const j=create(null,Math.min(speed,teachingSpeedLimit));if(j)void teach(j,circle).catch(e=>finish(j,message(e)));},
    confirmEnd:()=>{if(canFinish)run.current?.confirm?.();},
  };
}
