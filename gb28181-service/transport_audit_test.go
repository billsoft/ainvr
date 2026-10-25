package gateway

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSDPOptionalAttributesAndAmbiguity(t *testing.T) {
	base := "v=0\r\nc=IN IP4 192.0.2.1\r\nm=video 30002 RTP/AVP 96\r\ny=0000000123\r\n"
	lease := MediaLease{Mode: "udp", SSRC: 123}
	for _, body := range []string{base, base + "a=sendonly\r\n", base + "a=rtpmap:96 PS/90000\r\n", strings.Replace(base, "m=video", "a=recvonly\r\nm=video", 1) + "a=sendonly\r\n"} {
		if _, err := ParseMediaAnswer([]byte(body), lease, "192.0.2.1"); err != nil {
			t.Fatal(err)
		}
	}
	for _, extra := range []string{"a=recvonly\r\n", "a=inactive\r\n", "a=sendonly\r\na=inactive\r\n", "a=rtpmap:96 H264/90000\r\n", "a=rtpmap:96 H264/90000\r\na=rtpmap:96 PS/90000\r\n", "y=0000000123\r\n", "a=connection:existing\r\n", "v=0\r\n"} {
		if _, err := ParseMediaAnswer([]byte(base+extra), lease, "192.0.2.1"); err == nil {
			t.Fatalf("accepted %q", extra)
		}
	}
}

func TestActiveMediaRetryKeepsLeaseAndBoundedSpacing(t *testing.T) {
	var mu sync.Mutex
	var calls []time.Time
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("stream_id") != "same-session" {
			t.Error("changed media session")
		}
		mu.Lock()
		calls = append(calls, time.Now())
		n := len(calls)
		mu.Unlock()
		if n < 3 {
			fmt.Fprint(w, `{"code":-1}`)
		} else {
			fmt.Fprint(w, `{"code":0}`)
		}
	}))
	defer api.Close()
	m := &MediaReceiver{config: MediaConfig{API: api.URL, Secret: "test"}, client: api.Client()}
	lease := MediaLease{Mode: "tcp-active", Stream: "same-session"}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.ConnectWithRetry(ctx, lease, "192.0.2.1", 30000); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if len(calls) != 3 {
		t.Fatalf("calls=%d", len(calls))
	}
	for i := 1; i < len(calls); i++ {
		if calls[i].Sub(calls[i-1]) < time.Second {
			t.Error("retry too fast")
		}
	}
	mu.Unlock()
	cancel()
	if m.ConnectWithRetry(ctx, lease, "192.0.2.1", 30000) == nil {
		t.Fatal("cancel ignored")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(calls) != 3 {
		t.Fatal("cancelled attempt sent")
	}
}
