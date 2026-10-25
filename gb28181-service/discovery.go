package gateway

import (
	"context"
	"sort"
	"sync"
	"time"
)

// Bound both active work and queued work. A slow peer cannot serialize all peers.
func runDiscovery(ctx context.Context, snapshot func() []DeviceState, refresh func(context.Context, string, string) error, interval, cooldown time.Duration, limit int) {
	if limit < 1 {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	var workers sync.WaitGroup
	defer workers.Wait()
	done := make(chan string, limit)
	active := map[string]bool{}
	attempted := map[string]time.Time{}
	dispatch := func() {
		if ctx.Err() != nil {
			return
		}
		devices := snapshot()
		present := map[string]bool{}
		for _, d := range devices {
			present[d.ID] = true
		}
		for id := range attempted {
			if !present[id] && !active[id] {
				delete(attempted, id)
			}
		}
		sort.Slice(devices, func(i, j int) bool {
			a, b := attempted[devices[i].ID], attempted[devices[j].ID]
			if a.Equal(b) {
				return devices[i].ID < devices[j].ID
			}
			return a.Before(b)
		})
		for _, device := range devices {
			if len(active) >= limit {
				break
			}
			if !device.Registered || active[device.ID] || time.Since(attempted[device.ID]) < cooldown {
				continue
			}
			active[device.ID] = true
			attempted[device.ID] = time.Now()
			workers.Add(1)
			go func(d DeviceState) {
				defer workers.Done()
				defer func() { done <- d.ID }()
				commands := []string{}
				if !d.CatalogComplete {
					commands = append(commands, "Catalog")
				}
				if d.Info == nil {
					commands = append(commands, "DeviceInfo")
				}
				commands = append(commands, "DeviceStatus")
				for _, command := range commands {
					if ctx.Err() != nil {
						return
					}
					// A failed peer gets one transaction per cycle rather than three timeouts.
					if refresh(ctx, d.ID, command) != nil {
						return
					}
				}
			}(device)
		}
	}
	dispatch()
	for {
		select {
		case <-ctx.Done():
			return
		case id := <-done:
			delete(active, id)
			dispatch()
		case <-ticker.C:
			dispatch()
		}
	}
}
