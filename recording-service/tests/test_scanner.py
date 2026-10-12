import asyncio
import json

from recorder.scanner import CatalogResolver, parse_probe


def test_parse_probe():
    data = {
        "streams": [
            {"codec_type": "video", "codec_name": "h264", "width": 1920,
             "height": 1080, "r_frame_rate": "30/1"},
            {"codec_type": "audio", "codec_name": "aac"},
        ],
        "format": {"duration": "60.040000"},
    }
    m = parse_probe(data)
    assert m["codec"] == "h264"
    assert m["width"] == 1920 and m["height"] == 1080
    assert m["fps"] == 30
    assert m["hasAudio"] is True
    assert m["durationMs"] == 60040


def test_parse_probe_hevc_no_audio():
    m = parse_probe({
        "streams": [{"codec_type": "video", "codec_name": "hevc",
                     "r_frame_rate": "25/1"}],
        "format": {"duration": "5.5"},
    })
    assert m["codec"] == "h265"
    assert m["hasAudio"] is False
    assert m["fps"] == 25


def test_catalog_resolver(tmp_path=None):
    r = CatalogResolver()
    channels = [
        {"id": "c1", "name": "大门口", "streamName": "phase6_test", "kind": "source"},
        {"id": "c2", "name": "大门口_AI输出", "streamName": "phase6_test_ai", "kind": "ai"},
    ]
    asyncio.run(r.update(channels))
    hit = r.resolve("c1_大门口")
    assert hit["id"] == "c1"
    assert r.resolve("c2_大门口_AI输出")["kind"] == "ai"
    # 改名后历史文件（旧通道名）按 <id>_ 前缀兜底
    assert r.resolve("c1_旧名字")["id"] == "c1"
    assert r.resolve("unknown_x") is None
