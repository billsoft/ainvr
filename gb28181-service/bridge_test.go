package gateway

import (
	"strings"
	"testing"
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
	if !strings.Contains(value, "http://127.0.0.1:8097/rtp/gb_test.live.flv") || !strings.Contains(value, "-c:v copy") || !strings.Contains(value, "-c:a copy") {
		t.Fatal("invalid HTTP FLV copy bridge")
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
