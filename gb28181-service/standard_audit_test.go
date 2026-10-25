package gateway

import (
	"strings"
	"testing"
	"time"
)

func TestLiveSubjectSourceStableAcrossReconnect(t *testing.T) {
	a := liveSubject("34020000001320000001", "34020000002000000001", 123)
	b := liveSubject("34020000001320000001", "34020000002000000001", 456)
	if strings.Split(a, ",")[0] != "34020000001320000001:0" || strings.Split(a, ",")[0] != strings.Split(b, ",")[0] || a == b {
		t.Fatalf("bad source/session identities: %s %s", a, b)
	}
}
func TestQueryProfileEncoding(t *testing.T) {
	for profile, encoding := range map[string]string{"2016": "GB2312", "2022": "GB18030"} {
		b, err := QueryXMLForProfile("Catalog", sampleID, 1, profile)
		if err != nil || !strings.Contains(string(b), `encoding="`+encoding+`"`) {
			t.Fatalf("%s %s %v", profile, b, err)
		}
	}
	if _, err := QueryXMLForProfile("Catalog", sampleID, 1, "future"); err == nil {
		t.Fatal("unknown profile accepted")
	}
}
func TestMixedDirectoryNodesCompleteWithoutBecomingChannels(t *testing.T) {
	body := `<Response><CmdType>Catalog</CmdType><SN>1</SN><DeviceID>` + sampleID + `</DeviceID><SumNum>4</SumNum><DeviceList Num="4"><Item><DeviceID>11</DeviceID><Name>province</Name></Item><Item><DeviceID>11010101</DeviceID><Name>district</Name></Item><Item><DeviceID>11010100002150000001</DeviceID><Name>group</Name></Item><Item><DeviceID>11010100001320000001</DeviceID><Name>camera</Name><Status>ON</Status></Item></DeviceList></Response>`
	m, err := ParseBusinessMessage([]byte(body), 100)
	if err != nil {
		t.Fatal(err)
	}
	c := NewCatalog("1", time.Now().Add(time.Minute), 100)
	done, err := c.Add(m, time.Now())
	if err != nil || !done {
		t.Fatalf("%v %v", done, err)
	}
	channels := selectableCatalog(c.Snapshot())
	if len(channels) != 1 || channels[0].ID != "11010100001320000001" {
		t.Fatalf("%+v", channels)
	}
	if _, err := ParseBusinessMessage([]byte(strings.Replace(body, "<DeviceID>11</DeviceID>", "<DeviceID>111</DeviceID>", 1)), 100); err == nil {
		t.Fatal("invalid node ID accepted")
	}
}
