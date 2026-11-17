package gateway

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBridgeCopyAndAudioPolicy(t *testing.T) {
	c := BridgeConfig{FFmpeg: "/opt/ffmpeg", RTSPBase: "rtsp://127.0.0.1:8554", RTMPBase: "rtmp://127.0.0.1:1935"}
	l := MediaLease{Stream: "gb_fixture"}
	for _, codec := range []string{"", "aac", "mpeg4-generic", "pcma", "pcmu", "opus"} {
		t.Run(codec, func(t *testing.T) {
			a, w, e := BridgeArgs(c, l, "live", "stable_uuid", codec)
			if e != nil {
				t.Fatal(e)
			}
			joined := strings.Join(a, " ")
			if !strings.Contains(joined, "-c:v copy") || strings.Contains(joined, "libx26") {
				t.Fatal("video transcoding enabled")
			}
			if (codec == "aac" || codec == "mpeg4-generic") && !strings.Contains(joined, "-c:a copy") {
				t.Fatal("AAC not copied")
			}
			if (codec == "pcma" || codec == "pcmu") && !strings.Contains(joined, "-c:a aac") {
				t.Fatal("G711 not converted")
			}
			if codec == "opus" && (w == "" || !strings.Contains(joined, "-an")) {
				t.Fatal("unsupported audio not reported")
			}
		})
	}
	if _, _, e := BridgeArgs(c, l, "../bad", "stream", "aac"); e == nil {
		t.Fatal("invalid output accepted")
	}
	c.RTSPBase = "rtsp://192.0.2.1:554"
	if _, _, e := BridgeArgs(c, l, "live", "stream", "aac"); e == nil {
		t.Fatal("untrusted bridge endpoint accepted")
	}
}

func TestHTTPBridgePreservesMediaTimestamps(t *testing.T) {
	c := BridgeConfig{HTTPBase: "http://127.0.0.1:8097", RTSPBase: "rtsp://127.0.0.1:8556", RTMPBase: "rtmp://127.0.0.1:1935"}
	args, warning, err := BridgeArgs(c, MediaLease{Stream: "gb_test"}, "live", "fixed", "mpeg4-generic")
	if err != nil || warning != "" {
		t.Fatal("AAC media component alias rejected")
	}
	value := strings.Join(args, " ")
	if BridgeSourceURL(c, MediaLease{Stream: "gb_test"}) != "http://127.0.0.1:8097/rtp/gb_test.live.flv" || !strings.Contains(value, "-f flv -i pipe:0") || !strings.Contains(value, "-c:v copy") || !strings.Contains(value, "-c:a copy") {
		t.Fatal("invalid HTTP FLV copy bridge")
	}
	if strings.Contains(value, "http://") {
		t.Fatal("relay must read the gateway's continuous feed, not the origin directly")
	}
	if strings.Contains(value, "-rtsp_transport") || strings.Contains(value, "-fflags") {
		t.Fatal("timestamp regeneration applied to FLV")
	}
	c.HTTPBase = "http://192.0.2.1:8097"
	if _, _, err := BridgeArgs(c, MediaLease{Stream: "gb_test"}, "live", "fixed", "aac"); err == nil {
		t.Fatal("untrusted media origin")
	}
	log := &bridgeLog{}
	log.Write([]byte(strings.Repeat("x", 6000) + " rtsp://private/path"))
	if len(log.diagnostic()) > 4096 || strings.Contains(log.diagnostic(), "private/path") {
		t.Fatal("unbounded or unsanitized diagnostic")
	}
}

func TestUnsupportedAudioDoesNotDelayVideoInputAnalysis(t *testing.T) {
	c := BridgeConfig{HTTPBase: "http://127.0.0.1:8097", RTSPBase: "rtsp://127.0.0.1:8556", RTMPBase: "rtmp://127.0.0.1:1935"}
	args, warning, err := BridgeArgs(c, MediaLease{Stream: "gb_test"}, "live", "fixed", "opus")
	if err != nil || warning != "unsupported_audio_codec" {
		t.Fatalf("wrong unsupported audio policy: %s %v", warning, err)
	}
	joined := strings.Join(args, " ")
	input := strings.Index(joined, " -i ")
	if input < 0 || !strings.Contains(joined[:input], "-analyzeduration 1000000 -probesize 1048576 -an") {
		t.Fatal("unsupported source audio can consume an unbounded live analysis window")
	}
	if !strings.Contains(joined, "-f flv") || !strings.Contains(joined, "-i pipe:0") || strings.Contains(joined, "-rtsp_transport") || strings.Contains(joined, "-fflags") {
		t.Fatal("fallback discarded the timestamp-preserving video path")
	}
	if !strings.Contains(joined[input:], "-c:v copy -an") {
		t.Fatal("unsupported audio reached the output or video was transcoded")
	}
}

// End to end through StartBridge: an origin whose clock wraps reaches the relay
// continuous, and the relay ends (for the supervisor to recover) when the origin stops.
func TestHTTPBridgeFeedsRelayAContinuousClock(t *testing.T) {
	stream := flvHeader()
	stream = append(stream, flvTag(9, 0, avcHeader)...)
	for i, v := range []uint32{47721700, 47721740, 47721780, 0, 40, 80} {
		stream = append(stream, flvTag(9, v, avcFrame(i == 0, 0, byte(i)))...)
	}
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rtp/gb_wrap.live.flv" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(stream)
	}))
	defer origin.Close()
	dir := t.TempDir()
	received := filepath.Join(dir, "relay-input.flv")
	relay := filepath.Join(dir, "relay")
	if err := os.WriteFile(relay, []byte("#!/bin/sh\ncat > "+received+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	c := BridgeConfig{FFmpeg: relay, HTTPBase: origin.URL, RTSPBase: "rtsp://127.0.0.1:8556", RTMPBase: "rtmp://127.0.0.1:1935"}
	b, _, err := StartBridge(context.Background(), c, MediaLease{Stream: "gb_wrap"}, "live", "fixed", "")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-b.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("relay outlived its finished origin")
	}
	data, err := os.ReadFile(received)
	if err != nil {
		t.Fatal(err)
	}
	tags := parseTags(t, data)
	want := []uint32{0, 47721700, 47721740, 47721780, 47721820, 47721860, 47721900}
	if len(tags) != len(want) {
		t.Fatalf("relay received %d tags, want %d", len(tags), len(want))
	}
	for i, tag := range tags {
		if tag.ts != want[i] {
			t.Fatalf("tag %d: ts %d, want %d", i, tag.ts, want[i])
		}
	}
}
