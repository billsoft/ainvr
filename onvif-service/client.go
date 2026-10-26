package onvif

import (
	"context"
	"crypto/rand"
	"crypto/sha1" // UsernameToken digest is defined by the ONVIF WS-Security binding.
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/icholy/digest"
)

type Device struct {
	URL               string `json:"url"`
	Username          string `json:"username"`
	Password          string `json:"password"`
	CertificateSHA256 string `json:"certificateSHA256,omitempty"`
}
type Profile struct {
	Service     string  `json:"service"`
	Token       string  `json:"token"`
	Name        string  `json:"name"`
	VideoSource string  `json:"videoSource"`
	VideoCodec  string  `json:"videoCodec"`
	Width       int     `json:"width"`
	Height      int     `json:"height"`
	FPS         float64 `json:"fps"`
	AudioCodec  string  `json:"audioCodec"`
}
type Capabilities struct {
	Manufacturer       string    `json:"manufacturer"`
	Model              string    `json:"model"`
	Firmware           string    `json:"firmware"`
	Serial             string    `json:"serial"`
	HardwareID         string    `json:"hardwareID"`
	ClockOffsetSeconds int64     `json:"clockOffsetSeconds"`
	ClockVerified      bool      `json:"clockVerified"`
	Profiles           []Profile `json:"profiles"`
	Warnings           []string  `json:"warnings"`
}
type Resolved struct {
	URI                 string  `json:"uri"`
	TimeoutSeconds      int     `json:"timeoutSeconds"`
	InvalidAfterConnect bool    `json:"invalidAfterConnect"`
	InvalidAfterReboot  bool    `json:"invalidAfterReboot"`
	Profile             Profile `json:"profile"`
}
type Client struct {
	device   Device
	policy   Policy
	http     *http.Client
	offset   time.Duration
	services map[string]string
	now      func() time.Time
}

