"""Independent test oracle: video packet identity and audio content correlation.

Uses NumPy from the board's system Python. It decodes audio only; compressed
video is hashed directly. Requires distinctive, non-periodic reference audio.
"""
import json,subprocess,hashlib,re
from collections import defaultdict
from pathlib import Path
import threading
import numpy as np
FFPROBE='/opt/ainvr/ffmpeg-8.1.2/bin/ffprobe'

def bounded_capture(command,limit,timeout):
    """Kill an oversized/stalled test probe before retaining its full output."""
    process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    expired=threading.Event()
    def expire():
        expired.set()
        if process.poll() is None:process.kill()
    timer=threading.Timer(timeout,expire);timer.daemon=True;timer.start()
    try:
        output=process.stdout.read(limit+1)
        assert len(output)<=limit,'test_oracle_output_limit'
        code=process.wait(timeout=2)
        assert not expired.is_set(),'test_oracle_probe_timeout'
        assert code==0,'test_oracle_probe_failed'
        return output
    finally:
        timer.cancel()
        if process.poll() is None:process.kill();process.wait(timeout=2)
        process.stdout.close()

def inspect(path):
    return json.loads(bounded_capture([FFPROBE,'-v','error','-show_entries','stream=codec_type,codec_name,start_time:format=duration,format_name','-of','json',str(path)],4*1024*1024,10))

def picture_hash(data,codec,kind):
    if kind=='a':return hashlib.sha256(data).hexdigest()
    # Container and RTP repacketization may insert AUD/parameter sets and
    # change length prefixes. Compare compressed picture NAL payload only.
    units=[];position=0
    while position+4<=len(data):
        size=int.from_bytes(data[position:position+4],'big');position+=4
        if not size or position+size>len(data):units=[];break
        units.append(data[position:position+size]);position+=size
    if not units or position!=len(data):units=[v for v in re.split(b'\x00\x00\x00?\x01',data) if v]
    slices=[u for u in units if u and ((u[0]>>1)&63)<=31] if codec=='hevc' else [u for u in units if u and (u[0]&31) in (1,5)]
    slices=[u.rstrip(b'\x00') for u in slices]
    return hashlib.sha256(b''.join(slices)).hexdigest() if slices else None

def packets(path,kind="v"):
    info=inspect(path)
    codec=next(s['codec_name'] for s in info['streams'] if s['codec_type']==('video' if kind=='v' else 'audio'))
    is_mp4='mp4' in info.get('format',{}).get('format_name','').split(',')
    fields=['-show_entries','packet=pts_time,pos,size'] if is_mp4 else ['-show_data','-show_entries','packet=pts_time,data']
    raw=bounded_capture([FFPROBE,'-v','error','-select_streams',kind,'-show_packets',*fields,'-of','json',str(path)],4*1024*1024 if is_mp4 else 64*1024*1024,25)
    entries=json.loads(raw)['packets']
    assert len(entries)<=20000,'test_oracle_packet_count_limit'
    result=[]
    def append(packet,data):
        digest=picture_hash(data,codec,kind)
        if digest:result.append({'pts_time':packet['pts_time'],'data_hash':digest})
    if is_mp4:
        # MP4 sample offsets point to exact compressed bytes. Avoid serializing
        # a whole high-rate movie as a many-times-larger JSON hexadecimal dump.
        size=Path(path).stat().st_size
        with Path(path).open('rb') as source:
            for packet in entries:
                offset,length=int(packet['pos']),int(packet['size'])
                assert 0<=offset and 0<length<=8*1024*1024 and offset+length<=size,'test_oracle_packet_range'
                source.seek(offset);data=source.read(length)
                assert len(data)==length,'test_oracle_packet_truncated'
                append(packet,data)
    else:
        for packet in entries:
            data=bytes.fromhex(''.join(line.split(':',1)[1].strip().split('  ',1)[0].replace(' ','') for line in packet['data'].splitlines() if ':' in line))
            append(packet,data)
    return result
def pcm(path):
    return np.frombuffer(subprocess.check_output(['/usr/bin/ffmpeg','-hide_banner','-loglevel','error','-i',str(path),'-vn','-map','0:a:0','-ar','4000','-ac','1','-f','f32le','pipe:1'],timeout=15),dtype='<f4').astype(float)
