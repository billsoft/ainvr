package onvif

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

// RFC 7616 3.3: stale=true means the credentials were right but the nonce
// expired between challenge and response. Cameras with short nonce lifetimes
// answer this way; treating it as a wrong password stops a working camera
// until someone intervenes. Retry once with the fresh nonce, still bounded.
func TestDigestStaleNonceRetriesOnceWithFreshNonce(t *testing.T) {
	c := fixtureClient(t, false)
	calls := 0
	c.http = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		switch calls {
		case 1:
			return &http.Response{StatusCode: 401, Header: http.Header{"Www-Authenticate": []string{`Digest realm="camera", nonce="first", algorithm=MD5, qop="auth"`}}, Body: io.NopCloser(strings.NewReader(""))}, nil
		case 2:
			if !strings.Contains(r.Header.Get("Authorization"), `nonce="first"`) {
				t.Error("second request must answer the first challenge")
			}
			return &http.Response{StatusCode: 401, Header: http.Header{"Www-Authenticate": []string{`Digest realm="camera", nonce="second", algorithm=MD5, qop="auth", stale=TRUE`}}, Body: io.NopCloser(strings.NewReader(""))}, nil
		default:
			if !strings.Contains(r.Header.Get("Authorization"), `nonce="second"`) {
				t.Error("retry must use the fresh nonce")
			}
			return response(envelope(deviceNS, "GetDeviceInformation", `<m:Model>test</m:Model>`)), nil
		}
	})}
	_, e := c.soap(context.Background(), c.device.URL, deviceNS, "GetDeviceInformation", "", false)
	if e != nil || calls != 3 {
		t.Fatal(e, calls)
	}
}

// A non-stale rejection after the Digest answer is still a wrong password, and
// a stale answer is retried only once: no login loop against a camera.
func TestDigestRejectionAndRepeatedStaleStayBounded(t *testing.T) {
	for _, stale := range []bool{false, true} {
		c := fixtureClient(t, false)
		calls := 0
		c.http = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			calls++
			challenge := `Digest realm="camera", nonce="n", algorithm=MD5, qop="auth"`
			if calls > 1 && stale {
				challenge += `, stale=true`
			}
			return &http.Response{StatusCode: 401, Header: http.Header{"Www-Authenticate": []string{challenge}}, Body: io.NopCloser(strings.NewReader(""))}, nil
		})}
		_, e := c.soap(context.Background(), c.device.URL, deviceNS, "GetDeviceInformation", "", false)
		want := 2
		if stale {
			want = 3
		}
		if Code(e) != "authentication_failed" || calls != want {
			t.Fatal(stale, e, calls)
		}
	}
}
