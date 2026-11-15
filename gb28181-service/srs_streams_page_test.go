package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

// The media server lists only the first 10 streams unless a count is given.
// On a busy box the GB stream sits beyond that page; publish confirmation must
// still find it, or every GB input loops through srs_publish_timeout.
func TestPublishedFindsStreamBeyondDefaultPage(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		limit := 10
		if c, e := strconv.Atoi(r.URL.Query().Get("count")); e == nil {
			limit = c
		}
		type stream struct {
			App     string          `json:"app"`
			Name    string          `json:"name"`
			Publish map[string]bool `json:"publish"`
			Video   map[string]any  `json:"video"`
		}
		all := []stream{}
		for i := 0; i < 18; i++ {
			all = append(all, stream{App: "live", Name: fmt.Sprintf("other%d", i), Publish: map[string]bool{"active": true}, Video: map[string]any{"codec": "H264"}})
		}
		all = append(all, stream{App: "live", Name: "gb_target", Publish: map[string]bool{"active": true}, Video: map[string]any{"codec": "H264"}})
		if limit < len(all) {
			all = all[:limit]
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "streams": all})
	}))
	defer api.Close()
	r := &Runtime{config: RuntimeConfig{SRSAPI: api.URL}}
	if !r.published(context.Background(), Binding{App: "live", Stream: "gb_target"}) {
		t.Fatal("stream listed after the first 10 must count as published")
	}
}
