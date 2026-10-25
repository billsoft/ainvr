package gateway

import (
	"strings"
	"testing"
)

func TestAnswerCannotRedirectMedia(t *testing.T) {
	base := "v=0\r\nc=IN IP4 192.0.2.1\r\nm=video 30002 TCP/RTP/AVP 96\r\na=rtpmap:96 PS/90000\r\na=sendonly\r\na=setup:active\r\ny=0000000123\r\n"
	l := MediaLease{Mode: "tcp-passive", SSRC: 123}
	if _, e := ParseMediaAnswer([]byte(base), l, "192.0.2.1"); e != nil {
		t.Fatal(e)
	}
	for name, b := range map[string]string{
		"different host": strings.ReplaceAll(base, "192.0.2.1", "127.0.0.1"),
		"wrong role":     strings.ReplaceAll(base, "setup:active", "setup:passive"),
		"stale ssrc":     strings.ReplaceAll(base, "0000000123", "0000000124"),
		"extra media":    base + "m=audio 4000 RTP/AVP 8\r\n",
		"wrong payload":  strings.ReplaceAll(base, "PS/90000", "H264/90000"),
	} {
		t.Run(name, func(t *testing.T) {
			if _, e := ParseMediaAnswer([]byte(b), l, "192.0.2.1"); e == nil {
				t.Fatal("unsafe answer accepted")
			}
		})
	}
}

func TestExplicitMediaPeer(t *testing.T) {
	body := []byte("v=0\r\nc=IN IP4 192.0.2.25\r\nm=video 30002 TCP/RTP/AVP 96\r\na=rtpmap:96 PS/90000\r\na=sendonly\r\na=setup:passive\r\ny=0000000123\r\n")
	lease := MediaLease{Mode: "tcp-active", SSRC: 123}
	if _, e := ParseMediaAnswer(body, lease, "192.0.2.1"); e == nil {
		t.Fatal("unconfigured peer accepted")
	}
	if _, e := ParseMediaAnswer(body, lease, "192.0.2.1", "192.0.2.25"); e != nil {
		t.Fatal(e)
	}
	for _, ip := range []string{"127.0.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1"} {
		if validDeviceMediaIP(ip) {
			t.Fatalf("unsafe peer %s", ip)
		}
	}
}
