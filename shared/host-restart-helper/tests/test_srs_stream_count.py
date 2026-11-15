import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import observability as ob


def test_srs_stream_listing_requests_every_stream():
    # The media server lists only the first 10 streams unless a count is given;
    # the dashboard would cap "N 路视频流" and viewer counts at 10.
    assert 'count=1000' in ob.SRS_STREAMS_URL
