#!/usr/bin/env python3
"""Independent, bounded SOAP PTZ camera for isolated acceptance; no media processing.
Only test addresses may be used. Never run this on a real camera service port.
"""
import argparse,datetime,http.server,json,threading,time,urllib.request,xml.etree.ElementTree as ET
NS='http://www.onvif.org/ver20/ptz/wsdl';TT='http://www.onvif.org/ver10/schema';DEVICE='http://www.onvif.org/ver10/device/wsdl';MEDIA='http://www.onvif.org/ver10/media/wsdl'
PAN='http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace';ZOOM='http://www.onvif.org/ver10/tptz/ZoomSpaces/VelocityGenericSpace'
PROFILES={'main':('camera-a','config-a','motor-a'),'sub':('camera-b','config-b','motor-a'),'other':('camera-c','config-c','motor-c'),'zoom':('camera-z','config-z','motor-z'),'fixed':('camera-f','','')}
LOCK=threading.RLock();EVENTS=[];MOTORS={n:{'position':[0.,0.,.2],'until':0.,'presets':{'front':{'name':'Front gate','position':[0.,0.,.2]},'back':{'name':'Back gate','position':[.6,.2,.7]}}} for n in ['motor-a','motor-c','motor-z']};FAULT=False

def local(tag):return tag.split('}')[-1]
def text(node,name,default=''):
 for child in node.iter():
  if local(child.tag)==name:return child.text or default
 return default

