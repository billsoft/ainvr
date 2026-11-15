import {describe,it,expect} from 'vitest';
import {boardCapacityLimit,defaultGBSettings,gbSettingsSchema,gbDeviceSchema,lanAddresses} from '../store/gbSettings.js';

describe('GB gateway configuration boundaries',()=>{
  it('starts disabled without changing existing input configuration',()=>{
    expect(gbSettingsSchema.parse(defaultGBSettings).enabled).toBe(false);
  });
  it('rejects plaintext remote management and embedded credentials',()=>{
    for(const gatewayUrl of ['http://192.168.1.1:8096','http://user:secret@127.0.0.1:8096','http://127.0.0.1:8096/?token=a'])
      expect(gbSettingsSchema.safeParse({...defaultGBSettings,gatewayUrl}).success).toBe(false);
  });
  it('bounds media capacity and prevents port overlap',()=>{
    for(const value of [{capacity:17},{capacity:0},{mediaPortStart:30001},{mediaPortEnd:30004},{sipPort:30000},{capacity:16,mediaPortEnd:30030}])
      expect(gbSettingsSchema.safeParse({...defaultGBSettings,...value}).success).toBe(false);
    expect(gbSettingsSchema.safeParse({...defaultGBSettings,capacity:16}).success).toBe(true);
  });
  it('limits concurrent GB streams by board',()=>{
    expect(boardCapacityLimit('D-Robotics RDK S100P V1P0\0','')).toBe(16);
    expect(boardCapacityLimit('D-Robotics RDK S100 V1P1\0','')).toBe(8);
    expect(boardCapacityLimit('NVIDIA Jetson Orin NX','')).toBe(4);
    expect(boardCapacityLimit('D-Robotics RDK S100 V1P1','6')).toBe(6);
    expect(boardCapacityLimit('','99')).toBe(16);
  });
  it('offers this host\'s LAN addresses, not loopback, link-local or container bridges',()=>{
    const v4=(address:string,internal=false)=>({address,family:'IPv4',internal,netmask:'255.255.255.0',mac:'00:00:00:00:00:00',cidr:null});
    expect(lanAddresses({lo:[v4('127.0.0.1',true)],eth0:[v4('192.168.100.190'),{...v4('fe80::1'),family:'IPv6'}],docker0:[v4('172.17.0.1')],wlan0:[v4('169.254.3.4'),v4('192.168.1.20')]} as never))
      .toEqual(['192.168.100.190','192.168.1.20']);
  });
  it('does not accept unknown fields or invalid device identity',()=>{
    expect(gbSettingsSchema.safeParse({...defaultGBSettings,ffmpeg:'/tmp/command'}).success).toBe(false);
    expect(gbDeviceSchema.safeParse({id:'short',name:'Camera',version:'auto',enabled:true}).success).toBe(false);
    expect(gbDeviceSchema.safeParse({id:'34020000001320000001',name:'Camera',version:'2022',enabled:true,password:'password'}).success).toBe(true);
  });
});

it('requires explicit unicast device media addresses and bounds their count',()=>{
 const device={id:'34020000001320000001',name:'NVR',version:'2022',enabled:true};
 expect(gbDeviceSchema.parse(device).mediaIPs).toEqual([]);
 expect(gbDeviceSchema.safeParse({...device,mediaIPs:['192.0.2.25']}).success).toBe(true);
 for(const ip of ['127.0.0.1','169.254.169.254','224.0.0.1','0.0.0.0','::1'])
  expect(gbDeviceSchema.safeParse({...device,mediaIPs:[ip]}).success).toBe(false);
 expect(gbDeviceSchema.safeParse({...device,mediaIPs:Array(9).fill('192.0.2.25')}).success).toBe(false);
});
