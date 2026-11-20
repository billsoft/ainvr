import { expect, it } from 'vitest';
import { FrameFollower, followFreshMs, followSpeedLimit } from '../services/ptzFollow.js';

// One-axis closed loop in fractions of a field of view; the same law runs on
// both axes. Parameters describe a sensitivity sweep, not calibrated cameras.
// The 80 ms processing and 850 ms presentation delays are assumptions.
// Publish-buffer span is not a measurement of end-to-end presentation age.
type Case = { speed:number; gain:number; lag:number; coast:number; maneuver:'stop'|'reverse'; sign:number };
type Result = { lost:boolean; margin:number; overshoot:number; maxCommand:number };
const origin=10_000, step=5, identity='ai:test:1:9';

function legacy(error:number, last:number, extent:number) {
  if (Math.abs(error)<=(last===0 ? .055 : .03) || error*last<0) return 0;
  return Math.sign(error)*Math.min(.31,.19+.60*extent,.12+.9*(Math.abs(error)-.03));
}

function simulate(c:Case, cap:number|null, pollPeriod:number):Result {
  const follower=new FrameFollower('ai',origin,cap ?? .31);
  const halfBox=.035, rtt=65;
  let world=c.sign*.06, camera=0, motor=0, requested=0, last=0;
  let minMargin=1, overshoot=0, peak=0, lost=false;
  let nextPoll=0, usedPTS=-1, latest=-1, expires=Infinity;
  const commands:{at:number;speed:number}[]=[];
  const images:number[]=[];
  let held=false;
  function issue(t:number, speed:number) {
    if (speed!==last) commands.push({at:t+c.lag,speed});
    if (cap!==null) {
      if (speed!==0 || !follower.parked) follower.dispatched(speed,0,t+origin);
      follower.parked=speed===0;
    }
    last=speed;
    peak=Math.max(peak,Math.abs(speed));
  }
  for (let t=0;t<=7600;t+=step) {
    while (commands.length && commands[0]!.at<=t) requested=commands.shift()!.speed;
    // First-order drive plus command delay; Stop has the same transport lag
    // and a finite decay. A new command changes future observations.
    motor+=(requested*c.gain-motor)*(1-Math.exp(-step/c.coast));
    const reversing=c.maneuver==='reverse';
    const travel=t<3400 ? 1 : reversing && t<5400 ? -1 : 0;
    world+=travel*c.sign*c.speed*step/1000;
    camera+=motor*step/1000;
    const error=world-camera;
    minMargin=Math.min(minMargin,.5-Math.abs(error)-halfBox);
    if (Math.abs(error)-halfBox>=.5) lost=true;
    if (t>=(reversing ? 5400 : 3400))
      overshoot=Math.max(overshoot,-error*c.sign*(reversing ? -1 : 1));
    if (t%200===0) images.push(error); // 5 FPS, ~80ms capture-to-result
    if (t>=expires) { issue(t,0); expires=Infinity; }
    if (t<nextPoll) continue;
    nextPoll=t+(pollPeriod===0 ? 200+rtt : Math.max(pollPeriod,rtt));
    latest=Math.floor((t-80)/200);
    if (latest<0 || latest===usedPTS) continue;
    usedPTS=latest;
    const at=latest*200, e=images[latest]!;
    // The presented stream is older than latest. An absent displayed identity
    // brakes too; it never supplies the geometry of a moving target.
    const shown=images[Math.max(0,Math.floor((t-850)/200))]!;
    const left=Math.max(0,.5+e-halfBox), right=Math.min(1,.5+e+halfBox);
    if (right<=left || Math.abs(shown)>=.5+halfBox) {
      if (!held) { issue(t,0); follower.hold(identity); follower.holdUntil=origin+t+4000; held=true; }
      continue;
    }
    const wall=origin+at+80;
    if (held && (origin+t>=follower.holdUntil || wall<follower.holdUntil-4000)) continue;
    let speed:number;
    if (cap===null) speed=legacy((left+right)/2-.5,last,right-left);
    else {
      const r=follower.sample({channel_id:'ai',frame_width:1000,frame_height:1000,
        frame_index:latest,frame_pts_ns:(origin+at)*1e6,timestamp:wall/1000,
        detections:[{track_id:identity,class_name:'vehicle',bbox:{x:left*1000,y:465,w:(right-left)*1000,h:70}}]},
        identity,origin+t);
      speed=r.vector?.pan ?? 0;
      if (r.vector) follower.resumed();
    }
    held=false;
    issue(t,speed);
    expires=wall-origin+followFreshMs;
  }
  return {lost,margin:minMargin,overshoot,maxCommand:peak};
}

it('compares edge clearance, exits and overshoot with delayed actuation and finite braking', () => {
  const cases:Case[]=[];
  for (const gain of [.7,1.2]) for (const lag of [80,220]) for (const coast of [90,230])
    for (const speed of [.08,.18,.26,.34]) for (const maneuver of ['stop','reverse'] as const)
      for (const sign of [-1,1]) cases.push({gain,lag,coast,speed,maneuver,sign});
  const variants:[string,number|null,number][]=[
    ['legacy',null,0],['cadence only',null,125],['adaptive .35',.35,125],
    ['adaptive .50',.50,125],['adaptive .60',.60,125],
  ];
  const summary=variants.map(([name,cap,period]) => {
    const runs=cases.map(c=>simulate(c,cap,period));
    const quantile=(xs:number[],q:number)=>+xs.sort((a,b)=>a-b)[Math.floor(q*(xs.length-1))]!.toFixed(4);
    return {name,cases:runs.length,exits:runs.filter(r=>r.lost).length,
      clipped:runs.filter(r=>r.margin<0).length,marginP10:quantile(runs.map(r=>r.margin),.10),
      overshootP95:quantile(runs.map(r=>r.overshoot),.95),worstOvershoot:quantile(runs.map(r=>r.overshoot),1),
      peak:quantile(runs.map(r=>r.maxCommand),1)};
  });
  console.table(summary);
  const chosen=summary[variants.findIndex(([,cap])=>cap===followSpeedLimit)]!;
  expect(chosen.exits).toBeLessThan(summary[1]!.exits);
  expect(chosen.marginP10).toBeGreaterThan(summary[1]!.marginP10);
  for (const baseline of summary.slice(0,2)) {
    expect(chosen.overshootP95).toBeLessThanOrEqual(baseline.overshootP95);
    expect(chosen.worstOvershoot).toBeLessThanOrEqual(baseline.worstOvershoot);
  }
  expect(chosen.peak).toBeLessThanOrEqual(followSpeedLimit);
});