def vector(p,zoom_only=False):
 return ('' if zoom_only else f'<tt:PanTilt x="{p[0]}" y="{p[1]}" space="pan-position"/>')+f'<tt:Zoom x="{p[2]}" space="zoom-position"/>'
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def reply(self,code,body,kind='application/json'):
  data=body.encode() if isinstance(body,str) else json.dumps(body).encode();self.send_response(code);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
 def do_GET(self):
  with LOCK:
   if self.path=='/__fixture/state':self.reply(200,{'events':EVENTS,'motors':MOTORS,'fault':FAULT})
   else:self.reply(404,{'error':'fixture_only'})
 def do_POST(self):
  global FAULT
  size=int(self.headers.get('Content-Length','0'))
  if size<1 or size>32768:self.reply(400,{});return
  raw=self.rfile.read(size)
  if self.path=='/__fixture/fault':
   with LOCK:FAULT=bool(json.loads(raw)['offline'])
   self.reply(200,{'offline':FAULT});return
  if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():self.reply(400,{});return
  try:
   root=ET.fromstring(raw);body=next(n for n in root.iter() if local(n.tag)=='Body');command=list(body)[0];action=local(command.tag);profile=text(command,'ProfileToken','main');source,config,motor=PROFILES[profile]
  except (ValueError,StopIteration,KeyError,ET.ParseError,IndexError):self.reply(400,{});return
  with LOCK:
   if FAULT:self.reply(503,{'error':'simulated_offline'});return
   data='';namespace=NS
   if action=='GetSystemDateAndTime':
    now=datetime.datetime.now(datetime.timezone.utc);namespace=DEVICE;data=f'<m:SystemDateAndTime><tt:UTCDateTime><tt:Time><tt:Hour>{now.hour}</tt:Hour><tt:Minute>{now.minute}</tt:Minute><tt:Second>{now.second}</tt:Second></tt:Time><tt:Date><tt:Year>{now.year}</tt:Year><tt:Month>{now.month}</tt:Month><tt:Day>{now.day}</tt:Day></tt:Date></tt:UTCDateTime></m:SystemDateAndTime>'
   elif action=='GetServices':
    namespace=DEVICE;data=''.join(f'<m:Service><m:Namespace>{ns}</m:Namespace><m:XAddr>{self.server.camera_url}/{path}</m:XAddr></m:Service>' for ns,path in [(MEDIA,'media'),(NS,'ptz')])
   elif action=='GetDeviceInformation':namespace=DEVICE;data='<m:Manufacturer>AINVR Test Fixture</m:Manufacturer><m:Model>Simulated PTZ NVR</m:Model><m:SerialNumber>fixture-only</m:SerialNumber><m:FirmwareVersion>1</m:FirmwareVersion><m:HardwareId>test</m:HardwareId>'
   elif action=='GetProfiles':
    namespace=MEDIA
    for token,(vs,cfg,_) in PROFILES.items():data+=f'<m:Profiles token="{token}"><tt:Name>{token}</tt:Name><tt:VideoSourceConfiguration><tt:SourceToken>{vs}</tt:SourceToken></tt:VideoSourceConfiguration><tt:VideoEncoderConfiguration><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>1920</tt:Width><tt:Height>1080</tt:Height></tt:Resolution><tt:RateControl><tt:FrameRateLimit>10</tt:FrameRateLimit></tt:RateControl></tt:VideoEncoderConfiguration>'+ (f'<tt:PTZConfiguration token="{cfg}"/>' if cfg else '')+'</m:Profiles>'
   elif action=='GetStreamUri':namespace=MEDIA;data=f'<m:MediaUri><tt:Uri>rtsp://{self.server.camera_ip}:28554/test/{profile}</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>false</tt:InvalidAfterReboot><tt:Timeout>PT0S</tt:Timeout></m:MediaUri>'
   elif action=='GetConfigurations':data=''.join(f'<m:PTZConfiguration token="{cfg}"><tt:NodeToken>{node}</tt:NodeToken></m:PTZConfiguration>' for _,cfg,node in PROFILES.values() if cfg)
   elif action=='GetConfiguration':
    token=text(command,'PTZConfigurationToken');node=next(v[2] for v in PROFILES.values() if v[1]==token);data=f'<m:PTZConfiguration token="{token}"><tt:NodeToken>{node}</tt:NodeToken></m:PTZConfiguration>'
   elif action=='GetNode':node=text(command,'NodeToken');data=f'<m:PTZNode token="{node}"><tt:MaximumNumberOfPresets>255</tt:MaximumNumberOfPresets></m:PTZNode>'
   elif action=='GetConfigurationOptions':
    cfg=text(command,'ConfigurationToken');pan='' if cfg=='config-z' else f'<tt:ContinuousPanTiltVelocitySpace><tt:URI>{PAN}</tt:URI><tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange><tt:YRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:YRange></tt:ContinuousPanTiltVelocitySpace>'
    data=f'<m:PTZConfigurationOptions><tt:Spaces>{pan}<tt:ContinuousZoomVelocitySpace><tt:URI>{ZOOM}</tt:URI><tt:XRange><tt:Min>-1</tt:Min><tt:Max>1</tt:Max></tt:XRange></tt:ContinuousZoomVelocitySpace></tt:Spaces><tt:PTZTimeout><tt:Min>PT0.1S</tt:Min><tt:Max>PT1.5S</tt:Max></tt:PTZTimeout></m:PTZConfigurationOptions>'
   elif action=='GetServiceCapabilities':data='<m:Capabilities StatusPosition="true" MoveStatus="true"/>'
   elif action=='GetStatus':
    moving=MOTORS[motor]['until']>time.monotonic();pan='' if motor=='motor-z' else f'<tt:PanTilt>{"MOVING" if moving else "IDLE"}</tt:PanTilt>';data=f'<m:PTZStatus><tt:Position>{vector(MOTORS[motor]["position"],motor=="motor-z")}</tt:Position><tt:MoveStatus>{pan}<tt:Zoom>{"MOVING" if moving else "IDLE"}</tt:Zoom></tt:MoveStatus></m:PTZStatus>'
   elif action in ['ContinuousMove','GotoPreset']:
    try:
     with urllib.request.urlopen(self.server.bff+'/__fixture/protection',timeout=3) as response:proof=json.load(response)
     expected=['ai-a','ai-b'] if motor=='motor-a' else ['ai-c'] if motor=='motor-c' else []
     if any(not any(r['channel_id']==i and r['state']=='paused' for r in proof['rules']) for i in expected):raise ValueError('rules not paused')
     if any(i not in proof['resetIds'] for i in expected):raise ValueError('analytics not reset')
    except Exception as error:
     EVENTS.append({'action':'PROTECTION_FAILURE','reason':str(error),'at':time.time()});self.reply(503,{'error':'protection_not_applied'});return
    if action=='ContinuousMove':
     for n in command.iter():
      if local(n.tag)=='PanTilt':MOTORS[motor]['position'][0]+=float(n.attrib['x'])*.1;MOTORS[motor]['position'][1]+=float(n.attrib['y'])*.1
      if local(n.tag)=='Zoom':MOTORS[motor]['position'][2]=max(0,min(1,MOTORS[motor]['position'][2]+float(n.attrib['x'])*.1))
     duration=float(text(command,'Timeout','PT1S')[2:-1]);MOTORS[motor]['until']=time.monotonic()+duration
    else:MOTORS[motor]['position']=list(MOTORS[motor]['presets'][text(command,'PresetToken')]['position']);MOTORS[motor]['until']=0
   elif action=='Stop':MOTORS[motor]['until']=0
   elif action=='GetPresets':
    for token,preset in MOTORS[motor]['presets'].items():data+=f'<m:Preset token="{token}"><tt:Name>{preset["name"]}</tt:Name><tt:PTZPosition>{vector(preset["position"],motor=="motor-z")}</tt:PTZPosition></m:Preset>'
   elif action=='SetPreset':
    token=text(command,'PresetToken') or 'saved-'+str(len(MOTORS[motor]['presets'])+1);MOTORS[motor]['presets'][token]={'name':text(command,'PresetName').replace('&','&amp;').replace('<','&lt;'),'position':list(MOTORS[motor]['position'])};data=f'<m:PresetToken>{token}</m:PresetToken>'
   elif action=='RemovePreset':MOTORS[motor]['presets'].pop(text(command,'PresetToken'),None)
   else:self.reply(422,{'error':'unsupported_fixture_operation'});return
   if action in ['ContinuousMove','Stop','GotoPreset','SetPreset','RemovePreset']:
    EVENTS.append({'action':action,'profile':profile,'motor':motor,'at':time.time(),'position':list(MOTORS[motor]['position'])});del EVENTS[:-1000]
   wire=f'<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:m="{namespace}" xmlns:tt="{TT}"><s:Body><m:{action}Response>{data}</m:{action}Response></s:Body></s:Envelope>'
   self.reply(200,wire,'application/soap+xml; charset=utf-8')
if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--host',required=True);parser.add_argument('--port',type=int,default=28551);parser.add_argument('--bff',default='http://127.0.0.1:28088');args=parser.parse_args()
 server=http.server.ThreadingHTTPServer((args.host,args.port),Handler);server.camera_url=f'http://{args.host}:{args.port}';server.camera_ip=args.host;server.bff=args.bff;print('PTZ fixture camera ready',flush=True);server.serve_forever()
