package onvif

import (
	"ainvr/ptzcontrol"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"
)

type preparedPTZ struct {
	target   *PTZTarget
	used     time.Time
	identity string
	revision int64
	refs     int
}
type ptzHTTP struct {
	mu         sync.Mutex
	targets    map[string]*preparedPTZ
	generation string
	control    *ptzcontrol.Controller
	slots      chan struct{}
	stopSlots  chan struct{}
}

func newPTZHTTP() *ptzHTTP {
	var epoch [16]byte
	if _, err := rand.Read(epoch[:]); err != nil {
		panic("PTZ boot identity unavailable")
	}
	return &ptzHTTP{generation: hex.EncodeToString(epoch[:]), targets: map[string]*preparedPTZ{}, control: ptzcontrol.New(), slots: make(chan struct{}, 8), stopSlots: make(chan struct{}, 2)}
}
func (p *ptzHTTP) Close() {
	p.control.Close()
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, t := range p.targets {
		t.target.client.Close()
	}
	p.targets = map[string]*preparedPTZ{}
}
func (p *ptzHTTP) Serve(w http.ResponseWriter, r *http.Request, settings Settings) {
	var req struct {
		Device      Device             `json:"device"`
		Service     string             `json:"service"`
		Token       string             `json:"token"`
		VideoSource string             `json:"videoSource"`
		Context     string             `json:"context"`
		Command     ptzcontrol.Command `json:"command"`
		PresetID    string             `json:"presetId"`
		Name        string             `json:"name"`
	}
	if r.Method != "POST" || decode(w, r, &req) != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid_request"})
		return
	}
	stopping := r.URL.Path == "/v1/ptz/command" && req.Command.Stop
	if !settings.Enabled && !stopping {
		writeJSON(w, 503, map[string]string{"error": "onvif_disabled"})
		return
	}
	slots := p.slots
	if stopping {
		slots = p.stopSlots
	}
	select {
	case slots <- struct{}{}:
		defer func() { <-slots }()
	default:
		writeJSON(w, 429, map[string]string{"error": "ptz_capacity_exceeded"})
		return
	}
	if r.URL.Path == "/v1/ptz/prepare" {
		if (req.Service != "media1" && req.Service != "media2") || req.Token == "" || len(req.Token) > 256 || req.VideoSource == "" || len(req.VideoSource) > 256 {
			writeJSON(w, 400, map[string]string{"error": "invalid_profile"})
			return
		}
		// Only a digest is retained; credentials/policy never enter logs or replies.
		encoded, _ := json.Marshal([]any{req.Device, req.Service, req.Token, req.VideoSource, settings.Policy})
		identity := fmtPTZIdentity(encoded)
		p.mu.Lock()
		for key, v := range p.targets {
			if v.revision == settings.Revision && v.identity == identity && time.Since(v.used) < 30*time.Second {
				v.used = time.Now()
				p.mu.Unlock()
				writeJSON(w, 200, map[string]any{"context": key, "generation": p.generation, "serverTimeMs": time.Now().UnixMilli(), "capabilities": v.target.caps})
				return
			}
		}
		for key, v := range p.targets {
			if v.refs == 0 && time.Since(v.used) > 10*time.Minute {
				v.target.client.Close()
				delete(p.targets, key)
			}
		}
		p.evictIdleLocked()
		full := len(p.targets) >= 128
		p.mu.Unlock()
		if full {
			writeJSON(w, 429, map[string]string{"error": "ptz_capacity_exceeded"})
			return
		}
		client, e := NewClient(req.Device, settings.Policy)
		if e != nil {
			writeJSON(w, 422, map[string]string{"error": Code(e)})
			return
		}
		t, e := client.PreparePTZ(r.Context(), req.Service, req.Token, req.VideoSource)
		if e != nil {
			client.Close()
			writeJSON(w, 422, map[string]string{"error": Code(e)})
			return
		}
		if t.caps.Resource == "" {
			client.Close()
			writeJSON(w, 200, map[string]any{"capabilities": t.caps})
			return
		}
		var nonce [24]byte
		if _, e = rand.Read(nonce[:]); e != nil {
			client.Close()
			writeJSON(w, 503, map[string]string{"error": "ptz_unavailable"})
			return
		}
		key := hex.EncodeToString(nonce[:])
		p.mu.Lock()
		p.evictIdleLocked()
		if len(p.targets) >= 128 {
			p.mu.Unlock()
			client.Close()
			writeJSON(w, 429, map[string]string{"error": "ptz_capacity_exceeded"})
			return
		}
		p.targets[key] = &preparedPTZ{target: t, used: time.Now(), identity: identity, revision: settings.Revision}
		p.mu.Unlock()
		writeJSON(w, 200, map[string]any{"context": key, "generation": p.generation, "serverTimeMs": time.Now().UnixMilli(), "capabilities": t.caps})
		return
	}
	p.mu.Lock()
	prepared := p.targets[req.Context]
	if prepared != nil {
		prepared.used = time.Now()
		prepared.refs++
	}
	p.mu.Unlock()
	if prepared == nil {
		writeJSON(w, 409, map[string]string{"error": "ptz_context_expired"})
		return
	}
	defer func() { p.mu.Lock(); prepared.refs--; p.mu.Unlock() }()
	if !stopping && prepared.revision != settings.Revision {
		writeJSON(w, 409, map[string]string{"error": "ptz_context_expired"})
		return
	}
	t := prepared.target
	var result any
	var e error
	switch r.URL.Path {
	case "/v1/ptz/command":
		result, e = p.control.Execute(r.Context(), t.caps.Resource, t, req.Command)
	case "/v1/ptz/presets":
		result, e = t.Presets(r.Context())
	case "/v1/ptz/status":
		result, e = t.Status(r.Context())
	case "/v1/ptz/preset-save":
		var id string
		id, e = t.SetPreset(r.Context(), req.PresetID, req.Name)
		result = map[string]string{"id": id}
	case "/v1/ptz/preset-remove":
		e = t.RemovePreset(r.Context(), req.PresetID)
		result = map[string]bool{"removed": e == nil}
	default:
		writeJSON(w, 404, map[string]string{"error": "not_found"})
		return
	}
	if e != nil {
		code := Code(e)
		if strings.HasPrefix(e.Error(), "ptz_") {
			code = e.Error()
		}
		writeJSON(w, 422, map[string]string{"error": code})
		return
	}
	writeJSON(w, 200, result)
}

func fmtPTZIdentity(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

// Active requests and recent contexts (including watchdog-bound drivers) are
// protected. Eviction never changes the controller's captured Stop target.
func (p *ptzHTTP) evictIdleLocked() {
	if len(p.targets) < 128 {
		return
	}
	var oldest string
	for key, v := range p.targets {
		if v.refs == 0 && time.Since(v.used) > 30*time.Second && (oldest == "" || v.used.Before(p.targets[oldest].used)) {
			oldest = key
		}
	}
	if oldest != "" {
		p.targets[oldest].target.client.Close()
		delete(p.targets, oldest)
	}
}
