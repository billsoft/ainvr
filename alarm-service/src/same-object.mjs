// Two boxes of the SAME category that cover mostly the same pixels are one object seen twice. Boxes of different
// categories may overlap freely: a bag is held in front of its carrier and people in a huddle touch.
export const SAME_LABEL_IOU=.5;
export function iou(a,b){
  const w=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x),h=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
  if(!(w>0&&h>0))return 0;
  const inter=w*h;return inter/(a.w*a.h+b.w*b.h-inter);
}
export function separate(a,b){
  return a.label_id!==b.label_id||iou(a.bbox,b.bbox)<=SAME_LABEL_IOU;
}
