package gateway

import (
	"errors"
	"sort"
	"sync"
	"time"
)

// Product memory budgets, not limits imposed by the GB XML schema. Keep
// completed directories and refresh work separately bounded so refreshing an
// existing directory can replace it without evicting another device's data.
const catalogCacheBudget = 32 << 20
const catalogRefreshBudget = 32 << 20

var errCatalogCapacity = errors.New("catalog memory capacity exhausted")

func catalogItemBytes(item CatalogItem) int {
	// Include conservative map/struct overhead as well as decoded strings.
	return 256 + len(item.ID) + len(item.Name) + len(item.Manufacturer) + len(item.Model) + len(item.ParentID) + len(item.Status)
}

func catalogSliceBytes(items []CatalogItem) int {
	total := 0
	for _, item := range items {
		total += catalogItemBytes(item)
	}
	return total
}

// A query generation prevents delayed responses to an older refresh from
// overwriting the current directory. Partial refreshes never imply deletion.
type Catalog struct {
	mu       sync.Mutex
	SN       string
	Deadline time.Time
	total    int
	max      int
	items    map[string]CatalogItem
	bytes    int
}

func NewCatalog(sn string, deadline time.Time, max int) *Catalog {
	return &Catalog{SN: sn, Deadline: deadline, total: -1, max: max, items: map[string]CatalogItem{}}
}
func (c *Catalog) Add(m BusinessMessage, now time.Time) (bool, error) {
	return c.addWithinBudget(m, now, -1)
}

func (c *Catalog) memory() (int, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.bytes, c.total >= 0 && len(c.items) == c.total
}

func (c *Catalog) addWithinBudget(m BusinessMessage, now time.Time, budget int) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !now.Before(c.Deadline) || m.SN != c.SN || m.Command != "Catalog" {
		return false, errors.New("stale catalog response")
	}
	if m.SumNum < 0 || m.SumNum > c.max || (c.total >= 0 && c.total != m.SumNum) {
		return false, errors.New("inconsistent catalog total")
	}
	// Validate a bounded incoming batch before committing. Do not copy the
	// entire growing directory for every one-item response.
	added := make(map[string]CatalogItem, len(m.List.Items))
	bytes := c.bytes
	for _, item := range m.List.Items {
		if old, ok := c.items[item.ID]; ok {
			if old != item {
				return false, errors.New("conflicting duplicate catalog item")
			}
			continue
		}
		if old, ok := added[item.ID]; ok {
			if old != item {
				return false, errors.New("conflicting duplicate catalog item")
			}
			continue
		}
		added[item.ID] = item
		bytes += catalogItemBytes(item)
	}
	if len(c.items)+len(added) > m.SumNum {
		return false, errors.New("catalog exceeds declared total")
	}
	if budget >= 0 && bytes > budget {
		return false, errCatalogCapacity
	}
	c.total = m.SumNum
	for id, item := range added {
		c.items[id] = item
	}
	c.bytes = bytes
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
