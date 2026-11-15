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
	// One media worker per enabled binding, so camera and channel edits can be
	// applied in place instead of restarting every registration and stream.
	work    func(context.Context, Binding)
	runCtx  context.Context
	workers map[string]*bindingWorker
	running sync.WaitGroup
	// stopWait bounds how long an edit waits for stopping sessions; a changed
	// binding's replacement still waits for its own predecessor to exit.
	stopWait time.Duration
	// One media-server stream list per second, shared by every channel.
	streamsMu sync.Mutex
	streamsAt time.Time
	streams   map[string]bool
}

type bindingWorker struct {
	binding Binding
	cancel  context.CancelFunc
	done    chan struct{}
}

// samePlatform reports whether two configurations differ only in provisioned
// cameras and channel bindings. Identity, listeners, media receiver, bridge and
// limits are fixed at installation; changing them still rebuilds the gateway.
func samePlatform(a, b RuntimeConfig) bool {
	strip := func(c RuntimeConfig) string {
		c.Revision, c.Bindings, c.SIP.Devices = 0, nil, nil
		bytes, _ := json.Marshal(c)
		return string(bytes)
	}
	return a.Enabled && b.Enabled && strip(a) == strip(b)
}

func validateRuntime(c RuntimeConfig) error {
	if !trustedMediaBase(c.SRSAPI, "http") {
		return errors.New("SRS API must be a trusted loopback endpoint")
	}
	if c.Media.DomainID != c.SIP.ServerID {
		return errors.New("media domain must match SIP platform identity")
	}
	devices := map[string]bool{}
	for _, d := range c.SIP.Devices {
		devices[d.ID] = true
	}
	if len(c.Bindings) > 10000 {
		return errors.New("too many bindings")
	}
	seen, outputs := map[string]bool{}, map[string]bool{}
	enabled := 0
	for _, b := range c.Bindings {
		if !devices[b.DeviceID] {
			return errors.New("binding device is not provisioned")
		}
		if !streamPart.MatchString(b.ID) || !deviceIDPattern.MatchString(b.DeviceID) || !deviceIDPattern.MatchString(b.ChannelID) || !streamPart.MatchString(b.App) || !streamPart.MatchString(b.Stream) || seen[b.ID] || outputs[b.App+"/"+b.Stream] {
			return errors.New("invalid or duplicate binding")
		}
		if b.Mode != "udp" && b.Mode != "tcp-passive" && b.Mode != "tcp-active" {
			return errors.New("invalid binding transport")
		}
		seen[b.ID] = true
		outputs[b.App+"/"+b.Stream] = true
		if b.Enabled {
			enabled++
		}
	}
	if enabled > c.Media.Capacity {
		return errors.New("enabled inputs exceed capacity")
	}
	return c.SIP.Validate()
}

func NewRuntime(c RuntimeConfig) (*Runtime, error) {
	if !c.Enabled {
		return &Runtime{config: c, states: map[string]InputState{}}, nil
	}
	if e := validateRuntime(c); e != nil {
		return nil, e
	}
	m, e := NewMediaReceiver(c.Media)
	if e != nil {
		return nil, e
	}
	s, e := NewServer(c.SIP)
	if e != nil {
		return nil, e
	}
	r := &Runtime{config: c, server: s, receiver: m, states: map[string]InputState{}, workers: map[string]*bindingWorker{}, stopWait: 10 * time.Second}
	r.work = r.worker
	return r, nil
}

// activate starts media workers for the current bindings under ctx.
func (r *Runtime) activate(ctx context.Context) {
	r.mu.Lock()
	r.runCtx = ctx
	bindings := r.config.Bindings
	r.mu.Unlock()
	r.reconcile(bindings)
}

// reconcile stops workers whose binding vanished, was disabled or changed, then
// starts workers for enabled bindings without one. Untouched streams keep running.
// A changed binding is stopped before its replacement starts, so the old session
// releases its media lease and output stream first.
func (r *Runtime) reconcile(bindings []Binding) {
	wanted := map[string]Binding{}
	for _, b := range bindings {
		wanted[b.ID] = b
	}
	r.mu.Lock()
	ctx := r.runCtx
	var stopping []*bindingWorker
	predecessor := map[string]*bindingWorker{}
	for id, w := range r.workers {
		if b, ok := wanted[id]; !ok || !b.Enabled || b != w.binding {
			w.cancel()
			stopping = append(stopping, w)
			predecessor[id] = w
			delete(r.workers, id)
		}
	}
	for id := range r.states {
		if _, ok := wanted[id]; !ok {
			delete(r.states, id)
		}
	}
	r.mu.Unlock()
	// One shared bound, so a batch edit of many channels cannot multiply it.
	limit := r.stopWait
	if limit <= 0 {
		limit = 10 * time.Second
	}
	deadline := time.NewTimer(limit)
	defer deadline.Stop()
	for _, w := range stopping {
		select {
		case <-w.done:
			continue
		case <-deadline.C:
		}
		break
	}
	if ctx == nil || ctx.Err() != nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, b := range bindings {
		if !b.Enabled {
			r.states[b.ID] = InputState{ID: b.ID, State: "disabled", UpdatedAt: time.Now()}
			continue
		}
		if r.workers[b.ID] != nil {
			continue
		}
		workerCtx, cancel := context.WithCancel(ctx)
		w := &bindingWorker{binding: b, cancel: cancel, done: make(chan struct{})}
		r.workers[b.ID] = w
		r.running.Add(1)
		go func(binding Binding, previous *bindingWorker) {
			defer r.running.Done()
			defer close(w.done)
			// The old session of this channel must release its media lease and
			// output stream before the new one starts, however long it takes.
			if previous != nil {
				select {
				case <-previous.done:
				case <-workerCtx.Done():
					return
				}
			}
			r.work(workerCtx, binding)
		}(b, predecessor[b.ID])
	}
}

