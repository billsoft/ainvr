package gateway

import (
	"testing"
	"time"
)

func TestDirectoryRecoveryPreservesIndependentDeviceFault(t *testing.T) {
	now := time.Now()
	st := &DeviceState{ID: sampleID, LastError: "catalog_capacity_exceeded", DeviceHealth: "ERROR", query: NewCatalog("1", now.Add(time.Minute), 100)}
	st.reconcileDeviceFault()
	if st.LastError != "catalog_capacity_exceeded" {
		t.Fatal("self-check masked a separate capacity error")
	}
	s := &Server{states: map[string]*DeviceState{sampleID: st}}
	item := CatalogItem{ID: "34020000001320000002", Name: "camera", Status: "ON"}
	if done, err := s.applyCatalog(st, budgetMessage(1, item), now); !done || err != nil {
		t.Fatalf("catalog recovery failed: %v %v", done, err)
	}
	if st.LastError != "device_reported_error" || st.DeviceHealth != "ERROR" {
		t.Fatal("catalog recovery cleared an independent self-check fault")
	}
}
