package gateway

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestBroadcastAudioOffer(t *testing.T) {
	for _, tc := range []struct {
		s  string
		ok bool
	}{
		{"c=IN IP4 192.0.2.5\r\nm=audio 5002 RTP/AVP 8\r\ny=0123456789", true},
		{"c=IN IP4 192.0.2.6\r\nm=audio 5002 RTP/AVP 8", false},
		{"c=IN IP4 192.0.2.5\r\nm=video 5002 RTP/AVP 8", false},
		{"c=IN IP4 192.0.2.5\r\nm=audio 5002 RTP/AVP 96", false},
		{"c=IN IP4 192.0.2.5\r\nm=audio 22 RTP/AVP 0", false},
	} {
		_, _, _, e := audioOffer([]byte(tc.s), []string{"192.0.2.5"})
		if (e == nil) != tc.ok {
			t.Fatalf("offer %q: %v", tc.s, e)
		}
	}
}
func TestBroadcastAudioRequiresCurrentRegistrationAndConfirmedDialog(t *testing.T) {
	socket, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	st := &DeviceState{Registered: true, Generation: 7, LastSeen: time.Now(), ExpiresAt: time.Now().Add(time.Minute), source: "127.0.0.1:5060", transport: "UDP"}
	b := &broadcast{device: sampleID, registration: st, generation: 7, source: st.source, transport: st.transport, until: time.Now().Add(time.Minute), socket: socket, peer: socket.LocalAddr().(*net.UDPAddr), ready: make(chan struct{}), done: make(chan struct{})}
	s := &Server{broadcast: b, states: map[string]*DeviceState{sampleID: st}}
	s.config.HeartbeatTimeoutSec = 60
	reject := func() {
		t.Helper()
		if err := s.sendAudio(context.Background(), b, make([]byte, 3200)); err == nil || b.seq != 0 {
			t.Fatal("invalid audio session transmitted RTP")
		}
	}
	reject()
	close(b.ready)
	replacement := *st
	s.states[sampleID] = &replacement
	reject()
	s.states[sampleID] = st
	st.Generation++
	reject()
	st.Generation--
	b.until = time.Now().Add(-time.Millisecond)
	reject()
	b.until = time.Now().Add(time.Minute)
	if err := s.sendAudio(context.Background(), b, make([]byte, 3200)); err != nil || b.seq != 10 || b.stamp != 1600 {
		t.Fatalf("active RTP stream: seq=%d timestamp=%d err=%v", b.seq, b.stamp, err)
	}
}

func TestBroadcastG711(t *testing.T) {
	for _, tc := range []struct {
		x    int16
		a, u byte
	}{{0, 0xd5, 0xff}, {32767, 0xaa, 0x80}, {-32768, 0x2a, 0x00}, {1000, 0xfa, 0xce}, {-1000, 0x7a, 0x4e}} {
		if encodeG711(tc.x, 8) != tc.a || encodeG711(tc.x, 0) != tc.u {
			t.Fatalf("G711 at %d", tc.x)
		}
	}
}