func NewClient(d Device, p Policy) (*Client, error) {
	if e := p.Validate(); e != nil {
		return nil, e
	}
	if len(d.Username) > 128 || len(d.Password) > 256 {
		return nil, failure("invalid_credentials")
	}
	if _, e := p.checkURL(d.URL, "soap"); e != nil {
		return nil, e
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if d.CertificateSHA256 != "" {
		pin, e := hex.DecodeString(d.CertificateSHA256)
		if e != nil || len(pin) != 32 {
			return nil, failure("invalid_certificate_pin")
		}
		// Explicit per-device leaf trust. Never disable TLS checks globally.
		tlsConfig.InsecureSkipVerify = true
		tlsConfig.VerifyConnection = func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return failure("certificate_untrusted")
			}
			sum := sha256.Sum256(state.PeerCertificates[0].Raw)
			if subtle.ConstantTimeCompare(sum[:], pin) != 1 {
				return failure("certificate_untrusted")
			}
			return nil
		}
	}
	transport := &http.Transport{Proxy: nil, DialContext: p.dial, TLSClientConfig: tlsConfig, TLSHandshakeTimeout: time.Duration(p.TimeoutSeconds) * time.Second, ResponseHeaderTimeout: time.Duration(p.TimeoutSeconds) * time.Second, MaxResponseHeaderBytes: 32768, DisableKeepAlives: true}
	return &Client{device: d, policy: p, http: &http.Client{Transport: transport, Timeout: time.Duration(p.TimeoutSeconds) * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return failure("redirect_not_allowed") }}, services: map[string]string{}, now: time.Now}, nil
}
func (c *Client) Close() { c.http.CloseIdleConnections() }
func (c *Client) security() string {
	if c.device.Username == "" {
		return ""
	}
	nonce := make([]byte, 20)
	_, _ = rand.Read(nonce)
	created := c.now().Add(c.offset).UTC().Format(time.RFC3339)
	h := sha1.New()
	h.Write(nonce)
	h.Write([]byte(created))
	h.Write([]byte(c.device.Password))
	return `<wsse:Security s:mustUnderstand="1" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><wsse:UsernameToken><wsse:Username>` + escape(c.device.Username) + `</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">` + base64.StdEncoding.EncodeToString(h.Sum(nil)) + `</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">` + base64.StdEncoding.EncodeToString(nonce) + `</wsse:Nonce><wsu:Created>` + created + `</wsu:Created></wsse:UsernameToken></wsse:Security>`
}
func (c *Client) soap(ctx context.Context, endpoint, namespace, action, inner string, anonymous bool) (*node, error) {
	u, e := c.policy.checkURL(endpoint, "soap")
	if e != nil {
		return nil, e
	}
	base, _ := url.Parse(c.device.URL)
	if !strings.EqualFold(u.Hostname(), base.Hostname()) {
		return nil, failure("service_host_changed")
	}
	header := ""
	if !anonymous {
		header = c.security()
	}
	body := `<s:Envelope xmlns:s="` + soapNS + `" xmlns:tt="` + schemaNS + `"><s:Header>` + header + `</s:Header><s:Body><m:` + action + ` xmlns:m="` + namespace + `">` + inner + `</m:` + action + `></s:Body></s:Envelope>`
	authorization := ""
	for attempt := 0; attempt < 2; attempt++ {
		req, e := http.NewRequestWithContext(ctx, "POST", endpoint, strings.NewReader(body))
		if e != nil {
			return nil, failure("invalid_device_address")
		}
		req.Header.Set("Content-Type", `application/soap+xml; charset=utf-8; action="`+namespace+`/`+action+`"`)
		if authorization != "" {
			req.Header.Set("Authorization", authorization)
		}
		resp, e := c.http.Do(req)
		if e != nil {
			var unknown x509.UnknownAuthorityError
			var hostname x509.HostnameError
			var invalid x509.CertificateInvalidError
			var verification *tls.CertificateVerificationError
			if Code(e) == "certificate_untrusted" || errors.As(e, &unknown) || errors.As(e, &hostname) || errors.As(e, &invalid) || errors.As(e, &verification) {
				return nil, failure("certificate_untrusted")
			}
			if Code(e) == "redirect_not_allowed" {
				return nil, failure("redirect_not_allowed")
			}
			return nil, failure("device_unreachable")
		}
		data, e := io.ReadAll(io.LimitReader(resp.Body, (2<<20)+1))
		resp.Body.Close()
		if e != nil {
			return nil, failure("device_unreachable")
		}
		if len(data) > 2<<20 {
			return nil, failure("response_too_large")
		}
		if resp.StatusCode == 401 {
			if attempt != 0 || anonymous {
				return nil, failure("authentication_failed")
			}
			var challenge *digest.Challenge
			for _, value := range resp.Header.Values("WWW-Authenticate") {
				parsed, err := digest.ParseChallenge(value)
				if err == nil {
					challenge = parsed
					break
				}
			}
			if challenge == nil {
				return nil, failure("authentication_failed")
			}
			// Core 5.9.1: do not send HTTP and WS-Security credentials together.
			// For auth-int, hash exactly the replacement body used on the retry.
			body = strings.Replace(body, header, "", 1)
			req.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader(body)), nil }
			credential, e := digest.Digest(challenge, digest.Options{Username: c.device.Username, Password: c.device.Password, Method: "POST", URI: u.RequestURI(), Count: 1, GetBody: req.GetBody})
			if e != nil {
				return nil, failure("authentication_unsupported")
			}
			authorization = credential.String()
			continue
		}
		tree, e := parseXML(data)
		if e != nil {
			return nil, e
		}
		if tree.Name.Space != soapNS || tree.Name.Local != "Envelope" {
			return nil, failure("invalid_soap")
		}
		payload := tree.child("Body")
		if payload == nil || payload.Name.Space != soapNS {
			return nil, failure("invalid_soap")
		}
		if fault := payload.child("Fault"); fault != nil {
			if fault.Name.Space != soapNS {
				return nil, failure("invalid_soap")
			}
			return nil, failure(faultCode(fault))
		}
		if resp.StatusCode != 200 {
			return nil, failure("device_fault")
		}
		response := payload.child(action + "Response")
		if response == nil || response.Name.Space != namespace {
			return nil, failure("invalid_soap")
		}
		return response, nil
	}
	return nil, failure("authentication_failed")
}
func (c *Client) clock(ctx context.Context) error {
	n, e := c.soap(ctx, c.device.URL, deviceNS, "GetSystemDateAndTime", "", true)
	if Code(e) == "authentication_failed" {
		// Some cameras protect even the time service. One authenticated attempt,
		// with the same bounded Digest fallback as other requests; no login loop.
		n, e = c.soap(ctx, c.device.URL, deviceNS, "GetSystemDateAndTime", "", false)
		if e != nil {
			return e
		}
	}
	if e != nil {
		return nil
	}
	t := n.path("SystemDateAndTime", "UTCDateTime")
	if t == nil {
		return nil
	}
	date, clock := t.child("Date"), t.child("Time")
	get := func(n *node, k string) int { v, _ := strconv.Atoi(n.text(k)); return v }
	year, month, day := get(date, "Year"), get(date, "Month"), get(date, "Day")
	hour, min, sec := get(clock, "Hour"), get(clock, "Minute"), get(clock, "Second")
	if year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || min < 0 || min > 59 || sec < 0 || sec > 59 {
		return nil
	}
	at := time.Date(year, time.Month(month), day, hour, min, sec, 0, time.UTC)
	if at.Day() != day {
		return nil
	}
	c.offset = at.Sub(c.now())
	c.services["clock"] = "verified"
	return nil
}
func (c *Client) endpoints(ctx context.Context) error {
	if e := c.clock(ctx); e != nil {
		return e
	}
	n, e := c.soap(ctx, c.device.URL, deviceNS, "GetServices", "<m:IncludeCapability>false</m:IncludeCapability>", false)
	if e != nil && Code(e) != "operation_unsupported" {
		return e
	}
	if e == nil {
		for _, s := range n.Children {
			if s.Name.Space != deviceNS || s.Name.Local != "Service" {
				continue
			}
			namespace := s.text("Namespace")
			if namespace == media1NS || namespace == media2NS {
				c.services[namespace] = s.text("XAddr")
			}
		}
	}
	if len(c.services) == 0 || (len(c.services) == 1 && c.services["clock"] != "") {
		n, e = c.soap(ctx, c.device.URL, deviceNS, "GetCapabilities", "<m:Category>Media</m:Category>", false)
		if e != nil {
			return e
		}
		if endpoint := n.path("Capabilities", "Media").text("XAddr"); endpoint != "" {
			c.services[media1NS] = endpoint
		}
	}
	if c.services[media1NS] == "" && c.services[media2NS] == "" {
		return failure("media_service_unavailable")
	}
	return nil
}
func number(n *node, k string) int { v, _ := strconv.Atoi(n.text(k)); return v }
func (c *Client) profiles(ctx context.Context) ([]Profile, error) {
	profiles := []Profile{}
	for _, ns := range []string{media2NS, media1NS} {
		endpoint := c.services[ns]
		if endpoint == "" {
			continue
		}
		inner := ""
		if ns == media2NS {
			inner = "<m:Type>All</m:Type>"
		}
		n, e := c.soap(ctx, endpoint, ns, "GetProfiles", inner, false)
		if Code(e) == "operation_unsupported" {
			continue
		}
		if e != nil {
			return nil, e
		}
		for _, p := range n.Children {
			if p.Name.Local != "Profiles" || p.Name.Space != ns {
				continue
			}
			if len(profiles) >= 256 {
				return nil, failure("profile_limit")
			}
			source, video, audio := p.child("VideoSourceConfiguration"), p.child("VideoEncoderConfiguration"), p.child("AudioEncoderConfiguration")
			if ns == media2NS {
				configs := p.child("Configurations")
				source, video, audio = configs.child("VideoSource"), configs.child("VideoEncoder"), configs.child("AudioEncoder")
			}
			service := "media1"
			if ns == media2NS {
				service = "media2"
			}
			fps, _ := strconv.ParseFloat(video.path("RateControl").text("FrameRateLimit"), 64)
			row := Profile{Service: service, Token: p.attr("token"), Name: p.text("Name"), VideoSource: source.text("SourceToken"), VideoCodec: strings.ToUpper(video.text("Encoding")), Width: number(video.child("Resolution"), "Width"), Height: number(video.child("Resolution"), "Height"), FPS: fps, AudioCodec: strings.ToUpper(audio.text("Encoding"))}
			if row.Token == "" || len(row.Token) > 256 || row.VideoSource == "" || len(row.VideoSource) > 256 {
				continue
			}
			profiles = append(profiles, row)
		}
	}
	if len(profiles) == 0 {
		return nil, failure("profiles_unavailable")
	}
	return profiles, nil
}
func (c *Client) Probe(ctx context.Context) (Capabilities, error) {
	result := Capabilities{Profiles: []Profile{}, Warnings: []string{}}
	if e := c.endpoints(ctx); e != nil {
		return result, e
	}
	n, e := c.soap(ctx, c.device.URL, deviceNS, "GetDeviceInformation", "", false)
	if e != nil {
		return result, e
	}
	result.Manufacturer = n.text("Manufacturer")
	result.Model = n.text("Model")
	result.Serial = n.text("SerialNumber")
	result.Firmware = n.text("FirmwareVersion")
	result.HardwareID = n.text("HardwareId")
	result.ClockOffsetSeconds = int64(c.offset.Seconds())
	result.ClockVerified = c.services["clock"] != ""
	if !result.ClockVerified {
		result.Warnings = append(result.Warnings, "device_clock_unverified")
	}
	result.Profiles, e = c.profiles(ctx)
	return result, e
}
func (c *Client) Resolve(ctx context.Context, service, token, source string) (Resolved, error) {
	result := Resolved{}
	if e := c.endpoints(ctx); e != nil {
		return result, e
	}
	profiles, e := c.profiles(ctx)
	if e != nil {
		return result, e
	}
	found := false
	for _, p := range profiles {
		if p.Service == service && p.Token == token && p.VideoSource == source {
			result.Profile = p
			found = true
			break
		}
	}
	if !found {
		return result, failure("profile_not_found")
	}
	ns := media1NS
	inner := `<m:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></m:StreamSetup>`
	if service == "media2" {
		ns = media2NS
		inner = "<m:Protocol>RTSP</m:Protocol>"
	}
	inner += "<m:ProfileToken>" + escape(token) + "</m:ProfileToken>"
	n, e := c.soap(ctx, c.services[ns], ns, "GetStreamUri", inner, false)
	if e != nil {
		return result, e
	}
	media := n
	if service == "media1" {
		media = n.child("MediaUri")
	}
	u, e := c.policy.checkURL(media.text("Uri"), "rtsp")
	if e != nil {
		return result, e
	}
	base, _ := url.Parse(c.device.URL)
	if !strings.EqualFold(base.Hostname(), u.Hostname()) {
		return result, failure("media_host_changed")
	}
	ips, e := c.policy.resolve(ctx, u.Hostname())
	if e != nil {
		return result, e
	}
	if len(ips) == 0 {
		return result, failure("address_not_allowed")
	}
	result.URI = u.String()
	result.TimeoutSeconds = durationSeconds(media.text("Timeout"))
	result.InvalidAfterConnect = media.text("InvalidAfterConnect") == "true"
	result.InvalidAfterReboot = media.text("InvalidAfterReboot") == "true"
	return result, nil
}
func durationSeconds(s string) int { // xsd:duration subset used for media URI lifetimes.
	if s == "" || s == "PT0S" {
		return 0
	}
	var total float64
	if strings.HasPrefix(s, "PT") {
		rest := s[2:]
		start := 0
		for i, r := range rest {
			if r == 'H' || r == 'M' || r == 'S' {
				v, e := strconv.ParseFloat(rest[start:i], 64)
				if e != nil || v < 0 || math.IsNaN(v) || math.IsInf(v, 0) {
					return -1
				}
				factor := float64(1)
				if r == 'H' {
					factor = 3600
				}
				if r == 'M' {
					factor = 60
				}
				total += v * factor
				start = i + 1
			}
		}
		if rest == "" || start != len(rest) || total > 86400*365 {
			return -1
		}
		return int(math.Ceil(total))
	}
	return -1
}
