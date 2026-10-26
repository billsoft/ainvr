package onvif

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func response(body string) *http.Response {
	return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}
}
func envelope(ns, action, content string) string {
	return `<s:Envelope xmlns:s="` + soapNS + `"><s:Body><m:` + action + `Response xmlns:m="` + ns + `" xmlns:tt="` + schemaNS + `">` + content + `</m:` + action + `Response></s:Body></s:Envelope>`
}
func fixtureClient(t *testing.T, media2 bool) *Client {
	t.Helper()
	c, e := NewClient(Device{URL: "http://192.0.2.10/device", Username: "admin", Password: "private"}, Policy{AllowedCIDRs: []string{"192.0.2.0/24"}, TimeoutSeconds: 2})
	if e != nil {
		t.Fatal(e)
	}
	c.now = func() time.Time { return time.Date(2026, 10, 26, 8, 0, 0, 0, time.UTC) }
	c.http = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		body, _ := io.ReadAll(r.Body)
		wire := string(body)
		ns := media1NS
		if media2 {
			ns = media2NS
		}
		switch {
		case strings.Contains(wire, "<m:GetSystemDateAndTime"):
			return response(envelope(deviceNS, "GetSystemDateAndTime", `<m:SystemDateAndTime><tt:UTCDateTime><tt:Time><tt:Hour>8</tt:Hour><tt:Minute>0</tt:Minute><tt:Second>30</tt:Second></tt:Time><tt:Date><tt:Year>2026</tt:Year><tt:Month>10</tt:Month><tt:Day>26</tt:Day></tt:Date></tt:UTCDateTime></m:SystemDateAndTime>`)), nil
		case strings.Contains(wire, "<m:GetServices"):
			return response(envelope(deviceNS, "GetServices", `<m:Service><m:Namespace>`+ns+`</m:Namespace><m:XAddr>http://192.0.2.10/media</m:XAddr></m:Service>`)), nil
		case strings.Contains(wire, "<m:GetDeviceInformation"):
			if !strings.Contains(wire, "2026-10-26T08:00:30Z") {
				t.Error("device clock offset was not used")
			}
			return response(envelope(deviceNS, "GetDeviceInformation", `<m:Manufacturer>Fixture</m:Manufacturer><m:Model>two-source NVR</m:Model><m:SerialNumber>serial</m:SerialNumber>`)), nil
		case strings.Contains(wire, "<m:GetProfiles"):
			configs := `<tt:VideoSourceConfiguration><tt:SourceToken>source-a</tt:SourceToken></tt:VideoSourceConfiguration><tt:VideoEncoderConfiguration><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>1920</tt:Width><tt:Height>1080</tt:Height></tt:Resolution><tt:RateControl><tt:FrameRateLimit>10</tt:FrameRateLimit></tt:RateControl></tt:VideoEncoderConfiguration><tt:AudioEncoderConfiguration><tt:Encoding>G711</tt:Encoding></tt:AudioEncoderConfiguration>`
			if media2 {
				configs = `<m:Configurations><tt:VideoSource><tt:SourceToken>source-a</tt:SourceToken></tt:VideoSource><tt:VideoEncoder><tt:Encoding>H265</tt:Encoding><tt:Resolution><tt:Width>1280</tt:Width><tt:Height>720</tt:Height></tt:Resolution><tt:RateControl><tt:FrameRateLimit>5</tt:FrameRateLimit></tt:RateControl></tt:VideoEncoder><tt:AudioEncoder><tt:Encoding>AAC</tt:Encoding></tt:AudioEncoder></m:Configurations>`
			}
			return response(envelope(ns, "GetProfiles", `<m:Profiles token="main"><m:Name>Main</m:Name>`+configs+`</m:Profiles>`)), nil
		case strings.Contains(wire, "<m:GetStreamUri"):
			if media2 && strings.Contains(wire, "StreamSetup") {
				t.Error("Media1 request sent to Media2")
			}
			if !media2 && !strings.Contains(wire, "StreamSetup") {
				t.Error("missing Media1 stream setup")
			}
			content := `<m:Uri>rtsp://192.0.2.10:554/live</m:Uri>`
			if !media2 {
				content = `<m:MediaUri><tt:Uri>rtsp://192.0.2.10:554/live</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>true</tt:InvalidAfterReboot><tt:Timeout>PT60S</tt:Timeout></m:MediaUri>`
			}
			return response(envelope(ns, "GetStreamUri", content)), nil
		}
		return nil, fmt.Errorf("unexpected action")
	})}
	return c
}
func TestMedia1AndMedia2HaveDistinctRequestsAndStableSource(t *testing.T) {
	for _, v := range []bool{false, true} {
		t.Run(fmt.Sprint(v), func(t *testing.T) {
			c := fixtureClient(t, v)
			caps, e := c.Probe(context.Background())
			if e != nil {
				t.Fatal(e)
			}
			if caps.Model != "two-source NVR" || len(caps.Profiles) != 1 || caps.Profiles[0].VideoSource != "source-a" || caps.ClockOffsetSeconds != 30 {
				t.Fatalf("wrong capabilities %+v", caps)
			}
			p := caps.Profiles[0]
			r, e := c.Resolve(context.Background(), p.Service, p.Token, p.VideoSource)
			if e != nil || r.URI != "rtsp://192.0.2.10:554/live" {
				t.Fatalf("resolve %+v %v", r, e)
			}
			if !v && (r.TimeoutSeconds != 60 || !r.InvalidAfterReboot) {
				t.Fatal("MediaUri lifetime lost")
			}
			_, e = c.Resolve(context.Background(), p.Service, p.Token, "source-b")
			if Code(e) != "profile_not_found" {
				t.Fatal("physical source silently changed")
			}
		})
	}
}
func TestXMLBoundsAndExternalEntityRejection(t *testing.T) {
	for _, s := range []string{`<!DOCTYPE x [<!ENTITY y SYSTEM "file:///etc/passwd">]><x>&y;</x>`, strings.Repeat("<x>", 33) + strings.Repeat("</x>", 33), "<x>" + strings.Repeat("a", 65537) + "</x>", "<x/><y/>"} {
		if _, e := parseXML([]byte(s)); e == nil {
			t.Fatal("unsafe XML accepted")
		}
	}
}
func TestAddressPolicy(t *testing.T) {
	p := Policy{AllowedCIDRs: []string{"192.0.2.0/24", "127.0.0.0/8", "169.254.0.0/16"}, TimeoutSeconds: 2}
	for _, raw := range []string{"rtsp://127.0.0.1/a", "rtsp://169.254.169.254/a", "rtsp://198.51.100.2/a"} {
		u, e := p.checkURL(raw, "rtsp")
		if e != nil {
			continue
		}
		if _, e = p.resolve(context.Background(), u.Hostname()); e == nil {
			t.Fatal("unsafe address accepted")
		}
	}
	for _, raw := range []string{"file:///etc/passwd", "http://u:p@192.0.2.2/", "http://192.0.2.2/#x"} {
		if _, e := p.checkURL(raw, "soap"); e == nil {
			t.Fatal("unsafe URL accepted")
		}
	}
}
func TestReturnedServiceCannotReceiveCredentialsOnAnotherHost(t *testing.T) {
	c := fixtureClient(t, false)
	c.http = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		t.Fatal("unsafe endpoint reached transport")
		return nil, nil
	})}
	_, e := c.soap(context.Background(), "http://192.0.2.11/media", media1NS, "GetProfiles", "", false)
	if Code(e) != "service_host_changed" {
		t.Fatal(e)
	}
}
func TestHTTPDigestHasOneBoundedRetry(t *testing.T) {
	c := fixtureClient(t, false)
	calls := 0
	c.http = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return &http.Response{StatusCode: 401, Header: http.Header{"Www-Authenticate": []string{`Digest realm="camera", nonce="12345", algorithm=MD5, qop="auth"`}}, Body: io.NopCloser(strings.NewReader(""))}, nil
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Digest ") {
			t.Error("missing HTTP Digest")
		}
		body, _ := io.ReadAll(r.Body)
		if strings.Contains(string(body), "UsernameToken") {
			t.Error("simultaneous HTTP and WS-Security credentials")
		}
		return response(envelope(deviceNS, "GetDeviceInformation", `<m:Model>test</m:Model>`)), nil
	})}
	_, e := c.soap(context.Background(), c.device.URL, deviceNS, "GetDeviceInformation", "", false)
	if e != nil || calls != 2 {
		t.Fatal(e, calls)
	}
}
func TestServerAuthenticationConfigurationFencingAndDisabledState(t *testing.T) {
	s, _ := NewServer(strings.Repeat("k", 32))
	send := func(method, path, body, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("X-Service-Token", token)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	token := strings.Repeat("k", 32)
	if send("GET", "/health", "", "bad").Code != 401 {
		t.Fatal("missing management auth")
	}
	if send("POST", "/v1/probe", "{}", token).Code != 503 {
		t.Fatal("must start disabled")
	}
	v := Settings{Revision: 1, Policy: Policy{TimeoutSeconds: 3, AllowedCIDRs: []string{"192.0.2.0/24"}}}
	b, _ := json.Marshal(v)
	if send("PUT", "/v1/config", string(b), token).Code != 200 {
		t.Fatal("config rejected")
	}
	v.Enabled = true
	b, _ = json.Marshal(v)
	if send("PUT", "/v1/config", string(b), token).Code != 409 {
		t.Fatal("same revision overwritten")
	}
}
func TestDiscoveryRequiresCorrelatedResponseAndAllowedAddress(t *testing.T) {
	wire := `<s:Envelope xmlns:s="` + soapNS + `" xmlns:a="` + addressingNS + `" xmlns:d="` + discoveryNS + `"><s:Header><a:RelatesTo>request</a:RelatesTo><a:Action>` + discoveryNS + `/ProbeMatches</a:Action></s:Header><s:Body><d:ProbeMatches><d:ProbeMatch><a:EndpointReference><a:Address>urn:device</a:Address></a:EndpointReference><d:XAddrs>http://192.0.2.2/device</d:XAddrs></d:ProbeMatch></d:ProbeMatches></s:Body></s:Envelope>`
	p := Policy{AllowedCIDRs: []string{"192.0.2.0/24"}, TimeoutSeconds: 2}
	if len(discoveryCandidates([]byte(wire), "request", p)) != 1 {
		t.Fatal("valid discovery ignored")
	}
	if len(discoveryCandidates([]byte(wire), "old", p)) != 0 || len(discoveryCandidates([]byte(strings.ReplaceAll(wire, "192.0.2.2", "127.0.0.1")), "request", p)) != 0 {
		t.Fatal("uncorrelated or unsafe candidate accepted")
	}
}

func TestTransportFailuresAreActionableAndSanitized(t *testing.T) {
	for _, code := range []string{"certificate_untrusted", "redirect_not_allowed"} {
		c := fixtureClient(t, false)
		c.http = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) { return nil, failure(code) })}
		_, err := c.soap(context.Background(), c.device.URL, deviceNS, "GetDeviceInformation", "", false)
		if Code(err) != code {
			t.Fatalf("expected %s, got %v", code, err)
		}
	}
}