def video_timing_candidates(reference,actual):
    # An individual P-frame payload can repeat even in a changing scene.
    # Match consecutive compressed pictures, not isolated hash coincidences.
    # Full-GOP context also avoids averaging incompatible loop positions.
    width=min(25,max(3,len(actual)//3))
    indices=defaultdict(list)
    for i in range(len(reference)-width+1):
        key=tuple(p['data_hash'] for p in reference[i:i+width])
        indices[key].append(float(reference[i]['pts_time']))
    candidates=[]
    for i in range(len(actual)-width+1):
        key=tuple(p['data_hash'] for p in actual[i:i+width])
        # More than eight identical contexts cannot identify this position
        # reliably. Skip them rather than inventing a median alignment.
        if key in indices and len(indices[key])<=8:candidates.append([float(actual[i]['pts_time'])-t for t in indices[key]])
    assert len(candidates)>=10,'insufficient_contextual_video_identity_matches'
    return candidates
def audio_alignment(reference,actual):
    assert 0<len(actual)<=len(reference),'insufficient_audio_reference'
    width=len(actual);n=1<<(len(reference)+width-2).bit_length()
    corr=np.fft.irfft(np.fft.rfft(reference,n)*np.conj(np.fft.rfft(actual,n)),n)[:len(reference)-width+1]
    energy=np.r_[0.,np.cumsum(reference*reference)]
    denominator=np.sqrt(np.maximum(0,energy[width:]-energy[:-width]))*np.linalg.norm(actual)
    scores=corr/np.maximum(denominator,1e-10)
    position=int(np.argmax(scores))
    return position,float(scores[position])
def copied_audio_timing(source,target):
    # When AAC is copied, payload identity is stronger evidence than correlating
    # decoded tones. No window can accidentally align with a similar tone.
    source_audio=next(s for s in inspect(source)['streams'] if s['codec_type']=='audio')
    target_audio=next(s for s in inspect(target)['streams'] if s['codec_type']=='audio')
    if source_audio['codec_name']!='aac' or target_audio['codec_name']!='aac':return None
    reference=packets(source,'a');actual=packets(target,'a');indices=defaultdict(list)
    for p in reference:indices[p['data_hash']].append(float(p['pts_time']))
    matches=[(p['data_hash'],[float(p['pts_time'])-t for t in indices[p['data_hash']]]) for p in actual if p['data_hash'] in indices]
    if len({h for h,_ in matches})<16 or len(matches)<.8*len(actual):return None
    from collections import Counter
    mode=Counter(round(delta,2) for _,values in matches for delta in values).most_common(1)[0][0]
    audio=[min(values,key=lambda d:abs(d-mode)) for _,values in matches]
    if sum(abs(d-mode)<.03 for d in audio)<.95*len(audio):raise AssertionError('inconsistent_copied_audio_clock')
    video=[min(values,key=lambda d:abs(d-mode)) for values in video_timing_candidates(packets(source),packets(target))]
    video_delta=float(np.median(video))
    offsets=[d-video_delta for d in audio]
    return {'method':'identical_AAC_and_compressed_video_packet_timestamps','matched_audio_packets':len(audio),'matched_video_packets':len(video),'maximum_content_offset_seconds':max(abs(d) for d in offsets),'content_drift_seconds':max(offsets)-min(offsets)}

def compare(source,target):
    exact=copied_audio_timing(source,target)
    if exact is not None:return exact
    reference=pcm(source);actual=pcm(target)
    source_start=float(next(s for s in inspect(source)['streams'] if s['codec_type']=='audio')['start_time'])
    target_start=float(next(s for s in inspect(target)['streams'] if s['codec_type']=='audio')['start_time'])
    candidates=video_timing_candidates(packets(source),packets(target))
    width=4000;windows=[]
    assert len(actual)>=2*width,'insufficient_audio_duration'
    # Pick one consistent reference cycle for the complete capture first.
    # Independent one-second peaks can select different identical loop copies
    # and invent a full-cycle jump at the boundary.
    base,whole_score=audio_alignment(reference,actual)
    assert whole_score>.6,'audio_content_match_not_reliable'
    for offset in range(width//2,len(actual)-width+1,width):
        window=actual[offset:offset+width]
        begin=max(0,base+offset-width//2)
        end=min(len(reference),base+offset+width+width//2)
        position,score=audio_alignment(reference[begin:end],window)
        position+=begin
        assert score>.6,'audio_content_match_not_reliable'
        audio_delta=target_start+offset/4000-(source_start+position/4000)
        video_delta=float(np.median([min(v,key=lambda d:abs(d-audio_delta)) for v in candidates]))
        windows.append({'at_s':round(offset/4000,3),'correlation':round(score,4),'audio_minus_video_s':round(audio_delta-video_delta,4)})
    return {'method':'copied_video_packet_identity_and_distinctive_audio_correlation','matched_video_packets':len(candidates),'windows':windows,'maximum_content_offset_seconds':max(abs(w['audio_minus_video_s']) for w in windows),'content_drift_seconds':max(w['audio_minus_video_s'] for w in windows)-min(w['audio_minus_video_s'] for w in windows)}
if __name__=='__main__':
    import sys
    print(json.dumps(compare(sys.argv[1],sys.argv[2]),indent=2))
