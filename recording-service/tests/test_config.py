import os

from recorder.config import ConfigStore, SmbConfig


def test_smb_public_never_leaks_password():
    smb = SmbConfig(host="192.168.100.191", share="wanglei", path="AI/videos",
                    username="wanglei", password="123654aa")
    pub = smb.public()
    assert pub == {
        "host": "192.168.100.191", "share": "wanglei", "path": "AI/videos",
        "username": "wanglei", "passwordSet": True, "smbVersion": "auto",
        "domain": None,
    }
    assert "123654aa" not in str(pub)
    assert pub["passwordSet"] is True
    assert SmbConfig().public()["passwordSet"] is False


def test_config_roundtrip_mode600(tmp_path):
    p = str(tmp_path / "config.json")
    s = ConfigStore(p)
    cfg = s.mutate()
    cfg.enabled_channel_ids = ["ch-1", "ch-1", "ch-2"]
    cfg.recording.files.segmentSeconds = 300
    s.save()
    s.commit()
    assert os.stat(p).st_mode & 0o777 == 0o600

    s2 = ConfigStore(p)
    got = s2.get()
    assert got.enabled_channel_ids == ["ch-1", "ch-1", "ch-2"]
    assert got.recording.files.segmentSeconds == 300
