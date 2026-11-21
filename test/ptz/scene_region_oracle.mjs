// Offline scoring shared by deployed and candidate replays. Matrices use native pixels.
export function gradeSceneRegion(region,match,project,width,height,maxVertexErrorPx){
 const projection=project(match,region.polygon);
 let errors=null;
 if(projection&&region.oracleH){
  errors=region.polygon.map(([x,y],i)=>{
   const p=[x*width,y*height,1];
   const [u,v,w]=region.oracleH.map(row=>row.reduce((s,a,j)=>s+a*p[j],0));
   return Math.hypot(projection[i][0]*width-u/w,projection[i][1]*height-v/w);
  });
 }
 const max=errors?Math.max(...errors):null;
 const outcome=region.policy==='measure_only'?(projection?'accepted_unscored':'rejected_unscored'):projection?(region.policy==='reject'?'false_accept_no_correspondence':
   max>maxVertexErrorPx?'false_accept_wrong_geometry':'accepted_accurate'):
   region.policy==='visible'?'visible_rejected':'negative_rejected';
 return {name:region.name,policy:region.policy,projection,vertexErrorsPx:errors,maxPx:max,outcome};
}
