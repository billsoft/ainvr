// Package ptzcontrol bounds physical camera commands independently of the browser
// and console process. Transport acknowledgement never means physical arrival.
package ptzcontrol

import (
	"context"
	"errors"
	"math"
	"sync"
	"time"
)

var ErrBusy = errors.New("ptz_busy")
var ErrStale = errors.New("ptz_stale_command")
var ErrStopped = errors.New("ptz_session_stopped")
var ErrStopUnconfirmed = errors.New("ptz_stop_unconfirmed")

type Vector struct {
	Pan  float64 `json:"pan"`
	Tilt float64 `json:"tilt"`
	Zoom float64 `json:"zoom"`
}

func (v Vector) Valid() bool {
	for _, n := range []float64{v.Pan, v.Tilt, v.Zoom} {
		if math.IsNaN(n) || math.IsInf(n, 0) || n < -1 || n > 1 {
			return false
		}
	}
	return true
}
func (v Vector) Zero() bool { return v.Pan == 0 && v.Tilt == 0 && v.Zoom == 0 }

type Driver interface {
	Move(context.Context, Vector, time.Duration) error
	Stop(context.Context) error
	Preset(context.Context, string) error
}
type Command struct {
	Session     string `json:"session"`
	Sequence    uint64 `json:"sequence"`
	Vector      Vector `json:"vector"`
	Preset      string `json:"preset,omitempty"`
	Stop        bool   `json:"stop,omitempty"`
	KeepAlive   bool   `json:"keepAlive,omitempty"`
	Emergency   bool   `json:"emergency,omitempty"`
	TTLMS       int    `json:"ttlMs"`
	ExpiresAtMS int64  `json:"expiresAtMs,omitempty"`
}
type State struct {
	StopConfirmed bool `json:"stopConfirmed"`
	Moving        bool `json:"moving"`
}
type resource struct {
	mu        sync.Mutex
	wire      sync.Mutex
	session   string
	sequence  uint64
	epoch     uint64
	deadline  time.Time
	closed    bool
	moving    bool
	uncertain bool
	driver    Driver
	timer     *time.Timer
	touched   time.Time
	cancel    context.CancelFunc
}
type Controller struct {
	mu        sync.Mutex
	resources map[string]*resource
	closed    bool
}

