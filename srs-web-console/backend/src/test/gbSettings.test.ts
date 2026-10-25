import {describe,it,expect} from 'vitest';
import {defaultGBSettings,gbSettingsSchema,gbDeviceSchema} from '../store/gbSettings.js';

describe('GB gateway configuration boundaries',()=>{
  it('starts disabled without changing existing input configuration',()=>{
    expect(gbSettingsSchema.parse(defaultGBSettings).enabled).toBe(false);
  });
  it('rejects plaintext remote management and embedded credentials',()=>{
    for(const gatewayUrl of ['http://192.168.1.1:8096','http://user:secret@127.0.0.1:8096','http://127.0.0.1:8096/?token=a'])
      expect(gbSettingsSchema.safeParse({...defaultGBSettings,gatewayUrl}).success).toBe(false);
  });
  it('bounds media capacity and prevents port overlap',()=>{
    for(const value of [{capacity:5},{mediaPortStart:30001},{mediaPortEnd:30004},{sipPort:30000}])
      expect(gbSettingsSchema.safeParse({...defaultGBSettings,...value}).success).toBe(false);
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
