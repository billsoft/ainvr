import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('ingest', pathlib.Path(__file__).parents[1] / 'main.py')
ingest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ingest)


class FakeProcess:
    def __init__(self):
        self.stopped = False
        self.last_video = 10
        self.frames = 1
        self.started = 10

    def poll(self):
        return 0 if self.stopped else None

    def stop(self):
        self.stopped = True


class SupervisorTests(unittest.TestCase):
    def test_reconfigure_stops_old_before_starting_replacement(self):
        created = []
        def launch(config):
            if created:
                self.assertTrue(created[-1].stopped)
            created.append(FakeProcess())
            return created[-1]
        sup = ingest.Supervisor(launch=launch, clock=lambda: 10)
        c = dict(id='a', generation='1', source='rtsp://camera/a', app='live', stream='a')
        sup.reconcile([c], True)
        sup.reconcile([{**c, 'generation': '2'}], True)
        self.assertEqual(len(created), 2)
        sup.reconcile([], True)
        self.assertTrue(created[-1].stopped)

    def test_stalled_process_retries_with_backoff_without_blocking_other_channel(self):
        now = [10]
        sup = ingest.Supervisor(launch=lambda c: FakeProcess(), clock=lambda: now[0])
        cs = [dict(id=x, generation='1', source='rtsp://camera/'+x, app='live', stream=x) for x in ['a', 'b']]
        sup.reconcile(cs, True)
        now[0] = 50
        sup.jobs['b']['process'].last_video = 50
        sup.reconcile(cs, True)
        self.assertIsNone(sup.jobs['a']['process'])
        self.assertIsNotNone(sup.jobs['b']['process'])
        self.assertGreater(sup.jobs['a']['next_retry'], 50)

    def test_license_stop_and_capacity_apply(self):
        sup = ingest.Supervisor(launch=lambda c: FakeProcess(), clock=lambda: 10)
        cs = [dict(id=x, generation='1', source='rtsp://camera/'+x, app='live', stream=x) for x in ['a', 'b']]
        sup.reconcile(cs, True, max_channels=1)
        self.assertEqual(sum(j['process'] is not None for j in sup.jobs.values()), 1)
        sup.reconcile(cs, False)
        self.assertTrue(all(j['process'] is None for j in sup.jobs.values()))

    def test_url_rejects_non_video_and_metadata_but_allows_private_camera(self):
        for value in ['http://camera/live', 'rtsp://169.254.169.254/live', 'rtsp://127.0.0.1/live', 'rtsp://camera/live\n-x']:
            with self.assertRaises(ValueError):
                ingest.validate_source(value)
        self.assertEqual(ingest.validate_source('rtsp://192.168.100.159:554/live'), 'rtsp://192.168.100.159:554/live')

    def test_ffmpeg_preserves_encoding_and_has_bounded_timeouts(self):
        c = dict(source='rtsp://camera/a', app='live', stream='a', transport='tcp')
        args = ingest.command(c)
        self.assertIn('copy', args)
        self.assertIn('-rw_timeout', args)
        self.assertEqual(args[-1], 'rtmp://127.0.0.1:1935/live/a')

    def test_private_input_hides_credentials_and_quotes_manifest(self):
        c = dict(source="rtsp://user:secret@192.168.1.1/cam'era", app='live', stream='a')
        args, manifest = ingest.private_input(c, 12)
        self.assertNotIn('secret', ' '.join(args))
        self.assertNotIn('-/i', args)
        self.assertEqual(args[args.index('-auto_convert') + 1], '0')
        self.assertIn('/proc/self/fd/12', args)
        self.assertIn(b"cam'\\''era", manifest)
        self.assertIn(b'option rtsp_transport tcp', manifest)


if __name__ == '__main__':
    unittest.main()