// Update applies camera and channel edits in place. Callers use it only when
// samePlatform holds; an invalid configuration leaves the running site untouched.
func (r *Runtime) Update(c RuntimeConfig) error {
	if r.server == nil || !samePlatform(r.config, c) {
		return errors.New("platform settings changed; rebuild required")
	}
	if e := validateRuntime(c); e != nil {
		return e
	}
	if e := r.server.UpdateDevices(c.SIP.Devices); e != nil {
		return e
	}
	// Platform fields are identical and read by live sessions; replace only the
	// parts that changed.
	r.mu.Lock()
	r.config.Revision, r.config.Bindings, r.config.SIP.Devices = c.Revision, c.Bindings, c.SIP.Devices
	r.mu.Unlock()
	r.reconcile(c.Bindings)
	return nil
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
	revision := r.config.Revision
	r.mu.Unlock()
	devices, unknown := []DeviceState{}, []UnknownDevice{}
	if r.server != nil {
		devices, unknown = r.server.Snapshot(), r.server.Unknown()
	}
	return map[string]any{"revision": revision, "enabled": r.config.Enabled, "ready": r.listeners.Load() == 2, "inputs": states, "devices": devices, "unknownDevices": unknown, "validation": "development_unverified"}
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
	r.activate(ctx)
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
	r.running.Wait()
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

var errUnsupportedVideoCodec = errors.New("unsupported video codec")

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
		return "", "", errUnsupportedVideoCodec
	}
	return video, audio, nil
}

// published reports whether the channel's output is live on the media server.
// Every channel checks once per second; they share one stream list per second
// instead of each fetching and decoding the whole list.
func (r *Runtime) published(ctx context.Context, b Binding) bool {
	r.streamsMu.Lock()
	defer r.streamsMu.Unlock()
	if r.streams == nil || time.Since(r.streamsAt) >= 900*time.Millisecond {
		live := r.fetchStreams(ctx)
		if ctx.Err() != nil {
			// A stopping channel's aborted request says nothing about the others.
			return false
		}
		r.streams, r.streamsAt = live, time.Now()
	}
	return r.streams[b.App+"/"+b.Stream]
}

// fetchStreams returns the live outputs with video; an empty set on failure.
func (r *Runtime) fetchStreams(ctx context.Context) map[string]bool {
	live := map[string]bool{}
	// The media server lists only the first 10 streams unless a count is given.
	req, e := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(r.config.SRSAPI, "/")+"/api/v1/streams/?start=0&count=1000", nil)
	if e != nil {
		return live
	}
	client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, e := client.Do(req)
	if e != nil {
		return live
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return live
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
		return live
	}
	for _, s := range result.Streams {
		if s.Publish.Active && s.Video != nil {
			live[s.App+"/"+s.Name] = true
		}
	}
	return live
}
func (r *Runtime) stream(ctx context.Context, b Binding) string {
	if online, _ := r.server.session(b.DeviceID); !online {
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
		if errors.Is(e, errUnsupportedVideoCodec) {
			return "unsupported_video_codec"
		}
		if e == nil {
			if err := r.receiver.VerifyPeer(ctx, l, session.Answer.IP); err != nil {
				if errors.Is(err, errMediaPeerMismatch) {
					return "media_peer_mismatch"
				}
				return "media_receiver_unavailable"
			}
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
				if err := r.receiver.VerifyPeer(ctx, l, session.Answer.IP); err != nil {
					if errors.Is(err, errMediaPeerMismatch) {
						return "media_peer_mismatch"
					}
					return "media_receiver_unavailable"
				}
				_, current, e := r.receiver.tracks(ctx, l)
				if e != nil {
					return "media_lost"
				}
				if current != audio {
					return "audio_tracks_changed"
				}
			}
			if online, generation := r.server.session(b.DeviceID); !online || generation != session.DeviceGeneration {
				return "device_session_changed"
			}
		}
	}
}
