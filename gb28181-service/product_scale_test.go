package gateway

import (
	"context"
	"crypto/md5"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/emiago/sipgo"
)

// One S100P carries 16 GB cameras; the gateway must accept that many streams.
func TestMediaCapacityAllowsABoardOfCameras(t *testing.T) {
	c := siteConfig(1).Media
	c.Capacity = 16
	if _, e := NewMediaReceiver(c); e != nil {
		t.Fatalf("16 concurrent streams rejected: %v", e)
	}
	c.Capacity = 17
	if _, e := NewMediaReceiver(c); e == nil {
		t.Fatal("capacity above the gateway ceiling accepted")
	}
}

// Every channel checks its output once per second. With 16 channels they must
// share one stream list rather than fetch and decode it 16 times.
func TestChannelsShareOneStreamList(t *testing.T) {
	var requests atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		time.Sleep(20 * time.Millisecond)
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "streams": []map[string]any{
			{"app": "live", "name": "gb_3", "publish": map[string]bool{"active": true}, "video": map[string]any{"codec": "H264"}},
			{"app": "live", "name": "gb_4", "publish": map[string]bool{"active": true}},
		}})
	}))
	defer api.Close()
	r := &Runtime{config: RuntimeConfig{SRSAPI: api.URL}}
	var wg sync.WaitGroup
	results := make([]bool, 16)
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i] = r.published(context.Background(), Binding{App: "live", Stream: fmt.Sprintf("gb_%d", i)})
		}(i)
	}
	wg.Wait()
	if n := requests.Load(); n != 1 {
		t.Fatalf("16 channels issued %d stream list requests", n)
	}
	for i, ok := range results {
		if ok != (i == 3) {
			t.Fatalf("channel %d published=%v; only a live stream with video counts", i, ok)
		}
	}
}

// A changed channel restarts with a new session only after the old one has
// released its media lease and output stream, even when that is slow.
func TestChangedChannelWaitsForItsOldSession(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a1 := binding("a1", devA, chA1, "udp", true)
	r, e := NewRuntime(siteConfig(1, a1))
	if e != nil {
		t.Fatal(e)
	}
	r.stopWait = 10 * time.Millisecond
	var mu sync.Mutex
	events := []string{}
	note := func(s string) { mu.Lock(); events = append(events, s); mu.Unlock() }
	r.work = func(ctx context.Context, b Binding) {
		note("start " + b.Mode)
		<-ctx.Done()
		time.Sleep(150 * time.Millisecond) // slow BYE and media release
		note("stop " + b.Mode)
	}
	r.activate(ctx)
	eventually(t, "initial session", func() bool { mu.Lock(); defer mu.Unlock(); return len(events) == 1 })
	a1.Mode = "tcp-passive"
	if e := r.Update(siteConfig(2, a1)); e != nil {
		t.Fatal(e)
	}
	eventually(t, "replacement session", func() bool { mu.Lock(); defer mu.Unlock(); return len(events) == 3 })
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(events, ",") != "start udp,stop udp,start tcp-passive" {
		t.Fatalf("replacement overlapped its predecessor: %v", events)
	}
}

// An installer who mistypes a device number or password must see why the
// camera stays offline, without a forged request disturbing a live camera.
func TestRegistrationFailuresAreReported(t *testing.T) {
	probe, e := net.ListenPacket("udp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	addr := probe.LocalAddr().String()
	probe.Close()
	config := testConfig(addr)
	config.Devices = append(config.Devices, DeviceConfig{ID: devB, Password: "camera-b-secret", Version: "auto", Enabled: true})
	s, e := NewServer(config)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	ready := make(chan struct{}, 2)
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), sipgo.ListenReadyCtxKey, sipgo.ListenReadyFuncCtxValue(func(string, string) { ready <- struct{}{} })))
	defer cancel()
	go func() { _ = s.Run(ctx) }()
	for i := 0; i < 2; i++ {
		select {
		case <-ready:
		case <-time.After(3 * time.Second):
			t.Fatal("listen timeout")
		}
	}
	conn, e := net.Dial("udp", addr)
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	uri := "sip:34020000002000000001@3402000000"
	seq := 0
	send := func(id, auth string) string {
		t.Helper()
		seq++
		req := fmt.Sprintf("REGISTER %s SIP/2.0\r\nVia: SIP/2.0/UDP %s;branch=z9hG4bK-feedback-%d;rport\r\nFrom: <sip:%s@3402000000>;tag=feedback\r\nTo: <sip:%s@3402000000>\r\nCall-ID: feedback-%s\r\nCSeq: %d REGISTER\r\nMax-Forwards: 70\r\nContact: <sip:%s@%s>\r\nExpires: 3600\r\n%sContent-Length: 0\r\n\r\n", uri, conn.LocalAddr(), seq, id, id, id, seq, id, conn.LocalAddr(), auth)
		conn.SetDeadline(time.Now().Add(2 * time.Second))
		if _, e := conn.Write([]byte(req)); e != nil {
			t.Fatal(e)
		}
		b := make([]byte, 65536)
		n, e := conn.Read(b)
		if e != nil {
			t.Fatal(e)
		}
		return string(b[:n])
	}
	wrong := func(id string) string {
		t.Helper()
		challenge := send(id, "")
		m := regexp.MustCompile(`nonce="([a-f0-9]+)"`).FindStringSubmatch(challenge)
		if len(m) != 2 {
			t.Fatalf("no challenge for %s: %s", id, challenge)
		}
		hash := func(v string) string { return fmt.Sprintf("%x", md5.Sum([]byte(v))) }
		digest := hash(hash(id+":3402000000:not-the-password") + ":" + m[1] + ":00000001:c:auth:" + hash("REGISTER:"+uri))
		return send(id, fmt.Sprintf("Authorization: Digest username=\"%s\", realm=\"3402000000\", nonce=\"%s\", uri=\"%s\", response=\"%s\", algorithm=MD5, qop=auth, nc=00000001, cnonce=\"c\"\r\n", id, m[1], uri, digest))
	}
	state := func(id string) DeviceState {
		for _, d := range s.Snapshot() {
			if d.ID == id {
				return d
			}
		}
		t.Fatalf("no state for %s", id)
		return DeviceState{}
	}

	stranger := "34020000001320000077"
	if r := send(stranger, ""); !strings.HasPrefix(r, "SIP/2.0 403 ") {
		t.Fatalf("unprovisioned device not refused: %s", r)
	}
	unknown := s.Unknown()
	if len(unknown) != 1 || unknown[0].ID != stranger || unknown[0].Address != conn.LocalAddr().String() {
		t.Fatalf("unprovisioned registration not reported: %+v", unknown)
	}

	if r := wrong(sampleID); !strings.HasPrefix(r, "SIP/2.0 403 ") {
		t.Fatalf("wrong password accepted: %s", r)
	}
	if got := state(sampleID).LastError; got != "authentication_failed" {
		t.Fatalf("wrong password reported as %q", got)
	}

	s.mu.Lock()
	st := s.states[devB]
	st.Registered, st.ExpiresAt, st.LastSeen = true, time.Now().Add(time.Hour), time.Now()
	s.mu.Unlock()
	wrong(devB)
	if d := state(devB); d.LastError != "" || !d.Registered {
		t.Fatalf("forged registration disturbed a live camera: %+v", d)
	}

	if e := s.UpdateDevices(append(config.Devices, DeviceConfig{ID: stranger, Password: "camera-x-secret", Version: "auto", Enabled: true})); e != nil {
		t.Fatal(e)
	}
	if len(s.Unknown()) != 0 {
		t.Fatal("a device stays listed as unknown after it is provisioned")
	}
}
