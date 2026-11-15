package gateway

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	devA = "34020000001320000001"
	devB = "34020000001320000011"
	chA1 = "34020000001320000002"
	chA2 = "34020000001320000003"
	chB1 = "34020000001320000012"
)

// A deployed site: two cameras provisioned, platform settings fixed at install.
func siteConfig(revision int64, bindings ...Binding) RuntimeConfig {
	return RuntimeConfig{
		Revision: revision,
		Enabled:  true,
		SIP: Config{ServerID: "34020000002000000001", Realm: "3402000000", Listen: "127.0.0.1:25060",
			AdvertiseIP: "127.0.0.1", MaxDevices: 16, MaxCatalogItems: 100, HeartbeatTimeoutSec: 180,
			Devices: []DeviceConfig{
				{ID: devA, Password: "camera-a-secret", Version: "2016", Enabled: true},
				{ID: devB, Password: "camera-b-secret", Version: "2016", Enabled: true},
			}},
		Media: MediaConfig{DomainID: "34020000002000000001", API: "http://127.0.0.1:18097", Secret: strings.Repeat("s", 16),
			ListenIP: "127.0.0.1", AdvertiseIP: "127.0.0.1", PortStart: 30000, PortEnd: 30100, Capacity: 4},
		SRSAPI:   "http://127.0.0.1:1985",
		Bindings: bindings,
	}
}

func binding(id, device, channel, mode string, enabled bool) Binding {
	return Binding{ID: id, DeviceID: device, ChannelID: channel, App: "live", Stream: "gb_" + id, Mode: mode, Enabled: enabled}
}

type workLog struct {
	mu      sync.Mutex
	started map[string]int
	stopped map[string]int
}

func (w *workLog) count(m map[string]int, id string) int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return m[id]
}

// Replace real media sessions with a recorder; a worker runs until cancelled.
func recordWorkers(r *Runtime) *workLog {
	log := &workLog{started: map[string]int{}, stopped: map[string]int{}}
	r.work = func(ctx context.Context, b Binding) {
		log.mu.Lock()
		log.started[b.ID]++
		log.mu.Unlock()
		<-ctx.Done()
		log.mu.Lock()
		log.stopped[b.ID]++
		log.mu.Unlock()
	}
	return log
}

func markRegistered(r *Runtime, ids ...string) {
	r.server.mu.Lock()
	defer r.server.mu.Unlock()
	for _, id := range ids {
		st := r.server.states[id]
		st.Registered, st.ExpiresAt, st.LastSeen, st.Generation = true, time.Now().Add(time.Hour), time.Now(), 7
	}
}

func registered(r *Runtime, id string) bool {
	for _, d := range r.server.Snapshot() {
		if d.ID == id {
			return d.Registered
		}
	}
	return false
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatal(what)
}

// Adding a channel, switching one camera's transport or disabling one input is
// routine on a live site. None of it may cost other cameras their registration
// or interrupt streams that did not change.
func TestBindingChangesKeepRegistrationsAndUntouchedStreams(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a1 := binding("a1", devA, chA1, "udp", true)
	r, e := NewRuntime(siteConfig(1, a1))
	if e != nil {
		t.Fatal(e)
	}
	log := recordWorkers(r)
	r.activate(ctx)
	markRegistered(r, devA, devB)
	eventually(t, "initial stream", func() bool { return log.count(log.started, "a1") == 1 })

	b1 := binding("b1", devB, chB1, "tcp-passive", true)
	if e := r.Update(siteConfig(2, a1, b1)); e != nil {
		t.Fatal(e)
	}
	eventually(t, "new channel starts", func() bool { return log.count(log.started, "b1") == 1 })
	if log.count(log.stopped, "a1") != 0 || log.count(log.started, "a1") != 1 {
		t.Fatal("adding a channel must not restart an untouched stream")
	}
	if !registered(r, devA) || !registered(r, devB) {
		t.Fatal("adding a channel must not drop registrations")
	}

	a1.Mode = "tcp-active"
	if e := r.Update(siteConfig(3, a1, b1)); e != nil {
		t.Fatal(e)
	}
	eventually(t, "changed channel restarts", func() bool { return log.count(log.started, "a1") == 2 })
	if log.count(log.stopped, "b1") != 0 {
		t.Fatal("changing one channel must not restart another")
	}

	b1.Enabled = false
	if e := r.Update(siteConfig(4, a1, b1)); e != nil {
		t.Fatal(e)
	}
	eventually(t, "disabled channel stops", func() bool { return log.count(log.stopped, "b1") == 1 })
	if r.Snapshot()["revision"] != int64(4) {
		t.Fatal("status must report the applied revision")
	}
	if !registered(r, devA) || !registered(r, devB) {
		t.Fatal("disabling an input must not drop registrations")
	}
}

