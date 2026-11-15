import {describe,expect,it} from 'vitest'
import {readSearchAiProcessors} from '../services/searchSourceCatalog.js'
import type {AppSettings} from '../types/channel.js'

// A channel whose analysed picture is not published (publish.enabled=false) reports
// effective_target_url: null. One such channel must not make the whole processor list
// unreadable: plate settings, the vehicle runtime and search sources all read it.
describe('AI processor list',()=>{
  it('accepts a processor that does not publish its analysed picture',async()=>{
    const channels=[
      {id:'published',config:{stream:{url:'rtmp://127.0.0.1:1935/live/a'},publish:{enabled:true,effective_target_url:'rtmp://127.0.0.1:1935/live/a-ai',target_url:null}}},
      {id:'unpublished',config:{stream:{url:'rtmp://127.0.0.1:1935/live/b'},publish:{enabled:false,effective_target_url:null,target_url:null}}},
    ]
    const fetchImpl=(async()=>new Response(JSON.stringify({channels}),{status:200,headers:{'content-type':'application/json'}})) as unknown as typeof fetch
    const settings={aiService:{baseUrl:'http://127.0.0.1:8090'}} as unknown as AppSettings
    const processors=await readSearchAiProcessors(settings,null,'http://127.0.0.1:8090',fetchImpl)
    expect(processors.map(p=>p.id)).toEqual(['published','unpublished'])
  })
})
