package gateway

import (
	"context"
	"github.com/emiago/sipgo/sip"
	"sync"
	"testing"
	"time"
)

func TestRegistrationExpirationPriority(t *testing.T) {
	for _, tc := range []struct {
		contact, expires string
		want             int
		bad              bool
	}{
		{"", "", 3600, false}, {"", "600", 600, false}, {"expires=120", "3600", 120, false},
		{"expires=0", "3600", 0, false}, {"expires=600", "0", 600, false},
		{"expires=bad", "600", 0, true}, {"expires=", "600", 0, true}, {"expires=-1", "600", 0, true},
	} {
		t.Run(tc.contact+"/"+tc.expires, func(t *testing.T) {
			req := sip.NewRequest(sip.REGISTER, sip.Uri{Host: "localhost"})
			contact := &sip.ContactHeader{Address: sip.Uri{Host: "localhost"}, Params: sip.NewParams()}
			if tc.contact != "" {
				contact.Params.Add("expires", tc.contact[len("expires="):])
			}
			req.AppendHeader(contact)
			if tc.expires != "" {
				req.AppendHeader(sip.NewHeader("Expires", tc.expires))
			}
			got, err := registrationExpires(req)
			if (err != nil) != tc.bad || !tc.bad && got != tc.want {
				t.Fatalf("got %d %v", got, err)
			}
		})
	}
}
func TestDiscoverySlowPeerDoesNotBlockAndCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	fast := make(chan struct{}, 1)
	var mu sync.Mutex
	var running, maxRunning int
	refresh := func(ctx context.Context, id, command string) error {
		mu.Lock()
		running++
		if running > maxRunning {
			maxRunning = running
		}
		mu.Unlock()
		defer func() { mu.Lock(); running--; mu.Unlock() }()
		if id == "a" {
			<-ctx.Done()
			return ctx.Err()
		}
		select {
		case fast <- struct{}{}:
		default:
		}
		return nil
	}
	go func() {
		defer close(done)
		runDiscovery(ctx, func() []DeviceState {
			return []DeviceState{{ID: "a", Registered: true}, {ID: "b", Registered: true}, {ID: "c", Registered: true}}
		}, refresh, time.Millisecond, time.Hour, 2)
	}()
	select {
	case <-fast:
	case <-time.After(time.Second):
		t.Fatal("slow peer blocked discovery")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("workers did not stop")
	}
	mu.Lock()
	defer mu.Unlock()
	if maxRunning > 2 || running != 0 {
		t.Fatalf("concurrency %d active %d", maxRunning, running)
	}
}
func TestVersionDeclarationIsIndependentOfProfile(t *testing.T) {
	v, err := SelectVersion("2016", "3.0")
	if err != nil || v.Profile != "2016" || v.Peer != "2022" {
		t.Fatalf("%+v %v", v, err)
	}
	v, err = SelectVersion("auto", "")
	if err != nil || v.Profile != "2016" || v.Peer != "" || v.Confirmed {
		t.Fatalf("%+v %v", v, err)
	}
}
