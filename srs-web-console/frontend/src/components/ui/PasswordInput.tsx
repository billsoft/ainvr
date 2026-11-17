import {useState,type InputHTMLAttributes} from 'react'
import {Eye,EyeOff} from 'lucide-react'

type Props=Omit<InputHTMLAttributes<HTMLInputElement>,'type'>

/** A password field with an eye to show what was typed, so a wrong password is caught at once.
 *  The text is hidden again whenever the field is rebuilt; it is never remembered. */
export function PasswordInput({className='',...props}:Props){
 const [shown,setShown]=useState(false)
 return <span className="relative block">
  <input {...props} type={shown?'text':'password'} className={`${className} pr-11`}/>
  <button type="button" aria-label={shown?'隐藏密码':'显示密码'} title={shown?'隐藏密码':'显示密码'}
   className="absolute right-1 top-1/2 flex min-h-9 min-w-9 -translate-y-1/2 items-center justify-center rounded-base text-ink-faint hover:text-ink"
   onClick={()=>setShown(v=>!v)}>{shown?<EyeOff size={16} aria-hidden/>:<Eye size={16} aria-hidden/>}</button>
 </span>
}
