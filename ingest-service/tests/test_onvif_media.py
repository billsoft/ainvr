import importlib.util
import pathlib
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location('onvif_ingest', pathlib.Path(__file__).parents[1] / 'main.py')
ingest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ingest)
from async_launch import AsyncLauncher
from media_policy import AudioBudget, MediaError, audio_policy, error_code


class OnvifMediaTests(unittest.TestCase):
    def test_audio_copy_conversion_and_explicit_degradation(self):
        args, warning, uses_slot = audio_policy('aac')
        self.assertIn('copy', args)
        self.assertIsNone(warning)
        self.assertFalse(uses_slot)
        for codec in ('pcm_alaw', 'pcm_mulaw', 'adpcm_g726', 'adpcm_g726le'):
            args, warning, uses_slot = audio_policy(codec)
            self.assertIn('aac', args)
            self.assertTrue(uses_slot)
            self.assertIsNone(warning)
        self.assertEqual(audio_policy('opus'), (['-an'], 'unsupported_audio_codec', False))
        self.assertEqual(audio_policy(None), (['-an'], 'no_audio', False))

    def test_audio_budget_never_overallocates(self):
        budget = AudioBudget(2)
        self.assertTrue(budget.acquire())
        self.assertTrue(budget.acquire())
        self.assertFalse(budget.acquire())
        budget.release()
        self.assertTrue(budget.acquire())

    def test_slow_connect_does_not_block_and_late_process_is_stopped(self):
        entered, release, stopped = threading.Event(), threading.Event(), threading.Event()
        class Process:
            def stop(self):
                stopped.set()
        def slow(_config):
            entered.set()
            self.assertTrue(release.wait(2))
            return Process()
        launcher = AsyncLauncher(slow, workers=1, capacity=1)
        try:
            start = time.monotonic()
            deferred = launcher.launch({})
            self.assertLess(time.monotonic() - start, .5)
            self.assertTrue(entered.wait(1))
            with self.assertRaises(RuntimeError):
                launcher.launch({})
            deferred.stop()
            release.set()
            self.assertTrue(stopped.wait(2))
        finally:
            release.set()
            launcher.close()

    def test_wrong_password_blocks_retries_until_configuration_changes(self):
        class Process:
            last_video = 0
            frames = 0
            started = 0
            error_code = 'authentication_failed'
            def poll(self):
                return 1
            def stop(self):
                pass
        calls = []
        def launch(config):
            calls.append(config['generation'])
            return Process()
        supervisor = ingest.Supervisor(launch=launch, clock=lambda: 10)
        config = dict(id='camera', generation='1', source='rtsp://camera/video', app='live', stream='a')
        supervisor.reconcile([config], True)
        supervisor.reconcile([config], True)
        supervisor.reconcile([config], True)
        self.assertEqual(calls, ['1'])
        self.assertEqual(supervisor.status()['camera']['state'], 'blocked')
        supervisor.reconcile([{**config, 'generation': '2'}], True)
        self.assertEqual(calls, ['1', '2'])

    def test_diagnostics_classify_without_returning_device_credentials(self):
        secret = 'rtsp://admin:private@camera/video: 401 Unauthorized'
        self.assertEqual(error_code(secret), 'authentication_failed')
        self.assertEqual(str(MediaError(error_code(secret))), 'authentication_failed')


if __name__ == '__main__':
    unittest.main()


class HotAudioBudgetTests(unittest.TestCase):
    def test_reduction_keeps_live_slots_and_prevents_new_allocations(self):
        budget = AudioBudget(2)
        self.assertTrue(budget.acquire())
        self.assertTrue(budget.acquire())
        budget.configure(0)
        self.assertFalse(budget.acquire())
        budget.release()
        budget.release()
        budget.configure(1)
        self.assertTrue(budget.acquire())
        self.assertFalse(budget.acquire())