func TestFaultQNameCannotBeSpoofedByReasonText(t *testing.T) {
	for _, tc := range []struct{ namespace, local, expected string }{
		{"http://www.onvif.org/ver10/error", "NotAuthorized", "authentication_failed"},
		{"http://www.onvif.org/ver10/error", "ActionNotSupported", "operation_unsupported"},
		{"urn:untrusted", "NotAuthorized", "device_fault"},
	} {
		wire := `<s:Fault xmlns:s="` + soapNS + `" xmlns:x="` + tc.namespace + `"><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>x:` + tc.local + `</s:Value></s:Subcode></s:Code><s:Reason><s:Text>NotAuthorized ActionNotSupported</s:Text></s:Reason></s:Fault>`
		node, err := parseXML([]byte(wire))
		if err != nil {
			t.Fatal(err)
		}
		if got := faultCode(node); got != tc.expected {
			t.Fatalf("got %s, want %s", got, tc.expected)
		}
	}
}

func TestProtectedClockAuthenticatesOnceAndStopsOnFailure(t *testing.T) {
	for _, valid := range []bool{true, false} {
		c := fixtureClient(t, false)
		calls := 0
		c.http = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			calls++
			wire, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(wire), "GetSystemDateAndTime") {
				t.Fatal("attempted later login after time authentication failed")
			}
			if calls == 1 || !valid {
				return &http.Response{StatusCode: 401, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(""))}, nil
			}
			if !strings.Contains(string(wire), "UsernameToken") {
				t.Fatal("missing protected clock credentials")
			}
			return response(envelope(deviceNS, "GetSystemDateAndTime", `<m:SystemDateAndTime><tt:UTCDateTime><tt:Time><tt:Hour>8</tt:Hour><tt:Minute>0</tt:Minute><tt:Second>30</tt:Second></tt:Time><tt:Date><tt:Year>2026</tt:Year><tt:Month>10</tt:Month><tt:Day>26</tt:Day></tt:Date></tt:UTCDateTime></m:SystemDateAndTime>`)), nil
		})}
		err := c.clock(context.Background())
		if calls != 2 {
			t.Fatalf("unbounded clock auth: %d", calls)
		}
		if valid && (err != nil || c.offset != 30*time.Second) {
			t.Fatalf("clock fallback failed: %v %v", err, c.offset)
		}
		if !valid && Code(err) != "authentication_failed" {
			t.Fatal(err)
		}
	}
}
func TestMultipleHTTPAuthenticationHeadersSelectDigest(t *testing.T) {
	c := fixtureClient(t, false)
	calls := 0
	c.http = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return &http.Response{StatusCode: 401, Header: http.Header{"Www-Authenticate": []string{`Basic realm="camera"`, `Digest realm="camera", nonce="12345", algorithm=MD5, qop="auth"`}}, Body: io.NopCloser(strings.NewReader(""))}, nil
		}
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Digest ") {
			t.Error("Digest challenge was ignored")
		}
		return response(envelope(deviceNS, "GetDeviceInformation", `<m:Model>test</m:Model>`)), nil
	})}
	_, err := c.soap(context.Background(), c.device.URL, deviceNS, "GetDeviceInformation", "", false)
	if err != nil || calls != 2 {
		t.Fatal(err, calls)
	}
}

