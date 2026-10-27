package gateway

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/url"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

var streamPart = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

type BridgeConfig struct {
	FFmpeg   string `json:"ffmpeg"`
	HTTPBase string `json:"httpBase"`
	RTSPBase string `json:"rtspBase"`
	RTMPBase string `json:"rtmpBase"`
}

func trustedMediaBase(value, scheme string) bool {
	u, e := url.Parse(value)
	if e != nil || u.Scheme != scheme || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" {
		return false
	}
	ip := net.ParseIP(u.Hostname())
	return ip != nil && ip.IsLoopback()
}

// These addresses belong to the gateway deployment, never to camera-provided
// SDP or user RTSP URL input. Video always uses stream copy.
func BridgeArgs(c BridgeConfig, lease MediaLease, app, stream, audioCodec string) ([]string, string, error) {
	if !trustedMediaBase(c.RTSPBase, "rtsp") || !trustedMediaBase(c.RTMPBase, "rtmp") || !streamPart.MatchString(lease.Stream) || !streamPart.MatchString(app) || !streamPart.MatchString(stream) {
		return nil, "", errors.New("invalid trusted bridge endpoints")
	}
	args := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-rtsp_transport", "tcp", "-timeout", "10000000", "-fflags", "+genpts", "-i", strings.TrimRight(c.RTSPBase, "/") + "/rtp/" + lease.Stream, "-map", "0:v:0", "-c:v", "copy"}
	if c.HTTPBase != "" {
		if !trustedMediaBase(c.HTTPBase, "http") {
			return nil, "", errors.New("invalid HTTP media endpoint")
		}
		// FLV preserves decode/presentation timestamps for B-frame video. RTP
		// timestamps alone cannot always recover both without video decoding.
		args = []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-rw_timeout", "10000000", "-i", strings.TrimRight(c.HTTPBase, "/") + "/rtp/" + lease.Stream + ".live.flv", "-map", "0:v:0", "-c:v", "copy"}
	}
	warning := ""
	switch strings.ToLower(audioCodec) {
	case "aac", "mpeg4-generic":
		args = append(args, "-map", "0:a:0?", "-c:a", "copy")
	case "g711a", "g711u", "pcma", "pcmu", "pcm_alaw", "pcm_mulaw":
		args = append(args, "-map", "0:a:0?", "-c:a", "aac", "-b:a", "64k", "-ar", "16000", "-ac", "1", "-threads:a", "1")
	case "":
		args = append(args, "-an")
	default:
		args = append(args, "-an")
		warning = "unsupported_audio_codec"
	}
	if warning != "" {
		// Disabling output audio alone still lets libavformat spend its entire
		// live probe budget identifying an unsupported input audio track. Keep
		// the timestamp-preserving FLV video path, explicitly discard input
		// audio and bound stream analysis instead of timing out the whole feed.
		for index, arg := range args {
			if arg == "-i" {
				prefix := append([]string(nil), args[:index]...)
				prefix = append(prefix, "-analyzeduration", "1000000", "-probesize", "1048576", "-an")
				args = append(prefix, args[index:]...)
				break
			}
		}
	}
	args = append(args, "-flvflags", "no_duration_filesize", "-f", "flv", strings.TrimRight(c.RTMPBase, "/")+"/"+app+"/"+stream)
	return args, warning, nil
}

type Bridge struct {
	cmd  *exec.Cmd
	done chan error
}
type bridgeLog struct {
	mu   sync.Mutex
	tail string
}

func (b *bridgeLog) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.tail += string(p)
	if len(b.tail) > 4096 {
		b.tail = b.tail[len(b.tail)-4096:]
	}
	return len(p), nil
}
func (b *bridgeLog) diagnostic() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return regexp.MustCompile(`(?:rtsp|rtmp|https?)://[^\s]+`).ReplaceAllString(b.tail, "<media-endpoint>")
}

func StartBridge(ctx context.Context, c BridgeConfig, lease MediaLease, app, stream, audio string) (*Bridge, string, error) {
	args, warning, e := BridgeArgs(c, lease, app, stream, audio)
	if e != nil {
		return nil, "", e
	}
	if c.FFmpeg == "" || !strings.HasPrefix(c.FFmpeg, "/") {
		return nil, "", errors.New("absolute FFmpeg executable required")
	}
	cmd := exec.CommandContext(ctx, c.FFmpeg, args...)
	// No media bytes or URLs in ordinary logs. A bounded structured error is
	// exposed by the supervisor; output pipes cannot deadlock the process.
	cmd.Stdout = io.Discard
	diagnostics := &bridgeLog{}
	cmd.Stderr = diagnostics
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = 3 * time.Second
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	if e := cmd.Start(); e != nil {
		return nil, "", errors.New("bridge failed to start")
	}
	b := &Bridge{cmd: cmd, done: make(chan error, 1)}
	go func() {
		err := cmd.Wait()
		if err != nil && ctx.Err() == nil {
			slog.Warn("media bridge exited", "diagnostic", diagnostics.diagnostic())
		}
		b.done <- err
		close(b.done)
	}()
	return b, warning, nil
}
func (b *Bridge) Done() <-chan error { return b.done }