class AudioFailureIsolationTests(unittest.TestCase):
    def test_audio_encoder_failure_restarts_video_without_repeat_audio_attempts(self):
        class Process:
            last_video = 10
            frames = 0
            started = 0
            error_code = 'audio_processing_failed'
            def poll(self): return 1
            def stop(self): pass
        calls=[]
        def launch(config):
            calls.append(config)
            return Process()
        supervisor=ingest.Supervisor(launch=launch,clock=lambda:10)
        config=dict(id='camera',generation='1',audioMode='auto')
        for _ in range(3): supervisor.reconcile([config],True)
        self.assertEqual([c['audioMode'] for c in calls],['auto','off'])
        self.assertTrue(calls[-1]['audioFallback'])
        supervisor.reconcile([{**config,'generation':'2'}],True)
        self.assertEqual(calls[-1]['audioMode'],'auto')


class RuntimeUriLeaseTests(unittest.TestCase):
    def test_one_use_uri_is_renewed_between_probe_and_stream(self):
        import io,os
        from unittest.mock import patch
        leases=iter([{'source':'rtsp://192.0.2.10/probe','allowedCIDRs':['192.0.2.0/24'],'refreshAfterProbe':True},
                     {'source':'rtsp://192.0.2.10/stream','allowedCIDRs':['192.0.2.0/24'],'refreshAfterProbe':True}])
        observed=[]
        def inspect_fd(fd):
            os.lseek(fd,0,os.SEEK_SET)
            text=os.read(fd,8192).decode()
            os.lseek(fd,0,os.SEEK_SET)
            return text
        def probe(args,fd,**kwargs):
            observed.append(inspect_fd(fd));return 'h264','aac'
        class Process:
            stdout=io.StringIO('frame=1\n')
            stderr=io.StringIO('')
            def poll(self):return 0
        def popen(args,**kwargs):
            observed.append(inspect_fd(kwargs['pass_fds'][0]));return Process()
        with patch.object(ingest,'probe',side_effect=probe),patch.object(ingest.subprocess,'Popen',side_effect=popen):
            process=ingest.CopyProcess({'id':'camera','generation':'1','onvif':True,'audioMode':'auto','app':'live','stream':'test'},resolver=lambda c,deadline:next(leases))
            process.stop()
        self.assertIn('/probe',observed[0]);self.assertIn('/stream',observed[1]);self.assertNotIn('/probe',observed[1])

    def test_worker_pins_only_addresses_inside_the_onvif_network_policy(self):
        self.assertEqual(ingest.validate_source('rtsp://192.0.2.10/video',resolve=True,allowed_cidrs=['192.0.2.99/24']),'rtsp://192.0.2.10:554/video')
        with self.assertRaises(MediaError):ingest.validate_source('rtsp://198.51.100.10/video',resolve=True,allowed_cidrs=['192.0.2.0/24'])


class RedirectDiagnosticTests(unittest.TestCase):
    def test_rtsp_redirect_policy_has_an_actionable_error(self):
        self.assertEqual(error_code('AINVR RTSP redirect denied'), 'redirect_not_allowed')


class ProbeTimingTests(unittest.TestCase):
    def test_probe_time_does_not_expire_new_publisher_idle_deadline(self):
        import io
        from unittest.mock import patch
        clock=[100.]
        def probe(*args,**kwargs):
            clock[0]+=12
            return 'h264','aac'
        class Process:
            stdout=io.StringIO('')
            stderr=io.StringIO('')
            def poll(self):return 0
        with patch.object(ingest.time,'monotonic',side_effect=lambda:clock[0]),patch.object(ingest,'probe',side_effect=probe),patch.object(ingest.subprocess,'Popen',return_value=Process()):
            process=ingest.CopyProcess({'source':'rtsp://192.0.2.10/video','app':'live','stream':'test','audioMode':'auto'})
            self.assertEqual(process.started,112.)
            self.assertEqual(process.last_video,112.)
            process.stop()


class ConnectorQueueTests(unittest.TestCase):
    def test_queue_pressure_waits_without_counting_camera_failures(self):
        from async_launch import ConnectionCapacity
        calls=[]
        def busy(config):
            calls.append(config)
            raise ConnectionCapacity('busy')
        now=[0.]
        supervisor=ingest.Supervisor(launch=busy,clock=lambda:now[0])
        config={'id':'waiting','generation':'1'}
        for i in range(20):
            now[0]=i
            supervisor.reconcile([config],True,32)
        state=supervisor.status()['waiting']
        self.assertEqual(state['state'],'waiting')
        self.assertIsNone(state['error'])
        self.assertEqual(state['retries'],0)
        self.assertEqual(len(calls),20)
