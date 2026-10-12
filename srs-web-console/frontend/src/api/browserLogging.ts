/** Bounded runtime reporting. Never collect page contents, forms, tokens or full URLs. */
export function installBrowserLogging() {
  const recent=new Map<string,number>()
  function report(message:string) {
    const safe=message.replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[REDACTED]@')
      .replace(/https?:\/\/[^\s]+/gi,'[URL]').slice(0,1000)
    const now=Date.now()
    if(now-(recent.get(safe)??0)<60000)return
    if(recent.size>=50)recent.delete(recent.keys().next().value!)
    recent.set(safe,now)
    const token=localStorage.getItem('srs-console-token')
    void fetch('/api/observability/browser-error', {method:'POST',signal:AbortSignal.timeout(5000),
      headers:{'Content-Type':'application/json',...(token?{'X-Console-Token':token}:{})},
      body:JSON.stringify({message:safe,module:'browser'})}).catch(()=>{})
  }
  window.addEventListener('error',event=>report(event.message||'浏览器运行异常'))
  window.addEventListener('unhandledrejection',event=>report(event.reason instanceof Error?event.reason.message:'未处理的异步异常'))
}
