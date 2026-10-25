package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/emiago/sipgo"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Binding struct {
	ID        string `json:"id"`
	DeviceID  string `json:"deviceId"`
	ChannelID string `json:"channelId"`
	App       string `json:"app"`
	Stream    string `json:"stream"`
	Mode      string `json:"mode"`
	Enabled   bool   `json:"enabled"`
}
type RuntimeConfig struct {
	Revision int64        `json:"revision"`
	Enabled  bool         `json:"enabled"`
	SIP      Config       `json:"sip"`
	Media    MediaConfig  `json:"media"`
	Bridge   BridgeConfig `json:"bridge"`
	SRSAPI   string       `json:"srsApi"`
	Bindings []Binding    `json:"bindings"`
}
type InputState struct {
	ID         string    `json:"id"`
	State      string    `json:"state"`
	Reason     string    `json:"reason,omitempty"`
	Audio      string    `json:"audio,omitempty"`
	Generation string    `json:"generation,omitempty"`
	UpdatedAt  time.Time `json:"updatedAt"`
}
type Runtime struct {
	config    RuntimeConfig
	server    *Server
	receiver  *MediaReceiver
	mu        sync.Mutex
	states    map[string]InputState
	listeners atomic.Int32
}

func NewRuntime(c RuntimeConfig) (*Runtime, error) {
	if !c.Enabled {
		return &Runtime{config: c, states: map[string]InputState{}}, nil
	}
	if !trustedMediaBase(c.SRSAPI, "http") {
		return nil, errors.New("SRS API must be a trusted loopback endpoint")
	}
	if c.Media.DomainID != c.SIP.ServerID {
		return nil, errors.New("media domain must match SIP platform identity")
	}
	devices := map[string]bool{}
	for _, d := range c.SIP.Devices {
		devices[d.ID] = true
	}
	if len(c.Bindings) > 10000 {
		return nil, errors.New("too many bindings")
	}
	seen, outputs := map[string]bool{}, map[string]bool{}
	enabled := 0
	for _, b := range c.Bindings {
		if !devices[b.DeviceID] {
			return nil, errors.New("binding device is not provisioned")
		}
		if !streamPart.MatchString(b.ID) || !deviceIDPattern.MatchString(b.DeviceID) || !deviceIDPattern.MatchString(b.ChannelID) || !streamPart.MatchString(b.App) || !streamPart.MatchString(b.Stream) || seen[b.ID] || outputs[b.App+"/"+b.Stream] {
			return nil, errors.New("invalid or duplicate binding")
		}
		if b.Mode != "udp" && b.Mode != "tcp-passive" && b.Mode != "tcp-active" {
			return nil, errors.New("invalid binding transport")
		}
		seen[b.ID] = true
		outputs[b.App+"/"+b.Stream] = true
		if b.Enabled {
			enabled++
		}
	}
	if enabled > c.Media.Capacity {
		return nil, errors.New("enabled inputs exceed capacity")
	}
	m, e := NewMediaReceiver(c.Media)
	if e != nil {
		return nil, e
	}
	s, e := NewServer(c.SIP)
	if e != nil {
		return nil, e
	}
	return &Runtime{config: c, server: s, receiver: m, states: map[string]InputState{}}, nil
}
func (r *Runtime) set(b Binding, state, reason, audio, generation string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.states[b.ID] = InputState{ID: b.ID, State: state, Reason: reason, Audio: audio, Generation: generation, UpdatedAt: time.Now()}
}
func (r *Runtime) Snapshot() map[string]any {
	r.mu.Lock()
	states := make([]InputState, 0, len(r.states))
	for _, s := range r.states {
		states = append(states, s)
	}
	r.mu.Unlock()
	devices := []DeviceState{}
	if r.server != nil {
		devices = r.server.Snapshot()
	}
	return map[string]any{"revision": r.config.Revision, "enabled": r.config.Enabled, "ready": r.listeners.Load() == 2, "inputs": states, "devices": devices, "validation": "development_unverified"}
}
func (r *Runtime) Refresh(ctx context.Context, id string) error {
	if r.server == nil {
		return errors.New("gateway disabled")
	}
	return r.server.RefreshCatalog(ctx, id)
}
func (r *Runtime) Run(ctx context.Context) error {
	if r.server == nil {
		<-ctx.Done()
		return nil
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer r.server.Close()
	var workers sync.WaitGroup
	for _, b := range r.config.Bindings {
		if !b.Enabled {
			r.set(b, "disabled", "", "", "")
			continue
		}
		workers.Add(1)
		go func(binding Binding) { defer workers.Done(); r.worker(ctx, binding) }(b)
	}
	// Keep catalog discovery independent of enabled media. Queries remain bounded.
	workers.Add(1)
	go func() {
		defer workers.Done()
		runDiscovery(ctx, r.server.Snapshot, r.server.RefreshQuery, 5*time.Second, 30*time.Second, 4)
	}()
	listenCtx := context.WithValue(ctx, sipgo.ListenReadyCtxKey, sipgo.ListenReadyFuncCtxValue(func(string, string) { r.listeners.Add(1) }))
	e := r.server.Run(listenCtx)
	r.listeners.Store(0)
	cancel()
	workers.Wait()
	return e
}
func wait(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
func (r *Runtime) worker(ctx context.Context, b Binding) {
	backoff := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		reason := r.stream(ctx, b)
		if ctx.Err() != nil {
			return
		}
		r.set(b, "recovering", reason, "", "")
		if time.Since(started) > 30*time.Second {
			backoff = time.Second
		}
		if !wait(ctx, backoff) {
			return
		}
		backoff *= 2
		if backoff > 15*time.Second {
			backoff = 15 * time.Second
		}
	}
}
func (m *MediaReceiver) tracks(ctx context.Context, l MediaLease) (string, string, error) {
	result, e := m.call(ctx, "getMediaInfo", url.Values{"schema": {"rtsp"}, "vhost": {"__defaultVhost__"}, "app": {"rtp"}, "stream": {l.Stream}})
	if e != nil {
		return "", "", e
	}
	var tracks []struct {
		Type  int    `json:"codec_type"`
		Name  string `json:"codec_id_name"`
		Ready bool   `json:"ready"`
	}
	if json.Unmarshal(result["tracks"], &tracks) != nil {
		return "", "", errors.New("invalid track metadata")
	}
	video, audio := "", ""
	for _, t := range tracks {
		if !t.Ready {
			continue
		}
		if t.Type == 0 {
			video = strings.ToLower(t.Name)
		}
		if t.Type == 1 {
			audio = strings.ToLower(t.Name)
		}
	}
	if video == "" {
		return "", "", errors.New("waiting for video track")
	}
	if video != "h264" && video != "h265" {
		return "", "", errors.New("unsupported video codec")
	}
	return video, audio, nil
}
func (r *Runtime) published(ctx context.Context, b Binding) bool {
	req, e := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(r.config.SRSAPI, "/")+"/api/v1/streams/", nil)
	if e != nil {
		return false
	}
	client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, e := client.Do(req)
	if e != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return false
	}
	var result struct {
		Code    int `json:"code"`
		Streams []struct {
			App     string `json:"app"`
			Name    string `json:"name"`
			Publish struct {
				Active bool `json:"active"`
			} `json:"publish"`
			Video *json.RawMessage `json:"video"`
		} `json:"streams"`
	}
	if json.NewDecoder(http.MaxBytesReader(nil, response.Body, 2*1024*1024)).Decode(&result) != nil || result.Code != 0 {
		return false
	}
	for _, s := range result.Streams {
		if s.App == b.App && s.Name == b.Stream && s.Publish.Active && s.Video != nil {
			return true
		}
	}
	return false
}
func (r *Runtime) stream(ctx context.Context, b Binding) string {
	online := false
	for _, d := range r.server.Snapshot() {
		if d.ID == b.DeviceID && d.Registered {
			online = true
			break
		}
	}
	if !online {
		r.set(b, "waiting_device", "", "", "")
		if !wait(ctx, time.Second) {
			return ""
		}
		return "device_offline"
	}
	l, e := r.receiver.Open(ctx, b.Mode)
	if e != nil {
		return "media_receiver_unavailable"
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		_ = r.receiver.Close(cleanup, l)
	}()
	r.set(b, "inviting", "", "", l.Stream)
	session, e := r.server.InviteLive(ctx, b.DeviceID, b.ChannelID, r.config.Media.AdvertiseIP, l)
	if e != nil {
		return "invite_failed"
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		_ = session.Close(cleanup)
	}()
	if b.Mode == "tcp-active" {
		if e := r.receiver.ConnectWithRetry(ctx, l, session.Answer.IP, session.Answer.Port); e != nil {
			return "media_connect_failed"
		}
	}
	r.set(b, "waiting_media", "", "", l.Stream)
	deadline := time.Now().Add(12 * time.Second)
	audio := ""
	for {
		_, a, e := r.receiver.tracks(ctx, l)
		if e == nil {
			audio = a
			break
		}
		if time.Now().After(deadline) {
			return "media_timeout"
		}
		if !wait(ctx, 250*time.Millisecond) {
			return ""
		}
	}
	bridgeCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	bridge, warning, e := StartBridge(bridgeCtx, r.config.Bridge, l, b.App, b.Stream, audio)
	if e != nil {
		return "bridge_start_failed"
	}
	defer func() {
		cancel()
		select {
		case <-bridge.Done():
		case <-time.After(5 * time.Second):
		}
	}()
	r.set(b, "publishing", warning, audio, l.Stream)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	lastPublished := time.Now()
	everPublished := false
	for {
		select {
		case <-ctx.Done():
			return ""
		case <-session.Dialog.Context().Done():
			return "device_ended_session"
		case <-bridge.Done():
			return "bridge_exited"
		case <-ticker.C:
			if r.published(ctx, b) {
				lastPublished = time.Now()
				everPublished = true
				r.set(b, "streaming", warning, audio, l.Stream)
			} else if time.Since(lastPublished) > 10*time.Second {
				return "srs_publish_timeout"
			}
			if everPublished {
				_, current, e := r.receiver.tracks(ctx, l)
				if e != nil {
					return "media_lost"
				}
				if current != audio {
					return "audio_tracks_changed"
				}
			}
			valid := false
			for _, d := range r.server.Snapshot() {
				if d.ID == b.DeviceID && d.Registered && d.Generation == session.DeviceGeneration {
					valid = true
					break
				}
			}
			if !valid {
				return "device_session_changed"
			}
		}
	}
}