func New() *Controller { return &Controller{resources: map[string]*resource{}} }
func (c *Controller) get(key string) (*resource, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, ErrStopped
	}
	now := time.Now()
	for k, r := range c.resources {
		r.mu.Lock()
		idle := !r.moving && !r.uncertain && now.Sub(r.touched) > 10*time.Minute
		r.mu.Unlock()
		if idle {
			delete(c.resources, k)
		}
	}
	if r := c.resources[key]; r != nil {
		return r, nil
	}
	if len(c.resources) >= 128 {
		return nil, errors.New("ptz_capacity_exceeded")
	}
	r := &resource{touched: now}
	c.resources[key] = r
	return r, nil
}
func state(r *resource) State { return State{!r.uncertain && !r.moving, r.moving} }
func (c *Controller) Execute(ctx context.Context, key string, d Driver, cmd Command) (State, error) {
	if !cmd.Stop {
		if err := ctx.Err(); err != nil {
			return State{}, err
		}
	}
	remaining := time.Duration(cmd.TTLMS) * time.Millisecond
	if !cmd.Stop {
		absolute := time.Until(time.UnixMilli(cmd.ExpiresAtMS))
		if cmd.ExpiresAtMS <= 0 || absolute <= 0 || absolute > 1500*time.Millisecond {
			return State{}, ErrStale
		}
		if absolute < remaining {
			remaining = absolute
		}
	}
	if key == "" || len(key) > 512 || len(cmd.Session) < 16 || len(cmd.Session) > 128 || cmd.Sequence == 0 || !cmd.Vector.Valid() || len(cmd.Preset) > 256 {
		return State{}, errors.New("ptz_invalid_command")
	}
	if !cmd.Stop && (cmd.TTLMS < 100 || cmd.TTLMS > 1500) {
		return State{}, errors.New("ptz_invalid_ttl")
	}
	if cmd.Preset != "" && !cmd.Vector.Zero() {
		return State{}, errors.New("ptz_invalid_command")
	}
	if cmd.Emergency && !cmd.Stop {
		return State{}, errors.New("ptz_invalid_command")
	}
	r, e := c.get(key)
	if e != nil {
		return State{}, e
	}
	r.mu.Lock()
	now := time.Now()
	if cmd.KeepAlive && (r.session != cmd.Session || !r.moving || r.closed || cmd.Stop || cmd.Preset != "" || !cmd.Vector.Zero()) {
		r.mu.Unlock()
		return State{}, ErrStale
	}
	if !cmd.Stop {
		if r.uncertain {
			r.mu.Unlock()
			return State{}, ErrStopUnconfirmed
		}
		if r.session != cmd.Session {
			if r.moving || now.Before(r.deadline) {
				r.mu.Unlock()
				return State{}, ErrBusy
			}
			r.session = cmd.Session
			r.sequence = 0
			r.closed = false
		}
		if r.closed {
			r.mu.Unlock()
			return State{}, ErrStopped
		}
		if cmd.Sequence <= r.sequence {
			r.mu.Unlock()
			return State{}, ErrStale
		}
	} else {
		// Authenticated emergency Stop is allowed to stop another controller, but a
		// late Stop from an expired session must never stop its replacement.
		if !cmd.Emergency && r.session != "" && r.session != cmd.Session {
			r.mu.Unlock()
			return State{}, ErrStale
		}
		if !cmd.Emergency && cmd.Sequence < r.sequence {
			r.mu.Unlock()
			return State{}, ErrStale
		}
		r.session = cmd.Session
		r.closed = true
	}
	r.sequence = cmd.Sequence
	if !cmd.KeepAlive && r.cancel != nil {
		r.cancel()
	}
	r.epoch++
	epoch := r.epoch
	r.driver = d
	r.touched = now
	if r.timer != nil {
		r.timer.Stop()
	}
	if cmd.Stop {
		r.deadline = now
	} else {
		r.deadline = now.Add(remaining)
		r.moving = true
		// A preset is a bounded operation. UI renews its session while it is active;
		// the service still sends Stop if its short lease is not renewed.
		r.timer = time.AfterFunc(time.Until(r.deadline), func() { c.expire(r, epoch) })
	}
	deadline := r.deadline
	result := state(r)
	r.mu.Unlock()
	if cmd.KeepAlive {
		return result, nil
	}
	// Serialize wire writes, not stale intent. A queued request is checked again
	// after the previous network call and cannot resurrect motion after Stop.
	r.wire.Lock()
	defer r.wire.Unlock()
	r.mu.Lock()
	current := r.epoch == epoch
	fresh := cmd.Stop || time.Now().Before(deadline)
	if !current || !fresh {
		r.mu.Unlock()
		return State{}, ErrStale
	}
	limit := 2 * time.Second
	if !cmd.Stop && time.Until(deadline) < limit {
		limit = time.Until(deadline)
	}
	baseCtx := ctx
	if cmd.Stop {
		baseCtx = context.Background()
	}
	wireCtx, cancel := context.WithTimeout(baseCtx, limit)
	r.cancel = cancel
	r.mu.Unlock()
	defer cancel()
	if err := wireCtx.Err(); err != nil {
		return State{}, err
	}
	if cmd.Stop {
		e = d.Stop(wireCtx)
	} else if cmd.Preset != "" {
		e = d.Preset(wireCtx, cmd.Preset)
	} else {
		e = d.Move(wireCtx, cmd.Vector, time.Until(deadline))
	}
	r.mu.Lock()
	if cmd.Stop {
		r.moving = false
		r.uncertain = e != nil
	} else if e != nil {
		r.uncertain = true
	}
	result = state(r)
	r.mu.Unlock()
	// A failed Move can have reached the device. Its timer still sends Stop.
	return result, e
}
func (c *Controller) expire(r *resource, epoch uint64) {
	r.mu.Lock()
	if r.epoch != epoch {
		r.mu.Unlock()
		return
	}
	r.closed = true
	if r.cancel != nil {
		r.cancel()
	}
	r.epoch++
	stopEpoch := r.epoch
	d := r.driver
	r.mu.Unlock()
	r.wire.Lock()
	defer r.wire.Unlock()
	for attempt := 0; attempt < 3; attempt++ {
		r.mu.Lock()
		current := r.epoch == stopEpoch
		r.mu.Unlock()
		if !current {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		e := d.Stop(ctx)
		cancel()
		r.mu.Lock()
		r.moving = false
		r.uncertain = e != nil
		r.touched = time.Now()
		r.mu.Unlock()
		if e == nil {
			return
		}
		if attempt < 2 {
			time.Sleep(time.Duration(attempt+1) * 200 * time.Millisecond)
		}
	}
}

// Status reports controller delivery state, never physical arrival at a pose.
func (c *Controller) Status(key string) (State, bool) {
	c.mu.Lock()
	r := c.resources[key]
	c.mu.Unlock()
	if r == nil {
		return State{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return state(r), true
}
func (c *Controller) Close() {
	c.mu.Lock()
	c.closed = true
	all := make([]*resource, 0, len(c.resources))
	for _, r := range c.resources {
		all = append(all, r)
	}
	c.mu.Unlock()
	var wg sync.WaitGroup
	for _, r := range all {
		r.mu.Lock()
		epoch := r.epoch
		active := r.moving || r.uncertain
		if r.timer != nil {
			r.timer.Stop()
		}
		r.mu.Unlock()
		if active {
			wg.Add(1)
			go func() { defer wg.Done(); c.expire(r, epoch) }()
		}
	}
	wg.Wait()
}
