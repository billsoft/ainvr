import {Check,Plus} from 'lucide-react'

/** Shared touch-first selection styling for the arming libraries. */
export function associationChoiceClass(selected:boolean){
 return `group flex min-h-20 w-full items-center gap-3 rounded-card border p-3 text-left transition-colors focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2 ${selected?'border-primary bg-primary-50 ring-1 ring-primary':'border-blue-200 bg-blue-50/40 hover:border-primary hover:bg-primary-50'}`
}
export function AssociationChoiceAction({selected}:{selected:boolean}){
 const Icon=selected?Check:Plus
 return <span className={`ml-auto inline-flex min-h-11 shrink-0 items-center gap-1 rounded-base px-2.5 text-xs font-medium ${selected?'text-primary':'bg-primary text-white shadow-sm group-hover:brightness-95'}`}><Icon size={14} aria-hidden="true"/>{selected?'已选择':'关联'}</span>
}
