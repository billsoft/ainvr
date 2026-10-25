package gateway

import (
	"errors"
	"sort"
	"sync"
	"time"
)

// A query generation prevents delayed responses to an older refresh from
// overwriting the current directory. Partial refreshes never imply deletion.
type Catalog struct {
	mu       sync.Mutex
	SN       string
	Deadline time.Time
	total    int
	max      int
	items    map[string]CatalogItem
}

func NewCatalog(sn string, deadline time.Time, max int) *Catalog {
	return &Catalog{SN: sn, Deadline: deadline, total: -1, max: max, items: map[string]CatalogItem{}}
}
func (c *Catalog) Add(m BusinessMessage, now time.Time) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !now.Before(c.Deadline) || m.SN != c.SN || m.Command != "Catalog" {
		return false, errors.New("stale catalog response")
	}
	if m.SumNum < 0 || m.SumNum > c.max || (c.total >= 0 && c.total != m.SumNum) {
		return false, errors.New("inconsistent catalog total")
	}
	merged := make(map[string]CatalogItem, len(c.items)+len(m.List.Items))
	for id, item := range c.items {
		merged[id] = item
	}
	for _, item := range m.List.Items {
		if old, ok := merged[item.ID]; ok && old != item {
			return false, errors.New("conflicting duplicate catalog item")
		}
		merged[item.ID] = item
	}
	if len(merged) > m.SumNum {
		return false, errors.New("catalog exceeds declared total")
	}
	c.total = m.SumNum
	c.items = merged
	return len(c.items) == c.total, nil
}
func (c *Catalog) Snapshot() []CatalogItem {
	c.mu.Lock()
	defer c.mu.Unlock()
	items := make([]CatalogItem, 0, len(c.items))
	for _, item := range c.items {
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items
}

// Keep structural nodes while assembling SumNum, but never offer them as input
// video channels. Backend channel identities remain exactly 20 digits.
func selectableCatalog(items []CatalogItem) []CatalogItem {
	out := make([]CatalogItem, 0, len(items))
	for _, item := range items {
		if !deviceIDPattern.MatchString(item.ID) {
			continue
		}
		kind := item.ID[10:13]
		if kind == "200" || kind == "215" || kind == "216" {
			continue
		}
		out = append(out, item)
	}
	return out
}
