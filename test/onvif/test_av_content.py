"""Test-only timing oracle: repeated P frames must not create false offsets."""
import statistics
import unittest
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
import numpy as np
from av_content import video_timing_candidates,audio_alignment,picture_hash,packets,bounded_capture


class BoundedPacketIdentity(unittest.TestCase):
    def test_h264_and_hevc_container_framing_is_ignored(self):
        for codec,header,picture in [('h264',b'\x67sps',b'\x65picture'),('hevc',b'\x40\x01vps',b'\x02\x01picture')]:
            avcc=len(header).to_bytes(4,'big')+header+len(picture+b'\0\0').to_bytes(4,'big')+picture+b'\0\0'
            annex=b'\0\0\0\1'+header+b'\0\0\1'+picture
            self.assertEqual(picture_hash(avcc,codec,'v'),picture_hash(annex,codec,'v'))

    def test_mp4_uses_exact_sample_offset(self):
        picture=b'\x65identity';sample=len(picture).to_bytes(4,'big')+picture
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'sample.mp4';source.write_bytes(b'container'+sample+b'other-track')
            info={'streams':[{'codec_type':'video','codec_name':'h264'}],'format':{'format_name':'mov,mp4,m4a'}}
            metadata=json.dumps({'packets':[{'pts_time':'1.0','pos':'9','size':str(len(sample))}]}).encode()
            with patch('av_content.inspect',return_value=info),patch('av_content.bounded_capture',return_value=metadata):
                self.assertEqual(packets(source),[{'pts_time':'1.0','data_hash':picture_hash(sample,'h264','v')}])
            metadata=json.dumps({'packets':[{'pts_time':'1.0','pos':'9000','size':'3'}]}).encode()
            with patch('av_content.inspect',return_value=info),patch('av_content.bounded_capture',return_value=metadata):
                with self.assertRaisesRegex(AssertionError,'packet_range'):packets(source)

    def test_oversized_probe_output_is_stopped(self):
        with self.assertRaisesRegex(AssertionError,'output_limit'):
            bounded_capture([sys.executable,'-c','print("x"*65536)'],16,2)

    def test_stalled_probe_is_stopped(self):
        with self.assertRaisesRegex(AssertionError,'probe_timeout'):
            bounded_capture([sys.executable,'-c','import time;time.sleep(2)'],16,.1)


class ContextualVideoIdentity(unittest.TestCase):
    def test_loop_boundary_with_repeated_p_frames(self):
        cycle = ['key-'+str(i//25) if i%25 == 0 else 'same-p-frame' for i in range(600)]
        source = [{'pts_time': str(i/25), 'data_hash': cycle[i%600]} for i in range(1800)]
        actual = [{'pts_time': str(i/25), 'data_hash': cycle[(i+500)%600]} for i in range(200)]
        candidates = video_timing_candidates(source, actual)
        for audio_delta in [-20, -44]:
            video_delta = statistics.median(min(values,key=lambda v:abs(v-audio_delta)) for values in candidates)
            self.assertAlmostEqual(video_delta, audio_delta)
            shifted_audio_delta = audio_delta+.5
            shifted_video = statistics.median(min(values,key=lambda v:abs(v-shifted_audio_delta)) for values in candidates)
            self.assertAlmostEqual(shifted_audio_delta-shifted_video, .5)

    def test_unrelated_video_is_rejected(self):
        source = [{'pts_time': str(i), 'data_hash': 'source-'+str(i)} for i in range(100)]
        target = [{'pts_time': str(i), 'data_hash': 'other-'+str(i)} for i in range(100)]
        with self.assertRaisesRegex(AssertionError, 'insufficient_contextual'):
            video_timing_candidates(source,target)

    def test_audio_capture_crossing_loop_selects_one_complete_cycle(self):
        cycle=np.random.default_rng(28181).normal(size=6000)
        reference=np.tile(cycle,3)
        actual=np.r_[cycle[5000:],cycle[:1000]]
        position,score=audio_alignment(reference,actual)
        self.assertIn(position,[5000,11000])
        self.assertGreater(score,.999)


if __name__ == '__main__':
    unittest.main()
