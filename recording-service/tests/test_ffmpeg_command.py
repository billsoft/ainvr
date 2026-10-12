from recorder.ffmpeg_recorder import build_reader_command, build_writer_command


def test_reader_copies_to_ts_pipe_without_dropping():
    cmd = build_reader_command("rtmp://127.0.0.1:1935/live/phase6_test")
    joined = " ".join(cmd)
    # copy 不重编码；TS 管道交给 GopGate，丢不丢由闸门按完整 GOP 决定
    assert " -c copy " in f" {joined} "
    assert cmd[-3:] == ["-f", "mpegts", "pipe:1"]
    assert "-map" in cmd and "0:a?" in cmd  # 无音频流不致命
    assert "-drop" not in joined
    assert "-rw_timeout" in cmd  # 源断开时读端退出，监督器退避重启


def test_writer_is_fmp4_never_overwrites_and_fixes_adts_only_when_needed():
    path = "/v/20260914/84f4370d_20260914_101500.mp4"
    cmd = build_writer_command(path, audio_adts=True)
    joined = " ".join(cmd)
    assert cmd[-1] == path
    assert "-n" in cmd  # 同名文件存在即失败，绝不覆盖已完成录像
    assert cmd[cmd.index("-f") + 1] == "mpegts" and "pipe:0" in cmd
    assert "frag_keyframe+empty_moov+default_base_moof" in joined
    assert "aac_adtstoasc" in joined
    assert "aac_adtstoasc" not in " ".join(build_writer_command(path, audio_adts=False))


def test_h265_reader_uses_ffmpeg8_and_h264_keeps_system_ffmpeg(monkeypatch):
    from recorder import ffmpeg_recorder as fr
    monkeypatch.setattr(fr, "FFMPEG8", "/opt/x/ffmpeg")
    h265 = build_reader_command("rtmp://h/live/s", codec="h265")
    h264 = build_reader_command("rtmp://h/live/s", codec="h264")
    unknown = build_reader_command("rtmp://h/live/s")
    # FFmpeg 4.4 读不了 FLV 里的 HEVC（codec12 / Enhanced 都不行），8.1.2 两种都能读
    assert h265[0] == "/opt/x/ffmpeg"
    # 264 行为不变：仍用系统 ffmpeg；参数与 265 完全一致（只换可执行文件）
    assert h264[0] == "ffmpeg" and unknown[0] == "ffmpeg"
    assert h265[1:] == h264[1:]


def test_h265_writer_tags_hvc1_for_safari_and_h264_unchanged():
    path = "/v/20260929/x_20260929_101500.mp4"
    h265 = build_writer_command(path, audio_adts=True, codec="h265")
    h264 = build_writer_command(path, audio_adts=True, codec="h264")
    # ffmpeg 默认写 hev1，Safari/iPad 只播 hvc1
    assert h265[h265.index("-tag:v") + 1] == "hvc1"
    assert "-tag:v" not in h264
    assert h264 == build_writer_command(path, audio_adts=True)
    assert h265[-1] == path and "aac_adtstoasc" in h265
