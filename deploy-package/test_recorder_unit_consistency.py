"""离线包安装器写出的录像服务单元，停止相关参数必须与仓库里的单元示例一致。

示例文件（recording-service/deploy/ainvr-recorder.service.example）是现场手工部署
的依据，install.sh 是离线包部署的依据；两边停止超时不一致时，离线包装出来的设备在
重连交接（同通道两代管线）期间停服务会被提前 SIGKILL，分段收尾不完整。
"""
from pathlib import Path
import re
import unittest

HERE = Path(__file__).resolve().parent
STOP_KEYS = ('KillSignal', 'KillMode', 'TimeoutStopSec')


def directives(text):
    found = {}
    for line in text.splitlines():
        m = re.match(r'\s*([A-Za-z]+)=(.*)$', line)
        if m and m.group(1) in STOP_KEYS:
            found[m.group(1)] = m.group(2).strip()
    return found


def installer_recorder_unit():
    text = (HERE / 'install.sh').read_text(encoding='utf-8')
    start = text.index('cat > /etc/systemd/system/ainvr-recorder.service <<EOF')
    end = text.index('\nEOF', start)
    return text[start:end]


class RecorderUnitConsistencyTest(unittest.TestCase):
    def test_installer_stop_settings_match_example(self):
        example = (HERE.parent / 'recording-service' / 'deploy'
                   / 'ainvr-recorder.service.example').read_text(encoding='utf-8')
        expected = directives(example)
        self.assertEqual(set(expected), set(STOP_KEYS))
        self.assertEqual(directives(installer_recorder_unit()), expected)


if __name__ == '__main__':
    unittest.main()
