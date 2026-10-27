package onvif

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestPTZDurationForms(t *testing.T) {
	for s, want := range map[string]time.Duration{"PT1M": time.Minute, "PT10M": 10 * time.Minute, "PT1H": time.Hour, "PT0S": 0, "P0DT0H0M1S": time.Second, "P1DT2H3M4.5S": 26*time.Hour + 3*time.Minute + 4500*time.Millisecond, "PT0.1S": 100 * time.Millisecond} {
		got, ok := ptzDuration(s)
		if !ok || got != want {
			t.Errorf("%s: got %v valid=%v want %v", s, got, ok, want)
		}
	}
	for _, s := range []string{"", "P", "PT", "P1DT", "PT-1S", "P1M", "P1Y", "PTNaNS", "PT1M1H", "PT999999999999999999999999999999999999S"} {
		if _, ok := ptzDuration(s); ok {
			t.Errorf("accepted invalid timeout %q", s)
		}
	}
}

func TestPTZTimeoutCapabilityNegotiation(t *testing.T) {
	for _, tc := range []struct {
		min, max string
		want     bool
	}{
		{"PT0S", "PT1M", true}, {"PT0S", "PT10M", true}, {"PT0S", "PT1H", true}, {"P0DT0H0M1S", "PT10S", true},
		{"", "", false}, {"PT0S", "PT0S", false}, {"PT1S", "PT0.5S", false}, {"PT2S", "PT10S", false},
	} {
		c, _ := ptzFixture(t, false, true, true, true)
		original := c.http.Transport
		c.http.Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
			res, err := original.RoundTrip(r)
			if err != nil {
				return res, err
			}
			raw, _ := io.ReadAll(res.Body)
			res.Body.Close()
			body := strings.ReplaceAll(string(raw), "PT0.1S", tc.min)
			body = strings.ReplaceAll(body, "PT10S", tc.max)
			res.Body = io.NopCloser(strings.NewReader(body))
			return res, nil
		})
		target, err := c.PreparePTZ(context.Background(), "media1", "main", "source-a")
		if err != nil {
			t.Fatal(err)
		}
		if target.caps.ContinuousPanTilt != tc.want || target.caps.ContinuousZoom != tc.want {
			t.Errorf("timeout %s..%s: %+v", tc.min, tc.max, target.caps)
		}
	}
}
