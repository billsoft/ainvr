import { z } from 'zod';

export type ScenePoint = [number,number];
const unit=z.number().finite().min(0).max(1);
const finite=z.number().finite().min(-1e6).max(1e6);
const result=z.object({
 schema:z.literal('ainvr.scene-match.v2'),backend:z.literal('neuflow-bpu'),matched:z.literal(true),
 homography:z.array(finite).length(9),supportBounds:z.tuple([unit,unit,unit,unit]),
 localEvidence:z.string().length(128*96).regex(/^[usad12346789]+$/),
 supportGrid:z.object({columns:z.literal(8),rows:z.literal(6),cells:z.array(z.boolean()).length(48)}),
 candidateCount:z.number().int().min(40).max(512*384),inliers:z.number().int().min(40).max(512*384),
 coverage:unit.min(.5),reprojectionErrorPx:z.number().finite().min(0).max(3)
});
// Clip the closed segment against both axis intervals. A corner or shared
// grid-line contact counts on both sides; tolerance rounds toward rejection.
function edgeTouchesCell(a:ScenePoint,b:ScenePoint,low:ScenePoint,high:ScenePoint){
 let enter=0,leave=1;
 for(const axis of [0,1] as const){
  const min=low[axis]-1e-12,max=high[axis]+1e-12,delta=b[axis]-a[axis];
  if(delta===0){
   if(a[axis]<min||a[axis]>max)return false;
  }else{
   const t0=(min-a[axis])/delta,t1=(max-a[axis])/delta;
   enter=Math.max(enter,Math.min(t0,t1));
   leave=Math.min(leave,Math.max(t0,t1));
   if(enter>leave)return false;
  }
 }
 return true;
}
function touchesCell(points:ScenePoint[],column:number,row:number){
 const low:ScenePoint=[column/8,row/6],high:ScenePoint=[(column+1)/8,(row+1)/6];
 const x=(low[0]+high[0])/2,y=(low[1]+high[1])/2;
 let centerInside=false;
 for(let i=0;i<points.length;i++){
  const a=points[i]!,b=points[(i+1)%points.length]!;
  if(edgeTouchesCell(a,b,low,high))return true;
  if((a[1]>y)!==(b[1]>y) && x<a[0]+(y-a[1])*(b[0]-a[0])/(b[1]-a[1]))centerInside=!centerInside;
 }
 // With no crossing, an intersecting cell must lie wholly inside the polygon.
 return centerInside;
}
// Coordinates here are native pixels. Each s-site has a 9x9 patch after a
// 3x3 median. Require the entire patch on both sides of the projection.
function insideWithMargin(x:number,y:number,polygon:ScenePoint[],margin:number){
 let inside=false;
 for(let n=0;n<polygon.length;n++){
  const [ax,ay]=polygon[n]!,[bx,by]=polygon[(n+1)%polygon.length]!;
  const dx=bx-ax,dy=by-ay;
  if(edgeTouchesCell([ax,ay],[bx,by],[x-margin,y-margin],[x+margin,y+margin]))return false;
  if((ay>y)!==(by>y)&&x<ax+(y-ay)*dx/dy)inside=!inside;
 }
 return inside;
}

function supportedInside(sites:string,points:ScenePoint[],projected:ScenePoint[],h:number[]){
 const pixels=(p:ScenePoint[]):ScenePoint[]=>p.map(([x,y])=>[x*512,y*384]);
 const src=pixels(points),dst=pixels(projected);
 const xs=src.map(p=>p[0]),ys=src.map(p=>p[1]);
 const left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys);
 let total=0,support=0,disagree=0,quadrants=0;
 for(let row=Math.max(0,Math.ceil((top-2)/4));row<96&&row*4+2<=bottom;row++){
  for(let col=Math.max(0,Math.ceil((left-2)/4));col<128&&col*4+2<=right;col++){
   const x=col*4+2,y=row*4+2;
   // Square patch radius is 5 including median, measured in source pixels.
   if(!insideWithMargin(x,y,src,5))continue;
   total++;
   const s=sites[row*128+col];
   if(s==='d'){disagree++;continue;}
   if(!s||s==='a'||s==='u')continue;
   const slot=s==='s'?4:Number(s)-1;
   const u=x/512,v=y/384,w=h[6]!*u+h[7]!*v+h[8]!;
   const tx=512*(h[0]!*u+h[1]!*v+h[2]!)/w,ty=384*(h[3]!*u+h[4]!*v+h[5]!)/w;
   if(!insideWithMargin(Math.round(tx)+(slot%3)-1,Math.round(ty)+Math.floor(slot/3)-1,dst,5))continue;
   support++;
   const rightHalf=x>(left+right)/2 ? 1 : 0;
   const bottomHalf=y>(top+bottom)/2 ? 2 : 0;
   quadrants |= 1 << (rightHalf + bottomHalf);
  }
 }
 const spread=quadrants===7||quadrants===11||quadrants===13||quadrants===14||quadrants===15;
 return support>=6&&support>=.2*total&&support>=4*disagree&&spread;
}

export function projectScene(raw:unknown,points:ScenePoint[]):ScenePoint[]|null {
 const parsed=result.safeParse(raw);
 if(!parsed.success || points.length<3 || points.length>32)return null;
 const {homography:h,supportBounds:[left,top,right,bottom],candidateCount,inliers}=parsed.data;
 if(inliers>candidateCount || inliers<.65*candidateCount || right-left<.45 || bottom-top<.45)return null;
 const [a,b,c,d,e,f,g,k,i]=h as [number,number,number,number,number,number,number,number,number];
 const det=a*(e*i-f*k)-b*(d*i-f*g)+c*(d*k-e*g);
 if(Math.abs(i-1)>1e-6||det<=0)return null;
 for(const x of [0,1])for(const y of [0,1]){
  const w=g*x+k*y+i,scale=det/(w*w*w);
  if(w<.2||scale<.1||scale>10)return null;
 }
 const projected:ScenePoint[]=[];
 for(const [x,y] of points){
  if(!(x>=left && x<=right && y>=top && y<=bottom))return null;
  const w=g*x+k*y+i;
  if(Math.abs(w)<1e-6 || det/(w*w*w)<=0)return null;
  const X=(a*x+b*y+c)/w,Y=(d*x+e*y+f)/w;
  if(!(X>=0 && X<=1 && Y>=0 && Y<=1))return null;
  projected.push([X,Y]);
 }
 const area=projected.reduce((s,[x,y],n)=>{const [X,Y]=projected[(n+1)%projected.length]!;return s+x*Y-y*X;},0);
 if(Math.abs(area)<=1e-6)return null;
 const cells=parsed.data.supportGrid.cells;
 for(let n=0;n<cells.length;n++){
  if(!cells[n] && touchesCell(points,n%8,Math.floor(n/8)))return null;
 }
 return supportedInside(parsed.data.localEvidence,points,projected,h)?projected:null;
}
export function sameProjection(a:ScenePoint[]|null,b:ScenePoint[]|null,tolerance=.002){
 return a===null||b===null?a===b:a.length===b.length && a.every(([x,y],i)=>Math.hypot(x-b[i]![0],y-b[i]![1])<=tolerance);
}
