package gateway

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

func budgetMessage(total int, items ...CatalogItem) BusinessMessage {
	m := BusinessMessage{Command: "Catalog", SN: "1", SumNum: total}
	m.List.Items = items
	return m
}

func TestCatalogBudgetRejectsAtomicallyAndDoesNotChargeDuplicates(t *testing.T) {
	now := time.Now()
	c := NewCatalog("1", now.Add(time.Minute), 100)
	a := CatalogItem{ID: "34020000001320000001", Name: "first", Status: "ON"}
	b := CatalogItem{ID: "34020000001320000002", Name: "second", Status: "ON"}
	limit := catalogItemBytes(a)
	if done, err := c.addWithinBudget(budgetMessage(2, a), now, limit); done || err != nil {
		t.Fatalf("first batch: %v %v", done, err)
	}
	if _, err := c.addWithinBudget(budgetMessage(2, a, a), now, limit); err != nil {
		t.Fatalf("duplicate used extra budget: %v", err)
	}
	if _, err := c.addWithinBudget(budgetMessage(2, b), now, limit); !errors.Is(err, errCatalogCapacity) {
		t.Fatalf("over-budget batch accepted: %v", err)
	}
	if got := c.Snapshot(); len(got) != 1 || got[0] != a {
		t.Fatalf("rejected batch mutated directory: %+v", got)
	}
	if bytes, done := c.memory(); bytes != limit || done {
		t.Fatalf("wrong accounting: %d %v", bytes, done)
	}
	if done, err := c.addWithinBudget(budgetMessage(2, b), now, limit+catalogItemBytes(b)); !done || err != nil {
		t.Fatalf("exact budget should succeed: %v %v", done, err)
	}
}

func TestCatalogConflictCannotPartiallyCommitBatch(t *testing.T) {
	now := time.Now()
	c := NewCatalog("1", now.Add(time.Minute), 100)
	a := CatalogItem{ID: "34020000001320000001", Name: "first"}
	b := CatalogItem{ID: "34020000001320000002", Name: "second"}
	if _, err := c.Add(budgetMessage(3, a), now); err != nil {
		t.Fatal(err)
	}
	bad := a
	bad.Name = "changed"
	if _, err := c.Add(budgetMessage(3, b, bad), now); err == nil {
		t.Fatal("conflicting batch accepted")
	}
	if got := c.Snapshot(); len(got) != 1 || got[0] != a {
		t.Fatalf("partial commit: %+v", got)
	}
}

func TestGlobalCatalogBudgetProtectsOtherDevicesAndAllowsReplacement(t *testing.T) {
	now := time.Now()
	a := CatalogItem{ID: "34020000001320000001", Name: "camera", Status: "ON"}
	bytes := catalogItemBytes(a)
	peer := &DeviceState{ID: "other", catalogBytes: catalogCacheBudget - 2*bytes + 1}
	current := &DeviceState{ID: "current", query: NewCatalog("1", now.Add(time.Minute), 100)}
	s := &Server{states: map[string]*DeviceState{peer.ID: peer, current.ID: current}}
	if _, err := s.applyCatalog(current, budgetMessage(1, a), now); !errors.Is(err, errCatalogCapacity) {
		t.Fatalf("combined device capacity bypassed: %v", err)
	}
	if len(current.Catalog) != 0 || current.CatalogComplete || len(current.query.Snapshot()) != 0 {
		t.Fatal("rejected admission changed state")
	}
	if peer.catalogBytes != catalogCacheBudget-2*bytes+1 {
		t.Fatal("another device was evicted")
	}
	peer.catalogBytes--
	if done, err := s.applyCatalog(current, budgetMessage(1, a), now); !done || err != nil {
		t.Fatalf("available exact capacity rejected: %v %v", done, err)
	}
	if current.catalogBytes != 2*bytes || !current.CatalogComplete {
		t.Fatal("completed cache accounting incorrect")
	}
	// The cache is exactly full, but replacing our own same-size directory
	// uses the separate work reserve and must still work.
	current.query = NewCatalog("1", now.Add(time.Minute), 100)
	current.CatalogComplete = false
	current.LastError = "catalog_capacity_exceeded"
	if done, err := s.applyCatalog(current, budgetMessage(1, a), now); !done || err != nil || current.LastError != "" {
		t.Fatalf("same-size refresh blocked: %v %v %s", done, err, current.LastError)
	}
}

func TestCatalogRefreshReserveIsGlobal(t *testing.T) {
	now := time.Now()
	a := CatalogItem{ID: "34020000001320000001", Name: "camera"}
	bytes := catalogItemBytes(a)
	busy := NewCatalog("1", now.Add(time.Minute), 100)
	busy.total = 2
	busy.bytes = catalogRefreshBudget - bytes + 1
	peer := &DeviceState{ID: "other", query: busy}
	current := &DeviceState{ID: "current", query: NewCatalog("1", now.Add(time.Minute), 100)}
	s := &Server{states: map[string]*DeviceState{peer.ID: peer, current.ID: current}}
	if _, err := s.applyCatalog(current, budgetMessage(1, a), now); !errors.Is(err, errCatalogCapacity) {
		t.Fatalf("global refresh reserve bypassed: %v", err)
	}
	busy.bytes--
	if done, err := s.applyCatalog(current, budgetMessage(1, a), now); !done || err != nil {
		t.Fatalf("exact refresh reserve should succeed: %v %v", done, err)
	}
}

func TestTenThousandOneItemCatalogBatches(t *testing.T) {
	now := time.Now()
	current := &DeviceState{ID: sampleID, query: NewCatalog("1", now.Add(time.Minute), 10000)}
	s := &Server{states: map[string]*DeviceState{sampleID: current}}
	start := time.Now()
	for index := 0; index < 10000; index++ {
		item := CatalogItem{ID: fmt.Sprintf("3402000000132%07d", index), Name: fmt.Sprintf("Camera %d", index), Manufacturer: "Fixture", Model: "NVR", Status: "ON"}
		done, err := s.applyCatalog(current, budgetMessage(10000, item), now)
		if err != nil || done != (index == 9999) {
			t.Fatalf("batch %d: %v %v", index, done, err)
		}
	}
	if len(current.Catalog) != 10000 || current.catalogBytes > catalogCacheBudget {
		t.Fatal("normal 10,000-entry NVR directory did not fit the bounded cache")
	}
	t.Logf("10,000 single-item batches completed in %s; retained charge %d bytes", time.Since(start), current.catalogBytes)
}
