package gateway

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestMediaCleanupRecoversWithoutReusingUncertainLease(t *testing.T) {
	var unavailable atomic.Bool
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if strings.HasSuffix(r.URL.Path, "listRtpServer") {
			fmt.Fprint(w, `{"code":0,"data":[]}`)
			return
		}
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
		case "/index/api/listRtpServer":
			fmt.Fprint(w, `{"code":0,"data":[]}`)
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
	if requests != 5 {
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

func TestReceivedMediaPeerMustMatchNegotiatedAddress(t *testing.T) {
	for _, tc := range []struct {
		response string
		valid    bool
	}{
		{`{"code":0,"exist":true,"peer_ip":"192.0.2.10"}`, true},
		{`{"code":0,"exist":true,"peer_ip":"192.0.2.11"}`, false},
		{`{"code":0,"exist":true,"peer_ip":"not-an-address"}`, false},
		{`{"code":0,"exist":false}`, false},
		{`{"code":0,"exist":true}`, false},
	} {
		t.Run(tc.response, func(t *testing.T) {
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				r.ParseForm()
				if r.URL.Path != "/index/api/getRtpInfo" || r.Form.Get("stream_id") != "fresh-lease" {
					t.Error("wrong media identity")
				}
				fmt.Fprint(w, tc.response)
			}))
			defer api.Close()
			receiver := &MediaReceiver{config: MediaConfig{API: api.URL, Secret: "test"}, client: api.Client()}
			err := receiver.VerifyPeer(context.Background(), MediaLease{Stream: "fresh-lease"}, "192.0.2.10")
			if (err == nil) != tc.valid {
				t.Fatalf("unexpected peer decision: %v", err)
			}
		})
	}
}

func TestActiveConnectAllowsReceiverDialDeadline(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(3200 * time.Millisecond)
		fmt.Fprint(w, `{"code":0}`)
	}))
	defer api.Close()
	receiver := &MediaReceiver{config: MediaConfig{API: api.URL, Secret: "test"}, client: &http.Client{Timeout: 3 * time.Second}}
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	if err := receiver.Connect(ctx, MediaLease{Stream: "lease", Mode: "tcp-active"}, "192.0.2.1", 30000); err != nil {
		t.Fatalf("media server's five-second connect budget was cut short: %v", err)
	}
}