// Credentials or enablement of one camera concern only that camera.
func TestDeviceChangesAffectOnlyThatDevice(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r, e := NewRuntime(siteConfig(1))
	if e != nil {
		t.Fatal(e)
	}
	recordWorkers(r)
	r.activate(ctx)
	markRegistered(r, devA, devB)

	c := siteConfig(2)
	c.SIP.Devices[0].Password = "camera-a-rotated"
	if e := r.Update(c); e != nil {
		t.Fatal(e)
	}
	if registered(r, devA) {
		t.Fatal("a new password must require the camera to authenticate again")
	}
	if !registered(r, devB) {
		t.Fatal("another camera's password change must not drop this one")
	}

	markRegistered(r, devA)
	c = siteConfig(3)
	c.SIP.Devices[0].Password = "camera-a-rotated"
	c.SIP.Devices[1].Enabled = false
	if e := r.Update(c); e != nil {
		t.Fatal(e)
	}
	if registered(r, devB) || !registered(r, devA) {
		t.Fatal("disabling one camera must drop only that camera")
	}

	c = siteConfig(4)
	c.SIP.Devices = c.SIP.Devices[:1]
	c.SIP.Devices[0].Password = "camera-a-rotated"
	if e := r.Update(c); e != nil {
		t.Fatal(e)
	}
	for _, d := range r.server.Snapshot() {
		if d.ID == devB {
			t.Fatal("a removed camera must disappear from status")
		}
	}
	if !registered(r, devA) {
		t.Fatal("removing another camera must not drop this one")
	}
}

// Invalid edits are rejected without disturbing the running site.
func TestInvalidUpdateLeavesRuntimeUntouched(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a1 := binding("a1", devA, chA1, "udp", true)
	r, e := NewRuntime(siteConfig(1, a1))
	if e != nil {
		t.Fatal(e)
	}
	log := recordWorkers(r)
	r.activate(ctx)
	markRegistered(r, devA)
	eventually(t, "initial stream", func() bool { return log.count(log.started, "a1") == 1 })
	orphan := binding("x1", "34020000001320000099", chA2, "udp", true)
	if r.Update(siteConfig(2, a1, orphan)) == nil {
		t.Fatal("binding to an unprovisioned camera must be rejected")
	}
	if log.count(log.stopped, "a1") != 0 || !registered(r, devA) || r.Snapshot()["revision"] != int64(1) {
		t.Fatal("rejected update must not change the running site")
	}
}

// Only platform-level settings (identity, ports, media receiver, bridge) need a
// fresh runtime; camera and channel edits are applied in place.
func TestManagerRebuildsOnlyForPlatformSettings(t *testing.T) {
	a1 := binding("a1", devA, chA1, "udp", true)
	base := siteConfig(1, a1)
	if !samePlatform(base, siteConfig(2, a1, binding("a2", devA, chA2, "tcp-passive", true))) {
		t.Fatal("channel edits are not platform changes")
	}
	devices := siteConfig(3, a1)
	devices.SIP.Devices[1].Password = "camera-b-rotated"
	if !samePlatform(base, devices) {
		t.Fatal("camera credential edits are not platform changes")
	}
	for name, change := range map[string]func(*RuntimeConfig){
		"sip port":   func(c *RuntimeConfig) { c.SIP.Listen = "127.0.0.1:25062" },
		"server id":  func(c *RuntimeConfig) { c.SIP.ServerID = "34020000002000000009"; c.Media.DomainID = c.SIP.ServerID },
		"media port": func(c *RuntimeConfig) { c.Media.PortStart = 30200; c.Media.PortEnd = 30300 },
		"heartbeat":  func(c *RuntimeConfig) { c.SIP.HeartbeatTimeoutSec = 300 },
		"capacity":   func(c *RuntimeConfig) { c.Media.Capacity = 2 },
		"disabled":   func(c *RuntimeConfig) { c.Enabled = false },
	} {
		c := siteConfig(4, a1)
		change(&c)
		if samePlatform(base, c) {
			t.Fatal(name + " must rebuild the gateway")
		}
	}
}

func TestManagerAppliesCameraAndChannelEditsInPlace(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := &Manager{}
	defer m.Close()
	a1 := binding("a1", devA, chA1, "udp", true)
	if e := m.Apply(ctx, siteConfig(1, a1)); e != nil {
		t.Fatal(e)
	}
	first := m.runtime
	edited := siteConfig(2, a1, binding("a2", devA, chA2, "tcp-passive", true))
	edited.SIP.Devices[1].Password = "camera-b-rotated"
	if e := m.Apply(ctx, edited); e != nil {
		t.Fatal(e)
	}
	if m.runtime != first || m.Status()["revision"] != int64(2) {
		t.Fatal("camera and channel edits must be applied to the running gateway")
	}
	platform := siteConfig(3, a1)
	platform.SIP.HeartbeatTimeoutSec = 300
	if e := m.Apply(ctx, platform); e != nil {
		t.Fatal(e)
	}
	if m.runtime == first || m.Status()["revision"] != int64(3) {
		t.Fatal("platform settings must rebuild the gateway")
	}
}
