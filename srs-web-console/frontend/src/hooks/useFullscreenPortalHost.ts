import {useEffect,useState} from 'react'

/** Dialogs opened from a fullscreen player must live inside its top-layer root. */
export function useFullscreenPortalHost(){
 const [host,setHost]=useState<Element>(()=>document.fullscreenElement??document.body)
 useEffect(()=>{
  const update=()=>setHost(document.fullscreenElement??document.body)
  document.addEventListener('fullscreenchange',update)
  update()
  return()=>document.removeEventListener('fullscreenchange',update)
 },[])
 return host
}
