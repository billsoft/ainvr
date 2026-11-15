import unittest
from types import SimpleNamespace
from unittest.mock import patch
from recorder.channels import ChannelManager


class InputProgressTests(unittest.TestCase):
    def test_zero_video_and_stalled_publisher_are_not_online(self):
        manager = ChannelManager(SimpleNamespace(get=lambda: SimpleNamespace(srs_api_url='http://localhost:1985')), None)
        stream = {'app':'live','name':'camera','publish':{'active':True,'cid':'one'},
                  'video':{'codec':'H264'},'frames':0}
        now = [10]
        with patch('recorder.channels._http_get_json', side_effect=lambda *_args: {'streams':[stream]}), \
             patch('recorder.channels.time.monotonic', side_effect=lambda: now[0]):
            self.assertEqual(manager._fetch_srs_streams(), {})
            stream['frames']=10
            self.assertTrue(manager._fetch_srs_streams())
            now[0]=26
            self.assertEqual(manager._fetch_srs_streams(), {})
            stream['frames']=11
            self.assertTrue(manager._fetch_srs_streams())
            stream['publish']['cid']='new'
            stream['frames']=1
            self.assertTrue(manager._fetch_srs_streams())

    def test_srt_publisher_progress_uses_received_bytes(self):
        # SRS 7.0.162 never counts frames for SRT publishers (frames stays 0 at 2 Mbps).
        manager = ChannelManager(SimpleNamespace(get=lambda: SimpleNamespace(srs_api_url='http://localhost:1985')), None)
        stream = {'app':'live','name':'srtcam','tcUrl':'srt://127.0.0.1/live','publish':{'active':True,'cid':'one'},
                  'video':{'codec':'HEVC'},'frames':0,'video_frames':0,'recv_bytes':1000}
        now = [10]
        with patch('recorder.channels._http_get_json', side_effect=lambda *_args: {'streams':[stream]}), \
             patch('recorder.channels.time.monotonic', side_effect=lambda: now[0]):
            self.assertIn('srtcam', manager._fetch_srs_streams())
            now[0]=20
            stream['recv_bytes']=500000
            self.assertIn('srtcam', manager._fetch_srs_streams())
            now[0]=36
            self.assertEqual(manager._fetch_srs_streams(), {})
            stream['recv_bytes']=0
            stream['publish']['cid']='two'
            self.assertEqual(manager._fetch_srs_streams(), {})

    def test_disappeared_publishers_release_progress_records(self):
        manager = ChannelManager(SimpleNamespace(get=lambda: SimpleNamespace(srs_api_url='http://localhost:1985')), None)
        stream = {'app': 'live', 'name': 'camera', 'publish': {'active': True, 'cid': 'one'},
                  'video': {'codec': 'H264'}, 'frames': 10}
        with patch('recorder.channels._http_get_json', return_value={'streams': [stream]}):
            self.assertTrue(manager._fetch_srs_streams())
        self.assertEqual(len(manager._video_progress), 1)
        with patch('recorder.channels._http_get_json', return_value={'streams': []}):
            self.assertEqual(manager._fetch_srs_streams(), {})
        self.assertEqual(manager._video_progress, {})


if __name__ == '__main__': unittest.main()
