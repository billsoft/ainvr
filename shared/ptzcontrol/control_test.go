package ptzcontrol

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type driver struct {
	mu             sync.Mutex
	moves, stops   int
	start, release chan struct{}
	failStop       bool
}

func (d *driver) Move(ctx context.Context, _ Vector, _ time.Duration) error {
	d.mu.Lock()
	d.moves++
	d.mu.Unlock()
	if d.start != nil {
		close(d.start)
		select {
		case <-d.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}
func (d *driver) Stop(context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.stops++
	if d.failStop {
		return errors.New("offline")
	}
	return nil
}
func (d *driver) Preset(ctx context.Context, _ string) error {
	return d.Move(ctx, Vector{}, time.Second)
}
func command(seq uint64) Command {
	return Command{Session: "session-111111111111", Sequence: seq, Vector: Vector{Pan: 1}, TTLMS: 150, ExpiresAtMS: time.Now().Add(150 * time.Millisecond).UnixMilli()}
}
func TestWatchdogClosesSessionWithoutBrowser(t *testing.T) {
	c := New()
	defer c.Close()
	d := &driver{}
	if _, e := c.Execute(context.Background(), "camera", d, command(1)); e != nil {
		t.Fatal(e)
	}
	time.Sleep(250 * time.Millisecond)
	d.mu.Lock()
	stops := d.stops
	d.mu.Unlock()
	if stops != 1 {
		t.Fatalf("stops=%d", stops)
	}
	if _, e := c.Execute(context.Background(), "camera", d, command(2)); !errors.Is(e, ErrStopped) {
		t.Fatal("expired session revived", e)
	}
}
func TestStopSupersedesInFlightMoveAndQueuedMove(t *testing.T) {
	c := New()
	defer c.Close()
	d := &driver{start: make(chan struct{}), release: make(chan struct{})}
	done := make(chan struct{})
	go func() { c.Execute(context.Background(), "camera", d, command(1)); close(done) }()
	<-d.start
	stopDone := make(chan struct{})
	go func() {
		cmd := command(3)
		cmd.Stop = true
		c.Execute(context.Background(), "camera", d, cmd)
		close(stopDone)
	}()
	time.Sleep(20 * time.Millisecond)
	if _, e := c.Execute(context.Background(), "camera", d, command(2)); !errors.Is(e, ErrStopped) {
		t.Fatal(e)
	}
	close(d.release)
	<-done
	<-stopDone
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.moves != 1 || d.stops != 1 {
		t.Fatalf("moves=%d stops=%d", d.moves, d.stops)
	}
}
func TestTwoStreamsShareResourceAndNVRChannelsDoNot(t *testing.T) {
	c := New()
	defer c.Close()
	d := &driver{}
	a := command(1)
	a.TTLMS = 1000
	a.ExpiresAtMS = time.Now().Add(time.Second).UnixMilli()
	if _, e := c.Execute(context.Background(), "node-a", d, a); e != nil {
		t.Fatal(e)
	}
	b := a
	b.Session = "session-222222222222"
	if _, e := c.Execute(context.Background(), "node-a", d, b); !errors.Is(e, ErrBusy) {
		t.Fatal(e)
	}
	if _, e := c.Execute(context.Background(), "node-b", d, b); e != nil {
		t.Fatal(e)
	}
}
func TestSequenceKeepAliveAndFailureCannotResurrect(t *testing.T) {
	c := New()
	defer c.Close()
	d := &driver{}
	a := command(1)
	a.TTLMS = 1000
	a.ExpiresAtMS = time.Now().Add(time.Second).UnixMilli()
	c.Execute(context.Background(), "node", d, a)
	if _, e := c.Execute(context.Background(), "node", d, a); !errors.Is(e, ErrStale) {
		t.Fatal(e)
	}
	a.Sequence = 2
	a.KeepAlive = true
	a.Vector = Vector{}
	if _, e := c.Execute(context.Background(), "node", d, a); e != nil {
		t.Fatal(e)
	}
	d.mu.Lock()
	moves := d.moves
	d.failStop = true
	d.mu.Unlock()
	if moves != 1 {
		t.Fatal("keepalive repeated move")
	}
	a.Sequence = 3
	a.KeepAlive = false
	a.Stop = true
	if state, e := c.Execute(context.Background(), "node", d, a); e == nil || state.StopConfirmed {
		t.Fatal("failed Stop reported confirmed")
	}
	b := command(4)
	if _, e := c.Execute(context.Background(), "node", d, b); !errors.Is(e, ErrStopUnconfirmed) {
		t.Fatal(e)
	}
	d.mu.Lock()
	d.failStop = false
	d.mu.Unlock()
	a.Sequence = 5
	c.Execute(context.Background(), "node", d, a)
}

type delayedPreset struct {
	started   chan struct{}
	cancelled chan struct{}
	stops     int
	mu        sync.Mutex
}

func (d *delayedPreset) Move(context.Context, Vector, time.Duration) error { return nil }
func (d *delayedPreset) Stop(context.Context) error {
	d.mu.Lock()
	d.stops++
	d.mu.Unlock()
	return nil
}
func (d *delayedPreset) Preset(ctx context.Context, _ string) error {
	close(d.started)
	<-ctx.Done()
	close(d.cancelled)
	return ctx.Err()
}
func TestStopCancelsInFlightPresetQueryBeforeLateGoto(t *testing.T) {
	c := New()
	defer c.Close()
	d := &delayedPreset{started: make(chan struct{}), cancelled: make(chan struct{})}
	cmd := command(1)
	cmd.Preset = "gate"
	cmd.Vector = Vector{}
	cmd.TTLMS = 1500
	cmd.ExpiresAtMS = time.Now().Add(1500 * time.Millisecond).UnixMilli()
	done := make(chan struct{})
	go func() { c.Execute(context.Background(), "motor", d, cmd); close(done) }()
	<-d.started
	stop := command(2)
	stop.Stop = true
	if _, err := c.Execute(context.Background(), "motor", d, stop); err != nil {
		t.Fatal(err)
	}
	select {
	case <-d.cancelled:
	case <-time.After(time.Second):
		t.Fatal("preset was not cancelled")
	}
	<-done
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.stops != 1 {
		t.Fatal(d.stops)
	}
}

func TestLateCommandCannotRestartAnExpiredOrEvictedSession(t *testing.T) {
	c := New()
	defer c.Close()
	d := &driver{}
	cmd := command(1)
	cmd.ExpiresAtMS = time.Now().Add(-time.Millisecond).UnixMilli()
	if _, e := c.Execute(context.Background(), "new-motor", d, cmd); !errors.Is(e, ErrStale) {
		t.Fatal(e)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.moves != 0 {
		t.Fatal("expired move reached camera")
	}
}

func TestCancelledCallerStillDeliversStop(t *testing.T) {
	c := New()
	defer c.Close()
	d := &driver{}
	cmd := command(1)
	if _, e := c.Execute(context.Background(), "motor", d, cmd); e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	stop := command(2)
	stop.Stop = true
	if _, e := c.Execute(ctx, "motor", d, stop); e != nil {
		t.Fatal(e)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.stops != 1 {
		t.Fatal("caller cancellation swallowed Stop")
	}
}
