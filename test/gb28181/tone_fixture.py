import math
import struct
import wave
import audioop
from pathlib import Path
root=Path(__file__).resolve().parents[2]
with wave.open(str(root/'out/gb28181/tone.wav'),'wb') as w:
    w.setparams((1,2,16000,0,'NONE','not compressed'))
    w.writeframes(b''.join(struct.pack('<h',int(3000*math.sin(2*math.pi*440*i/16000))) for i in range(96000)))
pcm=b''.join(struct.pack('<h',int(3000*math.sin(2*math.pi*440*i/8000))) for i in range(48000))
(root/'out/gb28181/tone.alaw').write_bytes(audioop.lin2alaw(pcm,2))
(root/'out/gb28181/tone.mulaw').write_bytes(audioop.lin2ulaw(pcm,2))