func TestUnsupportedVideoIsNotMisreportedAsMediaTimeout(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"code":0,"tracks":[{"codec_type":0,"codec_id_name":"svac","ready":true}]}`)
	}))
	defer api.Close()
	receiver := &MediaReceiver{config: MediaConfig{API: api.URL, Secret: "test"}, client: api.Client()}
	_, _, err := receiver.tracks(context.Background(), MediaLease{Stream: "lease"})
	if !errors.Is(err, errUnsupportedVideoCodec) {
		t.Fatalf("wrong diagnostic: %v", err)
	}
}

func TestMediaOpenSkipsReceiversSurvivingGatewayRestart(t *testing.T) {
	closedOld := false
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		switch r.URL.Path {
		case "/index/api/listRtpServer":
			fmt.Fprint(w, `{"code":0,"data":[{"port":30000,"ssrc":200001234,"stream_id":"prior-process-lease"}]}`)
		case "/index/api/openRtpServer":
			if r.Form.Get("port") == "30000" {
				fmt.Fprint(w, `{"code":-400}`)
			} else {
				fmt.Fprintf(w, `{"code":0,"port":%s}`, r.Form.Get("port"))
			}
		case "/index/api/closeRtpServer":
			closedOld = r.Form.Get("stream_id") == "prior-process-lease"
			fmt.Fprint(w, `{"code":0,"hit":0}`)
		}
	}))
	defer api.Close()
	receiver, err := NewMediaReceiver(MediaConfig{DomainID: "34020000002000000001", API: api.URL, Secret: "test-only-secret-key", ListenIP: "127.0.0.1", AdvertiseIP: "192.0.2.1", PortStart: 30000, PortEnd: 30010, Capacity: 2})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := receiver.Open(context.Background(), "udp")
	if err != nil || lease.Port != 30002 || closedOld {
		t.Fatalf("stuck on an old listener or destroyed it: %+v %v", lease, err)
	}
}

func TestReceiverInventorySSRCCollisionsAndExhaustionAreBounded(t *testing.T) {
	for _, full := range []bool{false, true} {
		t.Run(fmt.Sprint(full), func(t *testing.T) {
			var inventory strings.Builder
			inventory.WriteString(`{"code":0,"data":[`)
			first := true
			for suffix := 0; suffix < 10000; suffix++ {
				if !full && suffix == 9876 {
					continue
				}
				if !first {
					inventory.WriteByte(',')
				}
				first = false
				fmt.Fprintf(&inventory, `{"ssrc":%d}`, 200000000+suffix)
			}
			inventory.WriteString(`]}`)
			opened := false
			api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				r.ParseForm()
				if strings.HasSuffix(r.URL.Path, "listRtpServer") {
					fmt.Fprint(w, inventory.String())
					return
				}
				opened = true
				if full || r.Form.Get("ssrc") != "200009876" {
					t.Error("colliding SSRC opened")
				}
				fmt.Fprintf(w, `{"code":0,"port":%s}`, r.Form.Get("port"))
			}))
			defer api.Close()
			receiver, err := NewMediaReceiver(MediaConfig{DomainID: "34020000002000000001", API: api.URL, Secret: "test-only-secret-key", ListenIP: "127.0.0.1", AdvertiseIP: "192.0.2.1", PortStart: 30000, PortEnd: 30010, Capacity: 2})
			if err != nil {
				t.Fatal(err)
			}
			begin := time.Now()
			_, err = receiver.Open(context.Background(), "udp")
			if time.Since(begin) > time.Second || (err != nil) != full || opened == full {
				t.Fatalf("bad or unbounded allocation: %v", err)
			}
		})
	}
}

func TestRecoverOwnedLeaseNamespaceWithoutDeletingOtherInputs(t *testing.T) {
	old := "gb_34020000002000000001_" + strings.Repeat("a", 32)
	closed := []string{}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		switch r.URL.Path {
		case "/index/api/listRtpServer":
			fmt.Fprintf(w, `{"code":0,"data":[{"port":30000,"ssrc":200001234,"stream_id":%q},{"port":30002,"ssrc":200005678,"stream_id":"foreign-stream"}]}`, old)
		case "/index/api/closeRtpServer":
			closed = append(closed, r.Form.Get("stream_id"))
			fmt.Fprint(w, `{"code":0,"hit":1}`)
		case "/index/api/openRtpServer":
			fmt.Fprintf(w, `{"code":0,"port":%s}`, r.Form.Get("port"))
		}
	}))
	defer api.Close()
	receiver, err := NewMediaReceiver(MediaConfig{DomainID: "34020000002000000001", API: api.URL, Secret: "test-only-secret-key", ListenIP: "127.0.0.1", AdvertiseIP: "192.0.2.1", PortStart: 30000, PortEnd: 30006, Capacity: 1})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := receiver.Open(context.Background(), "udp")
	if err != nil || len(closed) != 1 || closed[0] != old || lease.Port != 30000 || !strings.HasPrefix(lease.Stream, "gb_34020000002000000001_") || lease.SSRC == 200001234 {
		t.Fatalf("unsafe orphan recovery: %+v %v %v", lease, closed, err)
	}
}

func TestClosedSSRCIsQuarantinedForDelayedPackets(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if strings.HasSuffix(r.URL.Path, "openRtpServer") {
			fmt.Fprintf(w, `{"code":0,"port":%s}`, r.Form.Get("port"))
			return
		}
		fmt.Fprint(w, `{"code":0}`)
	}))
	defer api.Close()
	receiver, err := NewMediaReceiver(MediaConfig{DomainID: "34020000002000000001", API: api.URL, Secret: "test-only-secret-key", ListenIP: "127.0.0.1", AdvertiseIP: "192.0.2.1", PortStart: 30000, PortEnd: 30002, Capacity: 1})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := receiver.Open(context.Background(), "udp")
	if err != nil {
		t.Fatal(err)
	}
	if err = receiver.Close(context.Background(), lease); err != nil {
		t.Fatal(err)
	}
	if !receiver.retired[lease.SSRC].After(time.Now().Add(time.Minute)) {
		t.Fatal("closed media identity immediately reusable")
	}
	for suffix := uint32(0); suffix < 10000; suffix++ {
		receiver.retired[200000000+suffix] = time.Now().Add(time.Minute)
	}
	if _, err = receiver.Open(context.Background(), "udp"); err == nil {
		t.Fatal("retired SSRCs recycled under pressure")
	}
	receiver.retired[lease.SSRC] = time.Now().Add(-time.Second)
	next, err := receiver.Open(context.Background(), "udp")
	if err != nil || next.SSRC != lease.SSRC {
		t.Fatalf("expired quarantine did not free capacity: %+v %v", next, err)
	}
}
