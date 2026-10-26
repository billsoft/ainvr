package onvif

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/netip"
	"sync"
	"time"
)

func netipAddress(ip net.IP) (netip.Addr, error) {
	a, ok := netip.AddrFromSlice(ip)
	if !ok {
		return netip.Addr{}, failure("invalid_address")
	}
	return a.Unmap(), nil
}

type Settings struct {
	Revision   int64    `json:"revision"`
	Enabled    bool     `json:"enabled"`
	Policy     Policy   `json:"policy"`
	Interfaces []string `json:"interfaces"`
}
type Server struct {
	mu        sync.RWMutex
	settings  Settings
	token     [32]byte
	slots     chan struct{}
	discovery chan struct{}
}

func NewServer(token string) (*Server, error) {
	if len(token) < 32 || len(token) > 512 {
		return nil, failure("invalid_service_token")
	}
	return &Server{token: sha256.Sum256([]byte(token)), slots: make(chan struct{}, 4), discovery: make(chan struct{}, 1)}, nil
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func decode(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 32768)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return failure("invalid_request")
	}
	if d.Decode(&struct{}{}) != io.EOF {
		return failure("invalid_request")
	}
	return nil
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	actual := sha256.Sum256([]byte(r.Header.Get("X-Service-Token")))
	if subtle.ConstantTimeCompare(actual[:], s.token[:]) != 1 {
		writeJSON(w, 401, map[string]string{"error": "unauthorized"})
		return
	}
	if r.URL.Path == "/health" && r.Method == "GET" {
		s.mu.RLock()
		v := s.settings
		s.mu.RUnlock()
		writeJSON(w, 200, map[string]any{"ready": true, "revision": v.Revision, "enabled": v.Enabled, "active": len(s.slots), "capacity": cap(s.slots)})
		return
	}
	if r.URL.Path == "/v1/config" && r.Method == "PUT" {
		var v Settings
		if e := decode(w, r, &v); e != nil {
			writeJSON(w, 400, e)
			return
		}
		if v.Revision < 1 || len(v.Interfaces) > 16 || v.Policy.Validate() != nil {
			writeJSON(w, 400, map[string]string{"error": "invalid_config"})
			return
		}
		if v.Enabled && len(v.Policy.AllowedCIDRs) == 0 {
			writeJSON(w, 400, map[string]string{"error": "camera_network_required"})
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if v.Revision < s.settings.Revision {
			writeJSON(w, 409, map[string]string{"error": "stale_revision"})
			return
		}
		if v.Revision == s.settings.Revision {
			a, _ := json.Marshal(v)
			b, _ := json.Marshal(s.settings)
			if string(a) != string(b) {
				writeJSON(w, 409, map[string]string{"error": "revision_conflict"})
				return
			}
		}
		s.settings = v
		writeJSON(w, 200, map[string]any{"appliedRevision": v.Revision})
		return
	}
	s.mu.RLock()
	settings := s.settings
	s.mu.RUnlock()
	if !settings.Enabled {
		writeJSON(w, 503, map[string]string{"error": "onvif_disabled"})
		return
	}
	if r.Method != "POST" || (r.URL.Path != "/v1/probe" && r.URL.Path != "/v1/resolve" && r.URL.Path != "/v1/discover") {
		writeJSON(w, 404, map[string]string{"error": "not_found"})
		return
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		writeJSON(w, 429, map[string]string{"error": "capacity_exceeded"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	if r.URL.Path == "/v1/discover" {
		var req struct {
			Interface string `json:"interface"`
		}
		if decode(w, r, &req) != nil {
			writeJSON(w, 400, map[string]string{"error": "invalid_request"})
			return
		}
		allowed := false
		for _, name := range settings.Interfaces {
			if req.Interface == name {
				allowed = true
			}
		}
		if !allowed {
			writeJSON(w, 400, map[string]string{"error": "interface_not_allowed"})
			return
		}
		select {
		case s.discovery <- struct{}{}:
			defer func() { <-s.discovery }()
		default:
			writeJSON(w, 429, map[string]string{"error": "discovery_busy"})
			return
		}
		items, e := Discover(ctx, req.Interface, settings.Policy)
		if e != nil {
			writeJSON(w, 422, map[string]string{"error": Code(e)})
			return
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return
	}
	var req struct {
		Device      Device `json:"device"`
		Service     string `json:"service,omitempty"`
		Token       string `json:"token,omitempty"`
		VideoSource string `json:"videoSource,omitempty"`
	}
	if decode(w, r, &req) != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid_request"})
		return
	}
	client, e := NewClient(req.Device, settings.Policy)
	if e != nil {
		writeJSON(w, 400, map[string]string{"error": Code(e)})
		return
	}
	defer client.Close()
	var result any
	if r.URL.Path == "/v1/probe" {
		result, e = client.Probe(ctx)
	} else {
		if (req.Service != "media1" && req.Service != "media2") || req.Token == "" || len(req.Token) > 256 || req.VideoSource == "" {
			writeJSON(w, 400, map[string]string{"error": "invalid_profile"})
			return
		}
		result, e = client.Resolve(ctx, req.Service, req.Token, req.VideoSource)
	}
	if e != nil {
		writeJSON(w, 422, map[string]string{"error": Code(e)})
		return
	}
	writeJSON(w, 200, result)
}
