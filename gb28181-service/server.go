package gateway

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
)

type DeviceConfig struct {
	ID       string   `json:"id"`
	Password string   `json:"password"`
	Version  string   `json:"version"`
	Enabled  bool     `json:"enabled"`
	MediaIPs []string `json:"mediaIPs,omitempty"`
}
type Config struct {
	ServerID            string         `json:"serverId"`
	Realm               string         `json:"realm"`
	Listen              string         `json:"listen"`
	AdvertiseIP         string         `json:"advertiseIp"`
	MaxDevices          int            `json:"maxDevices"`
	MaxCatalogItems     int            `json:"maxCatalogItems"`
	HeartbeatTimeoutSec int            `json:"heartbeatTimeoutSec"`
	Devices             []DeviceConfig `json:"devices"`
}

func (c Config) Validate() error {
	if !deviceIDPattern.MatchString(c.ServerID) || len(c.Realm) != 10 {
		return errors.New("invalid SIP identity")
	}
	for _, r := range c.Realm {
		if r < '0' || r > '9' {
			return errors.New("invalid SIP realm")
		}
	}
	if net.ParseIP(c.AdvertiseIP) == nil {
		return errors.New("advertised SIP address must be an IP")
	}
	host, port, e := net.SplitHostPort(c.Listen)
	if e != nil || net.ParseIP(host) == nil {
		return errors.New("invalid listen address")
	}
	p, e := strconv.Atoi(port)
	if e != nil || p < 1024 || p > 65535 {
		return errors.New("invalid SIP listen port")
	}
	if c.MaxDevices < 1 || c.MaxDevices > 1024 || len(c.Devices) > c.MaxDevices || c.MaxCatalogItems < 1 || c.MaxCatalogItems > 10000 || c.HeartbeatTimeoutSec < 30 || c.HeartbeatTimeoutSec > 3600 {
		return errors.New("invalid capacity settings")
	}
	seen := map[string]bool{}
	for _, d := range c.Devices {
		if !deviceIDPattern.MatchString(d.ID) || seen[d.ID] || len(d.Password) < 8 || len(d.Password) > 256 {
			return errors.New("invalid provisioned device")
		}
		if len(d.MediaIPs) > 8 {
			return errors.New("too many media addresses")
		}
		for _, address := range d.MediaIPs {
			if !validDeviceMediaIP(address) {
				return errors.New("invalid trusted media address")
			}
		}
		seen[d.ID] = true
		if _, e := SelectVersion(d.Version, ""); e != nil {
			return e
		}
	}
	return nil
}

type DeviceState struct {
	ID              string        `json:"id"`
	Registered      bool          `json:"registered"`
	Version         Version       `json:"version"`
	ExpiresAt       time.Time     `json:"expiresAt"`
	LastSeen        time.Time     `json:"lastSeen"`
	Generation      uint64        `json:"generation"`
	CatalogComplete bool          `json:"catalogComplete"`
	Catalog         []CatalogItem `json:"catalog"`
	LastError       string        `json:"lastError,omitempty"`
	Info            *DeviceInfo   `json:"info,omitempty"`
	DeviceOnline    string        `json:"deviceOnline,omitempty"`
	pending         map[string]pendingQuery
	source          string
	transport       string
	connection      sip.Connection
	query           *Catalog
}
type Server struct {
	config   Config
	ua       *sipgo.UserAgent
	sip      *sipgo.Server
	client   *sipgo.Client
	auth     *Authenticator
	mu       sync.Mutex
	devices  map[string]DeviceConfig
	states   map[string]*DeviceState
	sequence atomic.Uint32
	queries  chan struct{}
	dialogs  map[string]*sipgo.DialogClientCache
}
type DeviceInfo struct {
	Name         string `json:"name"`
	Manufacturer string `json:"manufacturer"`
	Model        string `json:"model"`
	Firmware     string `json:"firmware"`
}
type pendingQuery struct {
	sn      string
	expires time.Time
}

