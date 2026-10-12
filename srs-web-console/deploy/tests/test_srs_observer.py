import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import io
import json

spec = importlib.util.spec_from_file_location('observer', Path(__file__).resolve().parents[1] / 'srs-observer.py')
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)

def sample(cid='a', count=10):
    return {'api': {'ok': True, 'ms': 2, 'streams': {'one': {
                'vhost': 'default', 'app': 'live', 'name': 'camera',
                'cid': cid, 'active': True, 'recv_bytes': count}}},
            'sample_gap_ms': 1000}

class ObserverTest(unittest.TestCase):
    def test_fetch_retains_virtual_host_for_session_identity(self):
        body = {'code': 0, 'streams': [{
            'id': 'internal-id', 'vhost': 'host-id', 'app': 'live',
            'name': 'camera', 'publish': {'cid': 'publisher', 'active': True}}]}
        with patch.object(observer.OPENER, 'open',
                          return_value=io.BytesIO(json.dumps(body).encode())):
            fetched = observer.fetch_streams()
        self.assertTrue(fetched['ok'])
        self.assertEqual(fetched['streams']['internal-id']['vhost'], 'host-id')

    def test_normal_bytes_do_not_trigger(self):
        self.assertEqual(observer.triggers(sample(), sample(count=20)), [])
    def test_republish_and_disappearance(self):
        self.assertEqual(observer.triggers(sample(), sample('b')), ['publisher_changed'])
        gone = sample(); gone['api']['streams'] = {}
        self.assertIn('publisher_changed', observer.triggers(sample(), gone))
    def test_timeout_not_reported_as_publisher_change(self):
        failed = {'api': {'ok': False, 'ms': 700}, 'sample_gap_ms': 2100}
        self.assertEqual(observer.triggers(sample(), failed), ['api_unreachable', 'observer_schedule_delayed'])
        self.assertEqual(observer.triggers(failed, sample()), [])
    def test_slow_success_and_startup(self):
        slow = sample(); slow['api']['ms'] = 220
        self.assertEqual(observer.triggers(None, slow), ['api_slow'])

    def test_offline_stream_churn_does_not_trigger(self):
        previous = sample()
        current = sample(count=20)
        previous['api']['streams']['old-reader-id'] = {
            'vhost': 'default', 'app': 'live', 'name': 'offline',
            'cid': 'stale-publisher', 'active': False}
        current['api']['streams']['new-reader-id'] = {
            'vhost': 'default', 'app': 'live', 'name': 'offline',
            'cid': None, 'active': False}
        self.assertEqual(observer.triggers(previous, current), [])

    def test_offline_stream_creation_and_removal_do_not_trigger(self):
        offline = sample()
        offline['api']['streams']['reader-only'] = {
            'vhost': 'default', 'app': 'live', 'name': 'offline',
            'active': False}
        self.assertEqual(observer.triggers(sample(), offline), [])
        self.assertEqual(observer.triggers(offline, sample()), [])

    def test_internal_stream_id_change_keeps_same_publisher(self):
        current = sample()
        current['api']['streams']['new-id'] = current['api']['streams'].pop('one')
        self.assertEqual(observer.triggers(sample(), current), [])

    def test_publisher_stop_and_resume_are_still_detected(self):
        offline = sample()
        offline['api']['streams']['one']['active'] = False
        self.assertEqual(observer.triggers(sample(), offline), ['publisher_changed'])
        self.assertEqual(observer.triggers(offline, sample()), ['publisher_changed'])

    def test_no_valid_publisher_id_is_ignored(self):
        empty = sample()
        empty['api']['streams'] = {}
        self.assertEqual(observer.triggers(empty, sample(cid=None)), [])
        self.assertEqual(observer.triggers(empty, sample(cid='')), [])

    def test_stream_names_are_scoped_by_app_and_vhost(self):
        previous = sample()
        previous['api']['streams']['two'] = dict(
            previous['api']['streams']['one'], app='other', cid='b')
        previous['api']['streams']['three'] = dict(
            previous['api']['streams']['one'], vhost='other', cid='c')
        for stream_id in ['one', 'two', 'three']:
            with self.subTest(stream_id=stream_id):
                current = sample()
                current['api']['streams'] = {
                    k: dict(v) for k, v in previous['api']['streams'].items()}
                current['api']['streams'][stream_id]['cid'] = 'changed'
                self.assertEqual(observer.triggers(previous, current), ['publisher_changed'])

    def test_offline_only_changes_preserve_other_diagnostic_triggers(self):
        previous = sample()
        previous['api']['streams'] = {}
        current = sample()
        current['api']['streams']['one']['active'] = False
        current['api']['ms'] = 220
        current['sample_gap_ms'] = 2100
        self.assertEqual(observer.triggers(previous, current),
                         ['api_slow', 'observer_schedule_delayed'])

    def test_incident_excludes_stale_and_future_packets(self):
        events = [{'wall': 1, 'event': 'old RST'},
                  {'wall': 950, 'event': 'recent FIN'},
                  {'wall': 1001, 'event': 'future'}]
        self.assertEqual(observer.recent_tcp_events(events, 1000), [events[1]])

    def test_delayed_tcpdump_output_uses_packet_time(self):
        events = [{'wall': 1000, 'event': '1.0 eth0 In IP stale packet'},
                  {'wall': 1000, 'event': '999.0 eth0 In IP fresh packet'}]
        self.assertEqual(observer.recent_tcp_events(events, 1000), [events[1]])

    def test_incident_payload_is_bounded(self):
        events = [{'wall': 999, 'event': str(i)} for i in range(100)]
        # Non-packet diagnostic messages use their collection time.
        for event in events:
            event['event'] = 'diagnostic ' + event['event']
        self.assertEqual(len(observer.recent_tcp_events(events, 1000)), 40)

if __name__ == '__main__': unittest.main()
