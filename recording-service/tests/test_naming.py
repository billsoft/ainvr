from recorder.naming import (day_dir, parse_segment_filename, sanitize_file_part,
                             segment_filename)
from datetime import datetime


def test_sanitize_basic():
    # 非 ASCII 字符一律替换为下划线（避免 SMB/CIFS 中文乱码与"毒文件"）
    # "大 门口/01" → 非法字符替成下划线 → "大_门口_01"
    # → 两段非 ASCII（大、门口）各替成 1 个 _，加上原有的两个分隔下划线 → "____01"
    assert sanitize_file_part("大 门口/01") == "____01"
    assert sanitize_file_part("  ") == "channel"
    # 与前端一致：不 strip 结果两端的下划线
    assert sanitize_file_part("a\\b:c*d?") == "a_b_c_d_"
    # 纯 ASCII 正常保留
    assert sanitize_file_part("front_door_01") == "front_door_01"
    assert sanitize_file_part("cam-1/live test") == "cam-1_live_test"


def test_filename_roundtrip():
    ts = datetime(2026, 9, 14, 8, 0, 5)
    name = segment_filename("84f4370d-4eda", "大门口", ts)
    # 文件名只含 channelId（纯 ASCII），通道名不落磁盘防乱码/毒文件
    assert name == "84f4370d-4eda_20260914_080005.000.mp4"
    key, parsed = parse_segment_filename(name)
    assert key == "84f4370d-4eda"
    assert parsed == ts


def test_parse_invalid():
    assert parse_segment_filename("random.mp4") is None
    assert parse_segment_filename("x_20260914_999999.mp4") is None


def test_day_dir():
    assert day_dir(datetime(2026, 9, 14, 23, 59)) == "20260914"
