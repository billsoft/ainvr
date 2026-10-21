import type {CSSProperties,ReactNode,Ref} from 'react'
interface Props {width:number;height:number;frameRef?:Ref<HTMLDivElement>;hidden?:boolean;children:ReactNode}
/** Largest box of the picture's aspect ratio that fits the remaining space, so the
 * picture and the tools around it stay on screen without scrolling the dialog. */
export function FitFrame({width,height,frameRef,hidden,children}:Props){
 const w=width||16,h=height||9
 return <div hidden={hidden} className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center" style={{containerType:'size'} as CSSProperties}>
  <div ref={frameRef} className="relative overflow-hidden rounded-base border border-line bg-black"
   style={{width:`min(100cqw, calc(100cqh * ${w} / ${h}))`,aspectRatio:`${w}/${h}`,touchAction:'none'}}>{children}</div>
 </div>
}
