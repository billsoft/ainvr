/** Actual product components, isolated test metadata and simulated camera only. */
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import MonitorPage from '@/pages/Monitor';
import {VideoPlayer} from '@/components/player/VideoPlayer';
import {PtzGlobalSettings} from '@/pages/ConfigCenter/PtzGlobalSettings';
import {ChannelWizard} from '@/pages/Channels/ChannelWizard';
import '@/styles/globals.css';
function Fixture(){
 const [data,setData]=useState<any>(),[mode,setMode]=useState('monitor'),[camera,setCamera]=useState('main'),[width,setWidth]=useState('100%'),[open,setOpen]=useState(false),[wizard,setWizard]=useState(false);
 useEffect(()=>{fetch('/__fixture/info').then(r=>r.json()).then(setData)},[]);
 if(!data)return <p>读取隔离测试摄像头…</p>;
 const input=data.inputs[camera];
 return <><header className="flex flex-wrap items-center gap-3 border-b bg-amber-50 p-3 text-sm"><strong>AINVR 云台隔离模拟验收</strong><span>固定测试环境，不控制生产摄像头；画面不代表真机运动。</span>{[['monitor','监看整体'],['player','播放器'],['settings','公共配置']].map(([key,label])=><button key={key} className="ui-btn" onClick={()=>{setMode(key);setOpen(false)}}>{label}</button>)}<button className="ui-btn" onClick={()=>setWizard(true)}>编辑摄像头</button><select aria-label="模拟摄像头" value={camera} onChange={e=>{setCamera(e.target.value);setOpen(false)}}>{['main','sub','other','zoom','fixed','ai-a'].map(key=><option key={key} value={key}>{data.inputs[key].name}</option>)}</select><select aria-label="验收宽度" value={width} onChange={e=>setWidth(e.target.value)}><option value="100%">桌面</option><option value="768px">平板</option><option value="390px">窄屏</option></select></header><main style={{width,maxWidth:'100%',height:'calc(100vh - 90px)',margin:'auto',overflow:'auto'}}>{mode==='monitor'?<MemoryRouter initialEntries={[location.pathname+location.search]}><MonitorPage/></MemoryRouter>:mode==='settings'?<PtzGlobalSettings/>:<div style={{height:'100%',minHeight:500,background:'#020617'}}><VideoPlayer className="h-full" title={input.name} protocols={['webrtc']} primary="webrtc" stream={{host:location.host,app:'fixture',stream:'sample'}} ptz={{channelId:input.id,open,onToggle:()=>setOpen(v=>!v)}}/></div>}</main><ChannelWizard open={wizard} mode="edit" initial={{...input,upstream:{protocol:input.upstreamProtocol,app:input.app||'live',stream:input.streamName,inputEnabled:true},downstream:{protocols:input.downstreamProtocols,primary:input.primaryProtocol},status:{online:false,viewerCount:0,srsOnline:false}}} onClose={()=>setWizard(false)} onSubmit={()=>{throw Error('Only ONVIF fixture channel saves are supported')}} onOnvifSaved={()=>setWizard(false)}/></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
