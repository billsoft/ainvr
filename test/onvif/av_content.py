"""Independent test oracle: video packet identity and audio content correlation.

Uses NumPy from the board's system Python. It decodes audio only; compressed
video is hashed directly. Requires distinctive, non-periodic reference audio.
"""
import json,subprocess,hashlib,re
from collections import defaultdict
import numpy as np
FFPROBE='/opt/ainvr/ffmpeg-8.1.2/bin/ffprobe'
def inspect(path):
    return json.loads(subprocess.check_output([FFPROBE,'-v','error','-show_entries','stream=codec_type,codec_name,start_time:format=duration','-of','json',str(path)],timeout=10))
def packets(path,kind="v"):
    codec=next(s['codec_name'] for s in inspect(path)['streams'] if s['codec_type']==('video' if kind=='v' else 'audio'))
    raw=subprocess.check_output([FFPROBE,'-v','error','-select_streams',kind,'-show_packets','-show_data','-show_entries','packet=pts_time,data','-of','json',str(path)],timeout=25)
    assert len(raw)<256*1024*1024,'test_oracle_packet_limit'
    result=[]
    for packet in json.loads(raw)['packets']:
        data=bytes.fromhex(''.join(line.split(':',1)[1].strip().split('  ',1)[0].replace(' ','') for line in packet['data'].splitlines() if ':' in line))
        if kind=='a':
            result.append({'pts_time':packet['pts_time'],'data_hash':hashlib.sha256(data).hexdigest()});continue
        # Container and RTP repacketization may insert AUD/parameter sets and
        # change length prefixes. Compare compressed picture NAL payload only.
        units=[];position=0
        while position+4<=len(data):
            size=int.from_bytes(data[position:position+4],'big');position+=4
            if not size or position+size>len(data):units=[];break
            units.append(data[position:position+size]);position+=size
        if not units or position!=len(data):units=[v for v in re.split(b'\x00\x00\x00?\x01',data) if v]
        slices=[u for u in units if u and ((u[0]>>1)&63)<=31] if codec=='hevc' else [u for u in units if u and (u[0]&31) in (1,5)]
        # Annex-B may carry trailing_zero_8bits/cabac_zero_word outside the
        # compressed picture payload; stream-copy remuxers normalize it.
        slices=[u.rstrip(b'\x00') for u in slices]
        if slices:result.append({'pts_time':packet['pts_time'],'data_hash':hashlib.sha256(b''.join(slices)).hexdigest()})
    return result
def pcm(path):
    return np.frombuffer(subprocess.check_output(['/usr/bin/ffmpeg','-hide_banner','-loglevel','error','-i',str(path),'-vn','-map','0:a:0','-ar','4000','-ac','1','-f','f32le','pipe:1'],timeout=15),dtype='<f4').astype(float)
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
    video_indices=defaultdict(list)
    for p in packets(source):video_indices[p['data_hash']].append(float(p['pts_time']))
    video=[min([float(p['pts_time'])-t for t in video_indices[p['data_hash']]],key=lambda d:abs(d-mode)) for p in packets(target) if p['data_hash'] in video_indices]
    assert len(video)>=10,'insufficient_video_identity_matches'
    video_delta=float(np.median(video))
    offsets=[d-video_delta for d in audio]
    return {'method':'identical_AAC_and_compressed_video_packet_timestamps','matched_audio_packets':len(audio),'matched_video_packets':len(video),'maximum_content_offset_seconds':max(abs(d) for d in offsets),'content_drift_seconds':max(offsets)-min(offsets)}

def compare(source,target):
    exact=copied_audio_timing(source,target)
    if exact is not None:return exact
    reference=pcm(source);actual=pcm(target)
    source_start=float(next(s for s in inspect(source)['streams'] if s['codec_type']=='audio')['start_time'])
    target_start=float(next(s for s in inspect(target)['streams'] if s['codec_type']=='audio')['start_time'])
    hashes=defaultdict(list)
    for p in packets(source): hashes[p['data_hash']].append(float(p['pts_time']))
    candidates=[[float(p['pts_time'])-t for t in hashes[p['data_hash']]] for p in packets(target) if p.get('data_hash') in hashes]
    assert len(candidates)>=10,'insufficient_video_identity_matches'
    width=4000;windows=[]
    assert len(actual)>=2*width,'insufficient_audio_duration'
    for offset in range(width//2,len(actual)-width+1,width):
        window=actual[offset:offset+width]
        n=1<<(len(reference)+width-2).bit_length()
        corr=np.fft.irfft(np.fft.rfft(reference,n)*np.conj(np.fft.rfft(window,n)),n)[:len(reference)-width+1]
        energy=np.r_[0.,np.cumsum(reference*reference)]
        denominator=np.sqrt(np.maximum(0,energy[width:]-energy[:-width]))*np.linalg.norm(window)
        scores=corr/np.maximum(denominator,1e-10)
        position=int(np.argmax(scores));score=float(scores[position])
        assert score>.6,'audio_content_match_not_reliable'
        audio_delta=target_start+offset/4000-(source_start+position/4000)
        video_delta=float(np.median([min(v,key=lambda d:abs(d-audio_delta)) for v in candidates]))
        windows.append({'at_s':round(offset/4000,3),'correlation':round(score,4),'audio_minus_video_s':round(audio_delta-video_delta,4)})
    return {'method':'copied_video_packet_identity_and_distinctive_audio_correlation','matched_video_packets':len(candidates),'windows':windows,'maximum_content_offset_seconds':max(abs(w['audio_minus_video_s']) for w in windows),'content_drift_seconds':max(w['audio_minus_video_s'] for w in windows)-min(w['audio_minus_video_s'] for w in windows)}
if __name__=='__main__':
    import sys
    print(json.dumps(compare(sys.argv[1],sys.argv[2]),indent=2))
