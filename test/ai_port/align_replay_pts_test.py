import unittest
from align_replay_pts import frame_times, align
import json

class TimelineTests(unittest.TestCase):
    def test_25fps_and_variable_intervals(self):
        p={"streams":[{"time_base":"1/12800"}],"frames":[{"best_effort_timestamp":v} for v in [1024,1536,2560]]}
        self.assertEqual(frame_times(p),[0,40000000,120000000])
        rows=[json.dumps({"frame_index":i,"frame_pts_ns":i*33333333}) for i in range(3)]
        self.assertEqual([json.loads(x)["frame_pts_ns"] for x in align(iter(rows),frame_times(p))],
                         [0,40000000,120000000])
    def test_mismatched_cache_rejected(self):
        for rows in [[],['{"frame_index":1}'],['{"frame_index":0}','{"frame_index":1}']]:
            with self.assertRaises(ValueError): list(align(iter(rows),[0]))
    def test_duplicate_or_backward_pts_rejected(self):
        for pts in [[0,0],[1,0],[]]:
            with self.assertRaises(ValueError):
                frame_times({"streams":[{"time_base":"1/25"}],"frames":[{"best_effort_timestamp":p} for p in pts]})

if __name__=="__main__":unittest.main()
