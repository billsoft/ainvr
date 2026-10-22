import type {ReactNode} from 'react'

/** Editor toolbar tool: icon above a short word, a fixed touch-size cell like
 * drawing programs. Tools keep their place when unavailable (disabled, never hidden),
 * and short labels remain visible for touch users without relying on hover. */
export function ToolButton({icon,label,name,pressed,disabled,onClick}:{icon:ReactNode;label:string;name?:string;pressed?:boolean;disabled?:boolean;onClick:()=>void}){
 return <button type="button" aria-label={name??label} title={name??label} aria-pressed={pressed} disabled={disabled} onClick={onClick}
  className="flex h-12 min-w-[2.75rem] shrink-0 flex-col items-center justify-center gap-1 rounded-base px-2 text-xs text-ink transition-colors hover:bg-surface-hover aria-pressed:bg-primary-50 aria-pressed:text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent">
  {icon}<span className="hidden whitespace-nowrap xl:inline">{label}</span>
 </button>
}
/** A native list (touch-friendly picker) dressed as a tool; shows the current choice. */
export function ToolSelect({icon,label,name,value,disabled,onChange,children}:{icon:ReactNode;label:string;name:string;value:string;disabled?:boolean;onChange:(value:string)=>void;children:ReactNode}){
 return <label title={name} className={`relative flex h-12 min-w-[2.75rem] max-w-[8rem] shrink-0 flex-col items-center justify-center gap-1 rounded-base px-2 text-xs text-ink hover:bg-surface-hover ${disabled?'opacity-40':''}`}>
  {icon}<span className="max-w-full truncate whitespace-nowrap">{label}</span>
  <select aria-label={name} className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed" disabled={disabled} value={value} onChange={e=>onChange(e.target.value)}>{children}</select>
 </label>
}
export function ToolDivider(){return <span className="mx-1 h-8 w-px shrink-0 bg-line" aria-hidden="true"/>}
