package gateway

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"
)

// Manager owns only gateway processes. Configuration remains authoritative in
// the console parameter database and must be resent after a gateway restart.
type Manager struct {
	applyMu   sync.Mutex
	mu        sync.Mutex
	runtime   *Runtime
	cancel    context.CancelFunc
	done      chan struct{}
	hash      [32]byte
	lastError string
}

func (m *Manager) Apply(ctx context.Context, c RuntimeConfig) error {
	if c.Revision < 1 || ctx.Err() != nil {
		return errors.New("invalid configuration lifetime or revision")
	}
	m.applyMu.Lock()
	defer m.applyMu.Unlock()
	bytes, e := json.Marshal(c)
	if e != nil {
		return e
	}
	hash := sha256.Sum256(bytes)
	m.mu.Lock()
	old := m.runtime
	if old != nil && old.config.Revision > c.Revision {
		m.mu.Unlock()
		return errors.New("stale configuration revision")
	}
	if old != nil && old.config.Revision == c.Revision {
		if hash != m.hash {
			m.mu.Unlock()
			return errors.New("revision content conflict")
		}
		if m.lastError == "" {
			m.mu.Unlock()
			return nil
		}
	}
	m.mu.Unlock()
	next, e := NewRuntime(c)
	if e != nil {
		return e
	}
	m.mu.Lock()
	cancel, done := m.cancel, m.done
	m.mu.Unlock()
	if cancel != nil {
		cancel()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			if next.server != nil {
				next.server.Close()
			}
			return errors.New("previous gateway did not stop")
		}
	}
	runCtx, stop := context.WithCancel(ctx)
	finished := make(chan struct{})
	m.mu.Lock()
	m.runtime = next
	m.cancel = stop
	m.done = finished
	m.hash = hash
	m.lastError = ""
	m.mu.Unlock()
	go func() {
		defer close(finished)
		e := next.Run(runCtx)
		if e != nil && runCtx.Err() == nil {
			m.mu.Lock()
			if m.runtime == next {
				m.lastError = "gateway_listener_failed"
			}
			m.mu.Unlock()
		}
	}()
	return nil
}
func (m *Manager) Status() map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.runtime == nil {
		return map[string]any{"configured": false, "enabled": false, "revision": 0, "state": "waiting_configuration"}
	}
	result := m.runtime.Snapshot()
	result["configured"] = true
	result["error"] = m.lastError
	return result
}
func (m *Manager) Close() {
	m.applyMu.Lock()
	defer m.applyMu.Unlock()
	m.mu.Lock()
	cancel, done := m.cancel, m.done
	m.mu.Unlock()
	if cancel != nil {
		cancel()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
		}
	}
}
func (m *Manager) Handler(lifetime context.Context, token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/status", func(w http.ResponseWriter, r *http.Request) { _ = json.NewEncoder(w).Encode(m.Status()) })
	mux.HandleFunc("POST /v1/config", func(w http.ResponseWriter, r *http.Request) {
		var config RuntimeConfig
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4*1024*1024))
		d.DisallowUnknownFields()
		if d.Decode(&config) != nil || d.Decode(new(any)) != io.EOF {
			http.Error(w, "invalid configuration", 400)
			return
		}
		if e := m.Apply(lifetime, config); e != nil {
			http.Error(w, e.Error(), 409)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(m.Status())
	})
	mux.HandleFunc("POST /v1/devices/{id}/catalog-refresh", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		runtime := m.runtime
		m.mu.Unlock()
		if runtime == nil {
			http.Error(w, "not configured", 503)
			return
		}
		if e := runtime.Refresh(r.Context(), r.PathValue("id")); e != nil {
			http.Error(w, "directory refresh unavailable", 503)
			return
		}
		w.WriteHeader(202)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		got := sha256.Sum256([]byte(r.Header.Get("X-Service-Token")))
		expected := sha256.Sum256([]byte(token))
		if len(token) < 32 || len(r.Header.Get("X-Service-Token")) > 512 || subtle.ConstantTimeCompare(got[:], expected[:]) != 1 {
			http.Error(w, "unauthorized", 401)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
