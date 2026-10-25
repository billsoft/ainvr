package gateway

import (
	"strings"
	"testing"
)

func TestBusinessRoutingFieldsCannotBeOverwritten(t *testing.T) {
	for _, extra := range []string{"<SN>12</SN>", "<DeviceID>34020000001320000001</DeviceID>", "<CmdType>Keepalive</CmdType>", "<SumNum>2</SumNum>", `<DeviceList Num="0"></DeviceList>`} {
		body := strings.Replace(catalogFixture, "</Response>", extra+"</Response>", 1)
		if _, err := ParseBusinessMessage([]byte(body), 100); err == nil {
			t.Fatalf("duplicate accepted: %s", extra)
		}
	}
}

func TestCatalogRequiredFields(t *testing.T) {
	for _, body := range []string{
		strings.Replace(catalogFixture, "<SN>12</SN>", "<SN>0</SN>", 1),
		strings.Replace(catalogFixture, "<SN>12</SN>", "<SN>000</SN>", 1),
		strings.Replace(catalogFixture, "<SumNum>2</SumNum>", "", 1),
	} {
		if _, err := ParseBusinessMessage([]byte(body), 100); err == nil {
			t.Fatal("required field accepted missing/invalid")
		}
	}
	empty := `<Response><CmdType>Catalog</CmdType><SN>1</SN><DeviceID>34020000001320000001</DeviceID><SumNum>0</SumNum></Response>`
	if _, err := ParseBusinessMessage([]byte(empty), 100); err != nil {
		t.Fatal(err)
	}
}

func FuzzBusinessXMLBoundaries(f *testing.F) {
	f.Add([]byte(catalogFixture))
	f.Add([]byte(`<Notify><CmdType>Keepalive</CmdType><SN>1</SN><DeviceID>34020000001320000001</DeviceID><Status>OK</Status></Notify>`))
	f.Add([]byte(`<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///not-read">]><Response/>`))
	f.Fuzz(func(t *testing.T, b []byte) {
		m, err := ParseBusinessMessage(b, 100)
		if err == nil && (len(b) > MaxXMLBytes || len(m.List.Items) > 100 || !deviceIDPattern.MatchString(m.DeviceID)) {
			t.Fatal("accepted outside parser limits")
		}
	})
}

func FuzzMediaAnswerBoundaries(f *testing.F) {
	f.Add([]byte("v=0\r\nc=IN IP4 192.0.2.1\r\nm=video 30002 RTP/AVP 96\r\ny=0000000123\r\n"))
	f.Fuzz(func(t *testing.T, b []byte) {
		a, err := ParseMediaAnswer(b, MediaLease{Mode: "udp", SSRC: 123}, "192.0.2.1")
		if err == nil && (a.IP != "192.0.2.1" || a.SSRC != 123 || a.Port < 1 || a.Port > 65535 || len(b) > 16*1024) {
			t.Fatal("accepted outside media limits")
		}
	})
}