func NewServer(config Config) (*Server, error) {
	if e := config.Validate(); e != nil {
		return nil, e
	}
	// SIP library diagnostics can contain raw packets; do not expose those in
	// ordinary logs. Structured operation errors are returned by this service.
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	ua, e := sipgo.NewUA(sipgo.WithUserAgent("AINVR-GB28181"),
		sipgo.WithUserAgentTransportLayerOptions(sip.WithTransportLayerLogger(quiet)),
		sipgo.WithUserAgentTransactionLayerOptions(sip.WithTransactionLayerLogger(quiet)))
	if e != nil {
		return nil, e
	}
	srv, e := sipgo.NewServer(ua, sipgo.WithServerLogger(quiet))
	if e != nil {
		ua.Close()
		return nil, e
	}
	_, port, _ := net.SplitHostPort(config.Listen)
	p, _ := strconv.Atoi(port)
	client, e := sipgo.NewClient(ua, sipgo.WithClientHostname(config.AdvertiseIP), sipgo.WithClientPort(p))
	if e != nil {
		ua.Close()
		return nil, e
	}
	s := &Server{config: config, ua: ua, sip: srv, client: client, auth: NewAuthenticator(config.Realm, config.MaxDevices*4), devices: map[string]DeviceConfig{}, states: map[string]*DeviceState{}, queries: make(chan struct{}, 8)}
	s.dialogs = make(map[string]*sipgo.DialogClientCache)
	for _, transport := range []string{"UDP", "TCP"} {
		s.dialogs[transport] = sipgo.NewDialogClientCache(client, sip.ContactHeader{Address: sip.Uri{Scheme: "sip", User: config.ServerID, Host: config.AdvertiseIP, Port: p, UriParams: sip.HeaderParams{{K: "transport", V: strings.ToLower(transport)}}}})
	}
	for _, d := range config.Devices {
		s.devices[d.ID] = d
		s.states[d.ID] = &DeviceState{ID: d.ID}
	}
	srv.OnRegister(s.register)
	srv.OnMessage(s.message)
	srv.OnBye(func(req *sip.Request, tx sip.ServerTransaction) {
		cache := s.dialogs[req.Transport()]
		if cache == nil {
			s.respond(req, tx, 481, "Call Does Not Exist")
			return
		}
		dialog, e := cache.MatchRequestDialog(req)
		if e != nil || dialog.InviteRequest.Destination() != req.Source() {
			s.respond(req, tx, 481, "Call Does Not Exist")
			return
		}
		_ = dialog.ReadBye(req, tx)
	})
	srv.OnNoRoute(func(req *sip.Request, tx sip.ServerTransaction) { s.respond(req, tx, 405, "Method Not Allowed") })
	return s, nil
}
func (s *Server) Close() { s.ua.Close() }
func (s *Server) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	errs := make(chan error, 2)
	for _, transport := range []string{"udp", "tcp"} {
		go func(network string) { errs <- s.sip.ListenAndServe(ctx, network, s.config.Listen) }(transport)
	}
	select {
	case <-ctx.Done():
		return nil
	case e := <-errs:
		return e
	}
}
func (s *Server) respond(req *sip.Request, tx sip.ServerTransaction, code int, reason string, headers ...sip.Header) {
	r := sip.NewResponseFromRequest(req, code, reason, nil)
	r.AppendHeader(sip.NewHeader("X-GB-Ver", "3.0"))
	for _, h := range headers {
		r.AppendHeader(h)
	}
	_ = tx.Respond(r)
}
func header(req *sip.Request, name string) string {
	h := req.GetHeader(name)
	if h == nil {
		return ""
	}
	return h.Value()
}
func requestDevice(req *sip.Request) string {
	if req.From() == nil {
		return ""
	}
	return req.From().Address.User
}
func (s *Server) online(st *DeviceState, now time.Time) bool {
	if st == nil || !st.Registered || !now.Before(st.ExpiresAt) || now.Sub(st.LastSeen) >= time.Duration(s.config.HeartbeatTimeoutSec)*time.Second {
		return false
	}
	if st.transport == "TCP" {
		// Inspect the existing transport only; never dial to test liveness.
		// Connection identity prevents a new socket from inheriting registration.
		conn, err := s.ua.TransportLayer().GetConnection("tcp", st.source)
		if err != nil {
			return false
		}
		defer conn.TryClose() // GetConnection increments the library reference count.
		return st.connection != nil && conn == st.connection
	}
	return true
}
func (s *Server) register(req *sip.Request, tx sip.ServerTransaction) {
	id := requestDevice(req)
	d, ok := s.devices[id]
	if !ok || !d.Enabled {
		s.respond(req, tx, 403, "Forbidden")
		return
	}
	if len(req.Body()) > 0 || len(req.String()) > 16*1024 {
		s.respond(req, tx, 400, "Bad Request")
		return
	}
	expires, err := registrationExpires(req)
	if err != nil {
		s.respond(req, tx, 400, "Bad Expires")
		return
	}
	if expires > 0 && expires < 60 {
		s.respond(req, tx, 423, "Interval Too Brief", sip.NewHeader("Min-Expires", "60"))
		return
	}
	now := time.Now()
	auth := header(req, "Authorization")
	if auth == "" {
		ch, e := s.auth.Challenge(id, req.Source(), now)
		if e != nil {
			s.respond(req, tx, 503, "Service Unavailable")
			return
		}
		s.respond(req, tx, 401, "Unauthorized", sip.NewHeader("WWW-Authenticate", ch))
		return
	}
	if e := s.auth.Verify(auth, id, d.Password, req.Source(), "REGISTER", req.Recipient.String(), now); e != nil {
		if errors.Is(e, ErrChallengeRequired) {
			challenge, err := s.auth.Challenge(id, req.Source(), now)
			if err != nil {
				s.respond(req, tx, 503, "Service Unavailable")
				return
			}
			s.respond(req, tx, 401, "Unauthorized", sip.NewHeader("WWW-Authenticate", challenge))
			return
		}
		s.respond(req, tx, 403, "Forbidden")
		return
	}
	version, e := SelectVersion(d.Version, header(req, "X-GB-Ver"))
	if e != nil {
		s.respond(req, tx, 400, "Unsupported Version")
		return
	}
	s.mu.Lock()
	st := s.states[id]
	peerChanged := st.source != req.Source() || st.transport != req.Transport()
	// Only a newly authenticated registration may rebind the port of the same
	// provisioned device on the same host. Different hosts remain conflicts while
	// online. The old endpoint loses message and media-session authority.
	oldIP, _, oldErr := net.SplitHostPort(st.source)
	newIP, _, newErr := net.SplitHostPort(req.Source())
	sameHost := oldErr == nil && newErr == nil && net.ParseIP(oldIP).Equal(net.ParseIP(newIP))
	if s.online(st, now) && peerChanged && (!sameHost || expires == 0) {
		st.LastError = "registration_conflict"
		s.mu.Unlock()
		s.respond(req, tx, 409, "Identity Conflict")
		return
	}
	if !s.online(st, now) || expires == 0 || peerChanged {
		st.Generation++
		st.CatalogComplete = false
		st.query = nil
		st.pending = nil
		st.Info = nil
		st.DeviceOnline = ""
	}
	st.Registered = expires > 0
	st.ExpiresAt = now.Add(time.Duration(expires) * time.Second)
	st.LastSeen = now
	st.source = req.Source()
	st.transport = req.Transport()
	st.connection = nil
	if st.transport == "TCP" {
		conn, err := s.ua.TransportLayer().GetConnection("tcp", st.source)
		if err == nil {
			st.connection = conn
			_, _ = conn.TryClose()
		}
	}
	st.Version = version
	st.LastError = ""
	s.mu.Unlock()
	// GB registration clock synchronization uses Beijing time and XML date
	// syntax (2016 section 9.10.3), rather than RFC 1123's SIP default.
	headers := []sip.Header{sip.NewHeader("Expires", strconv.Itoa(expires)), sip.NewHeader("Date", now.In(time.FixedZone("CST", 8*3600)).Format("2006-01-02T15:04:05.000"))}
	if req.Contact() != nil {
		headers = append(headers, req.Contact())
	}
	s.respond(req, tx, 200, "OK", headers...)
}
func (s *Server) message(req *sip.Request, tx sip.ServerTransaction) {
	id := requestDevice(req)
	now := time.Now()
	s.mu.Lock()
	st := s.states[id]
	allowed := s.online(st, now) && st.source == req.Source() && st.transport == req.Transport()
	s.mu.Unlock()
	if !allowed {
		s.respond(req, tx, 403, "Forbidden")
		return
	}
	if !strings.HasPrefix(strings.ToLower(header(req, "Content-Type")), "application/manscdp+xml") {
		s.respond(req, tx, 415, "Unsupported Media Type")
		return
	}
	m, e := ParseBusinessMessage(req.Body(), s.config.MaxCatalogItems)
	if e != nil || m.DeviceID != id {
		s.respond(req, tx, 400, "Bad Request")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Parsing runs outside the lock; registration may have changed meanwhile.
	if !s.online(st, time.Now()) || st.source != req.Source() || st.transport != req.Transport() {
		s.respond(req, tx, 403, "Forbidden")
		return
	}
	switch m.Command {
	case "DeviceInfo", "DeviceStatus":
		pending, found := st.pending[m.Command]
		if m.XMLName.Local != "Response" || !found || pending.sn != m.SN || now.After(pending.expires) {
			s.respond(req, tx, 400, "Unsolicited Device Response")
			return
		}
		if m.Result != "OK" && m.Result != "ERROR" {
			s.respond(req, tx, 400, "Invalid Query Result")
			return
		}
		if m.Result != "OK" {
			st.LastError = "device_query_failed"
		} else if m.Command == "DeviceInfo" {
			if len(m.DeviceName) > 512 || len(m.Manufacturer) > 512 || len(m.Model) > 512 || len(m.Firmware) > 512 {
				s.respond(req, tx, 400, "Device Info Too Large")
				return
			}
			st.Info = &DeviceInfo{m.DeviceName, m.Manufacturer, m.Model, m.Firmware}
		} else {
			if m.Online != "ONLINE" && m.Online != "OFFLINE" {
				s.respond(req, tx, 400, "Invalid Device Status")
				return
			}
			st.DeviceOnline = m.Online
		}
	case "Keepalive":
		if m.XMLName.Local != "Notify" || (m.Status != "OK" && m.Status != "ERROR") {
			s.respond(req, tx, 400, "Bad Keepalive")
			return
		}
		st.LastSeen = now
		// ERROR reports a live but unhealthy device; it is not a broken heartbeat.
		if m.Status == "ERROR" {
			st.LastError = "device_reported_error"
		} else if st.LastError == "device_reported_error" {
			st.LastError = ""
		}
	case "Catalog":
		if m.XMLName.Local != "Response" || st.query == nil {
			s.respond(req, tx, 400, "Unsolicited Catalog")
			return
		}
		done, e := st.query.Add(m, now)
		if e != nil {
			s.respond(req, tx, 400, "Invalid Catalog Generation")
			return
		}
		if done {
			st.Catalog = selectableCatalog(st.query.Snapshot())
			st.CatalogComplete = true
		}
	default:
		s.respond(req, tx, 501, "Not Implemented")
		return
	}
	s.respond(req, tx, 200, "OK")
}
func (s *Server) RefreshCatalog(ctx context.Context, id string) error {
	return s.RefreshQuery(ctx, id, "Catalog")
}
func (s *Server) RefreshQuery(ctx context.Context, id, command string) error {
	if command != "Catalog" && command != "DeviceInfo" && command != "DeviceStatus" {
		return errors.New("unsupported query")
	}
	select {
	case s.queries <- struct{}{}:
		defer func() { <-s.queries }()
	default:
		return errors.New("query capacity exhausted")
	}
	s.mu.Lock()
	st := s.states[id]
	if !s.online(st, time.Now()) {
		s.mu.Unlock()
		return errors.New("device not registered")
	}
	sn := s.sequence.Add(1)
	if sn == 0 {
		sn = s.sequence.Add(1)
	}
	if command == "Catalog" {
		st.query = NewCatalog(strconv.FormatUint(uint64(sn), 10), time.Now().Add(30*time.Second), s.config.MaxCatalogItems)
		st.CatalogComplete = false
	} else {
		if st.pending == nil {
			st.pending = map[string]pendingQuery{}
		}
		st.pending[command] = pendingQuery{strconv.FormatUint(uint64(sn), 10), time.Now().Add(30 * time.Second)}
	}
	source, transport, profile := st.source, st.transport, st.Version.Profile
	s.mu.Unlock()
	body, err := QueryXMLForProfile(command, id, sn, profile)
	if err != nil {
		return err
	}
	req := s.request(sip.MESSAGE, id, source, transport, body, "Application/MANSCDP+xml")
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	res, e := s.client.Do(ctx, req)
	if e != nil {
		return errors.New("catalog query transport failed")
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("catalog query rejected: %d", res.StatusCode)
	}
	return nil
}
func (s *Server) request(method sip.RequestMethod, id, source, transport string, body []byte, contentType string) *sip.Request {
	req := sip.NewRequest(method, sip.Uri{Scheme: "sip", User: id, Host: s.config.Realm})
	req.SetDestination(source)
	req.SetTransport(transport)
	req.AppendHeader(&sip.FromHeader{Address: sip.Uri{Scheme: "sip", User: s.config.ServerID, Host: s.config.Realm}, Params: sip.HeaderParams{{K: "tag", V: fmt.Sprintf("%x", s.sequence.Add(1))}}})
	req.AppendHeader(&sip.ToHeader{Address: sip.Uri{Scheme: "sip", User: id, Host: s.config.Realm}})
	req.AppendHeader(sip.NewHeader("Content-Type", contentType))
	req.SetBody(body)
	return req
}
func (s *Server) Snapshot() []DeviceState {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]DeviceState, 0, len(s.states))
	for _, st := range s.states {
		v := *st
		v.Registered = s.online(st, time.Now())
		v.Catalog = append([]CatalogItem(nil), st.Catalog...)
		out = append(out, v)
	}
	return out
}

// RFC 3261 section 10.3: a Contact expiration overrides the Expires header.
func registrationExpires(req *sip.Request) (int, error) {
	value := header(req, "Expires")
	present := value != ""
	if contact := req.Contact(); contact != nil {
		if v, ok := contact.Params.Get("expires"); ok {
			value, present = v, true
		}
	}
	if !present {
		return 3600, nil
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < 0 || n > 86400 {
		return 0, errors.New("invalid registration expiration")
	}
	return n, nil
}