func TestActualTLSLeafPinAndUntrustedCertificate(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/soap+xml")
		fmt.Fprint(w, envelope(deviceNS, "GetDeviceInformation", `<m:Model>TLS camera</m:Model>`))
	}))
	defer server.Close()
	sum := sha256.Sum256(server.Certificate().Raw)
	for _, tc := range []struct {
		pin   string
		valid bool
	}{{fmt.Sprintf("%x", sum), true}, {strings.Repeat("0", 64), false}, {"", false}} {
		client, err := NewClient(Device{URL: "https://192.0.2.10/device", Username: "operator", Password: "test", CertificateSHA256: tc.pin}, Policy{AllowedCIDRs: []string{"192.0.2.0/24"}, TimeoutSeconds: 3})
		if err != nil {
			t.Fatal(err)
		}
		transport := client.http.Transport.(*http.Transport)
		// Test-only socket routing to a real TLS listener. The production transport
		// retains its CIDR-validated/pinned dialer; certificate checks stay unmodified.
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
		}
		_, err = client.soap(context.Background(), client.device.URL, deviceNS, "GetDeviceInformation", "", false)
		client.Close()
		if tc.valid && err != nil {
			t.Fatalf("explicit leaf pin failed: %v", err)
		}
		if !tc.valid && Code(err) != "certificate_untrusted" {
			t.Fatalf("untrusted camera accepted: %v", err)
		}
	}
}

func TestMediaURIFractionalLifetime(t *testing.T) {
	for input, want := range map[string]int{"PT0S": 0, "PT0.5S": 1, "PT1.01S": 2, "PT2M": 120, "P1D": -1, "PT": -1, "PTNaNS": -1} {
		if got := durationSeconds(input); got != want {
			t.Errorf("%s: got %d, want %d", input, got, want)
		}
	}
}
