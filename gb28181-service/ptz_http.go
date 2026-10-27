package gateway

import (
	"ainvr/ptzcontrol"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

func (m *Manager) ptzHTTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Binding    string             `json:"binding"`
		Revision   int64              `json:"revision"`
		Generation uint64             `json:"generation"`
		Command    ptzcontrol.Command `json:"command"`
		PresetID   string             `json:"presetId"`
		Name       string             `json:"name"`
	}
	fail := func(status int, code string) {
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(map[string]string{"error": code})
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	d.DisallowUnknownFields()
	if r.Method != "POST" || d.Decode(&req) != nil || d.Decode(new(any)) != io.EOF {
		fail(400, "ptz_invalid_request")
		return
	}
	m.mu.Lock()
	runtime := m.runtime
	m.mu.Unlock()
	if runtime == nil || runtime.server == nil {
		fail(503, "ptz_gateway_disabled")
		return
	}
	slots := runtime.server.ptzSlots
	if r.URL.Path == "/v1/ptz/command" && req.Command.Stop {
		slots = runtime.server.ptzStopSlots
	}
	select {
	case slots <- struct{}{}:
		defer func() { <-slots }()
	default:
		fail(429, "ptz_capacity_exceeded")
		return
	}
	var binding *Binding
	for i := range runtime.config.Bindings {
		if runtime.config.Bindings[i].ID == req.Binding {
			binding = &runtime.config.Bindings[i]
			break
		}
	}
	if binding == nil || !binding.Enabled {
		fail(409, "ptz_source_unavailable")
		return
	}
	t, e := runtime.server.ptzTarget(binding.DeviceID, binding.ChannelID)
	if e != nil {
		fail(409, e.Error())
		return
	}
	if r.URL.Path == "/v1/ptz/prepare" {
		kind := ""
		runtime.server.mu.Lock()
		for _, item := range runtime.server.states[binding.DeviceID].Catalog {
			if item.ID == binding.ChannelID {
				kind = item.Info.PTZType
				break
			}
		}
		runtime.server.mu.Unlock()
		// A structural camera type is a hint, not proof of a motor or zoom lens.
		// The console combines this with explicit per-camera capability confirmation.
		json.NewEncoder(w).Encode(map[string]any{"resource": binding.DeviceID + "/" + binding.ChannelID, "revision": runtime.config.Revision, "generation": t.generation, "ptzType": kind, "evidence": "catalog_hint", "position": false, "serverTimeMs": time.Now().UnixMilli()})
		return
	}
	if req.Revision != runtime.config.Revision || req.Generation != t.generation {
		fail(409, "ptz_source_changed")
		return
	}
	var result any
	switch r.URL.Path {
	case "/v1/ptz/command":
		result, e = runtime.server.ptz.Execute(r.Context(), binding.DeviceID+"/"+binding.ChannelID, t, req.Command)
	case "/v1/ptz/presets":
		result, e = t.Presets(r.Context())
	case "/v1/ptz/preset-save":
		e = t.SavePreset(r.Context(), req.PresetID, req.Name)
		result = map[string]any{"id": req.PresetID, "deliveryAccepted": e == nil, "positionConfirmed": false}
	case "/v1/ptz/preset-remove":
		e = t.RemovePreset(r.Context(), req.PresetID)
		result = map[string]any{"deliveryAccepted": e == nil}
	default:
		fail(404, "not_found")
		return
	}
	if e != nil {
		code := "ptz_unavailable"
		if strings.HasPrefix(e.Error(), "ptz_") {
			code = e.Error()
		}
		fail(422, code)
		return
	}
	json.NewEncoder(w).Encode(result)
}
