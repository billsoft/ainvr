"""Publisher audit must distinguish lost SEI from harmless backpressure."""
import unittest
from measure_archive_pipeline import publisher_interval

def sample(late=0, dropped=0, unknown=0, shed=0, reconnects=0, pressure=0):
    return {'worker': {'publish': {'buffer': {'too_late':late,'dropped':dropped,'unknown':unknown},
        'au_shed':shed,'reconnect_count':reconnects,'pub_queue_full_events':pressure}}}

class PublisherAuditTest(unittest.TestCase):
    def test_empty_or_single_sample_is_not_a_clean_interval(self):
        for samples in ([], [sample()]):
            self.assertFalse(publisher_interval(samples, True)['clean'])

    def test_late_metadata_fails_even_without_video_loss(self):
        result=publisher_interval([sample(),sample(late=1)],True)
        self.assertFalse(result['clean'])
        self.assertEqual(result['deltas']['au_dropped'],0)
        self.assertEqual(result['deltas']['sei_too_late'],1)
    def test_uses_interval_deltas_not_lifetime_incidents(self):
        self.assertTrue(publisher_interval([sample(late=7),sample(late=7)],True)['clean'])
    def test_startup_missing_publisher_is_not_a_clean_observation(self):
        self.assertFalse(publisher_interval([{'worker':{}},sample()],True)['clean'])
    def test_counter_reset_invalidates_window(self):
        self.assertFalse(publisher_interval([sample(late=7),sample()],True)['continuous'])
    def test_backpressure_is_not_packet_loss(self):
        self.assertTrue(publisher_interval([sample(),sample(pressure=10)],True)['clean'])
    def test_disabled_output_does_not_require_publisher(self):
        self.assertTrue(publisher_interval([{'worker':{}}],False)['clean'])

if __name__=='__main__':unittest.main()
