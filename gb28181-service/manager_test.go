package gateway

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestManagerRevisionAndAuthentication(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := &Manager{}
	defer m.Close()
	token := strings.Repeat("x", 32)
	handler := m.Handler(ctx, token)
	request := func(body, key string) int {
		r := httptest.NewRequest(http.MethodPost, "/v1/config", strings.NewReader(body))
		r.Header.Set("X-Service-Token", key)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w.Code
	}
	if got := request(`{"revision":1,"enabled":false}`, "wrong"); got != 401 {
		t.Fatalf("unauthenticated %d", got)
	}
	if got := request(`{"revision":1,"enabled":false} {}`, token); got != 400 {
		t.Fatalf("trailing JSON %d", got)
	}
	if got := request(`{"revision":0,"enabled":false}`, token); got != 409 {
		t.Fatalf("invalid revision %d", got)
	}
	if got := request(`{"revision":2,"enabled":false}`, token); got != 202 {
		t.Fatalf("apply %d", got)
	}
	if got := request(`{"revision":2,"enabled":false}`, token); got != 202 {
		t.Fatalf("idempotent %d", got)
	}
	if got := request(`{"revision":1,"enabled":false}`, token); got != 409 {
		t.Fatalf("stale %d", got)
	}
	if got := request(`{"revision":2,"enabled":false,"srsApi":"http://127.0.0.1:1985"}`, token); got != 409 {
		t.Fatalf("content conflict %d", got)
	}
	if got := request(`{"revision":3,"enabled":false}`, token); got != 202 {
		t.Fatalf("replace %d", got)
	}
	if m.Status()["revision"] != int64(3) {
		t.Fatal("wrong current revision")
	}
}
