package gateway

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestMediaCleanupRecoversWithoutReusingUncertainLease(t *testing.T) {
	var unavailable atomic.Bool
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if strings.HasSuffix(r.URL.Path, "closeRtpServer") {
			if unavailable.Load() {
				http.Error(w, "unavailable", 503)
				return
			}
			fmt.Fprint(w, `{"code":0,"hit":0}`)
			return
		}
		fmt.Fprintf(w, `{"code":0,"port":%s}`, r.Form.Get("port"))
	}))
	defer api.Close()
	m, err := NewMediaReceiver(MediaConfig{DomainID: "34020000002000000001", API: api.URL, Secret: "test-only-secret-key", ListenIP: "127.0.0.1", AdvertiseIP: "192.0.2.1", PortStart: 30000, PortEnd: 30004, Capacity: 1})
	if err != nil {
		t.Fatal(err)
	}
	first, err := m.Open(context.Background(), "udp")
	if err != nil {
		t.Fatal(err)
	}
	unavailable.Store(true)
	if m.Close(context.Background(), first) == nil {
		t.Fatal("failed close accepted")
	}
	if _, err := m.Open(context.Background(), "udp"); err == nil {
		t.Fatal("uncertain lease reused")
	}
	unavailable.Store(false)
	next, err := m.Open(context.Background(), "udp")
	if err != nil {
		t.Fatal("capacity not recovered", err)
	}
	if next.Stream == first.Stream {
		t.Fatal("old media identity reused")
	}
	if err := m.Close(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	if len(m.leases) != 1 {
		t.Fatal("stale cleanup affected new session")
	}
}

func TestMediaLeaseIsolation(t *testing.T) {
	requests := 0
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.RawQuery != "" {
			t.Error("secret exposed in URL or wrong method")
		}
		r.ParseForm()
		if r.Form.Get("secret") != "test-only-secret-key" {
			t.Error("missing service authentication")
		}
		requests++
		switch r.URL.Path {
		case "/index/api/openRtpServer":
			fmt.Fprintf(w, `{"code":0,"port":%s}`, r.Form.Get("port"))
		case "/index/api/closeRtpServer":
			fmt.Fprint(w, `{"code":0,"hit":1}`)
		default:
			t.Error("unexpected operation")
		}
	}))
	defer api.Close()
	m, e := NewMediaReceiver(MediaConfig{DomainID: "34020000002000000001", API: api.URL, Secret: "test-only-secret-key", ListenIP: "127.0.0.1", AdvertiseIP: "192.0.2.1", PortStart: 30000, PortEnd: 30010, Capacity: 2})
	if e != nil {
		t.Fatal(e)
	}
	a, e := m.Open(context.Background(), "udp")
	if e != nil {
		t.Fatal(e)
	}
	b, e := m.Open(context.Background(), "tcp-passive")
	if e != nil {
		t.Fatal(e)
	}
	if a.Port == b.Port || a.SSRC == b.SSRC || a.Stream == b.Stream {
		t.Fatal("sessions share media identity")
	}
	if a.SSRC/10000 != 20000 || b.SSRC/10000 != 20000 {
		t.Fatal("SSRC does not encode SIP domain digits 4..8")
	}
	if _, e := m.Open(context.Background(), "udp"); e == nil {
		t.Fatal("capacity bypass")
	}
	if e := m.Close(context.Background(), a); e != nil {
		t.Fatal(e)
	}
	if e := m.Close(context.Background(), a); e != nil {
		t.Fatal(e)
	}
	if requests != 3 {
		t.Fatal("close not idempotent")
	}
}
func TestMediaSDPRoles(t *testing.T) {
	for mode, expected := range map[string]string{"udp": "RTP/AVP", "tcp-active": "a=setup:active", "tcp-passive": "a=setup:passive"} {
		b, e := LiveSDP("34020000002000000001", sampleID, "192.0.2.1", MediaLease{Port: 30000, SSRC: 123, Mode: mode})
		if e != nil || !strings.Contains(string(b), expected) || !strings.Contains(string(b), "y=0000000123\r\n") {
			t.Fatalf("bad SDP: %s %v", b, e)
		}
	}
}
