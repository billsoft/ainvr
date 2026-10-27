package gateway

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type MediaConfig struct {
	DomainID    string `json:"domainId"`
	API         string `json:"api"`
	Secret      string `json:"secret"`
	ListenIP    string `json:"listenIp"`
	AdvertiseIP string `json:"advertiseIp"`
	PortStart   int    `json:"portStart"`
	PortEnd     int    `json:"portEnd"`
	Capacity    int    `json:"capacity"`
}

var mediaLeaseSuffix = regexp.MustCompile(`^[a-f0-9]{32}$`)

type MediaLease struct {
	Stream string `json:"stream"`
	Port   int    `json:"port"`
	SSRC   uint32 `json:"ssrc"`
	Mode   string `json:"mode"`
}
type MediaReceiver struct {
	config   MediaConfig
	client   *http.Client
	mu       sync.Mutex
	leases   map[string]MediaLease
	pending  map[string]bool
	nextPort int
	retired  map[uint32]time.Time
}

func NewMediaReceiver(c MediaConfig) (*MediaReceiver, error) {
	u, e := url.Parse(c.API)
	if e != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" && u.Path != "/" {
		return nil, errors.New("invalid media API")
	}
	ip := net.ParseIP(u.Hostname())
	if ip == nil || (!ip.IsLoopback() && u.Scheme != "https") || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, errors.New("media API requires loopback HTTP or protected HTTPS")
	}
	if !deviceIDPattern.MatchString(c.DomainID) || len(c.Secret) < 16 || net.ParseIP(c.ListenIP) == nil || net.ParseIP(c.AdvertiseIP) == nil || c.Capacity < 1 || c.Capacity > 4 || c.PortStart < 1024 || c.PortStart%2 != 0 || c.PortEnd > 65535 || c.PortEnd-c.PortStart < 2*c.Capacity {
		return nil, errors.New("invalid media limits")
	}
	return &MediaReceiver{config: c, client: &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, leases: map[string]MediaLease{}, pending: map[string]bool{}, nextPort: c.PortStart, retired: map[uint32]time.Time{}}, nil
}
func (m *MediaReceiver) call(ctx context.Context, operation string, args url.Values) (map[string]json.RawMessage, error) {
	args.Set("secret", m.config.Secret)
	req, e := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(m.config.API, "/")+"/index/api/"+operation, strings.NewReader(args.Encode()))
	if e != nil {
		return nil, errors.New("media request invalid")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := m.client
	if operation == "connectRtpServer" {
		// Pinned ZLM connectToServer performs a five-second asynchronous dial.
		// Keep the API request alive long enough to receive that real result;
		// other management operations retain their three-second deadline.
		connect := *m.client
		connect.Timeout = 6 * time.Second
		client = &connect
	}
	r, e := client.Do(req)
	if e != nil {
		return nil, errors.New("media service unavailable")
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return nil, errors.New("media service rejected request")
	}
	b, e := io.ReadAll(io.LimitReader(r.Body, 1024*1024+1))
	if e != nil || len(b) > 1024*1024 {
		return nil, errors.New("invalid media response")
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(b, &result) != nil {
		return nil, errors.New("invalid media response")
	}
	var code int
	if json.Unmarshal(result["code"], &code) != nil || code != 0 {
		return nil, errors.New("media operation failed")
	}
	return result, nil
}

// Retain recently closed SSRCs so delayed UDP packets cannot be accepted if a
// narrow configured port range is reused. The fixed 10,000-value domain bounds
// memory; exhaustion rejects allocation instead of silently recycling identity.
func (m *MediaReceiver) retire(ssrc uint32) {
	domain, _ := strconv.ParseUint(m.config.DomainID[3:8], 10, 32)
	base := uint32(domain) * 10000
	if ssrc != 0 && ssrc >= base && ssrc < base+10000 {
		m.retired[ssrc] = time.Now().Add(2 * time.Minute)
	}
}

// Every session receives a fresh random stream identity and SSRC. Ports remain
// leased on uncertain cleanup, preventing old traffic being assigned to a peer.
func (m *MediaReceiver) Open(ctx context.Context, mode string) (MediaLease, error) {
	tcp := 0
	switch mode {
	case "udp":
	case "tcp-passive":
		tcp = 1
	case "tcp-active":
		tcp = 2
	default:
		return MediaLease{}, errors.New("invalid media transport")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	// Failed cleanup remains quarantined until the receiver acknowledges close.
	// Retry at most one lease per open attempt; never accumulate background jobs.
	for stream := range m.pending {
		if _, err := m.call(ctx, "closeRtpServer", url.Values{"stream_id": {stream}}); err == nil {
			m.retire(m.leases[stream].SSRC)
			delete(m.pending, stream)
			delete(m.leases, stream)
		}
		break
	}
	if len(m.leases) >= m.config.Capacity {
		return MediaLease{}, errors.New("media capacity exhausted")
	}
	used := map[int]bool{}
	ssrcs := map[uint32]bool{}
	now := time.Now()
	for ssrc, until := range m.retired {
		if !now.Before(until) {
			delete(m.retired, ssrc)
		} else {
			ssrcs[ssrc] = true
		}
	}
	for _, l := range m.leases {
		used[l.Port] = true
		ssrcs[l.SSRC] = true
	}
	// Receiver sockets can outlive a gateway process. Never repeatedly choose
	// their occupied first port, delete another lease, or reuse its SSRC.
	inventory, err := m.call(ctx, "listRtpServer", url.Values{})
	if err != nil {
		return MediaLease{}, err
	}
	var active []struct {
		Stream string `json:"stream_id"`
		Port   int    `json:"port"`
		SSRC   uint32 `json:"ssrc"`
	}
	if raw := inventory["data"]; len(raw) > 0 && string(raw) != "null" {
		if json.Unmarshal(raw, &active) != nil || len(active) > 32768 {
			return MediaLease{}, errors.New("invalid receiver inventory")
		}
	}
	namespace := "gb_" + m.config.DomainID + "_"
	cleaned := false
	for _, item := range active {
		if item.SSRC != 0 {
			ssrcs[item.SSRC] = true
		}
		if !cleaned && item.Port >= m.config.PortStart && item.Port < m.config.PortEnd && strings.HasPrefix(item.Stream, namespace) && mediaLeaseSuffix.MatchString(strings.TrimPrefix(item.Stream, namespace)) {
			if _, owned := m.leases[item.Stream]; !owned {
				// Only this platform's explicit lease namespace is recoverable.
				// Unknown/legacy listeners remain untouched. Close must be
				// acknowledged before its port can be assigned again.
				if _, err := m.call(ctx, "closeRtpServer", url.Values{"stream_id": {item.Stream}}); err != nil {
					return MediaLease{}, err
				}
				m.retire(item.SSRC)
				cleaned = true
				continue
			}
		}
		if item.Port > 0 && item.Port <= 65535 {
			used[item.Port] = true
			used[item.Port-1] = true
			used[item.Port+1] = true
		}
	}
	if m.nextPort < m.config.PortStart || m.nextPort >= m.config.PortEnd {
		m.nextPort = m.config.PortStart
	}
	slots := (m.config.PortEnd - m.config.PortStart + 1) / 2
	first := (m.nextPort - m.config.PortStart) / 2
	port := 0
	for offset := 0; offset < slots; offset++ {
		candidate := m.config.PortStart + 2*((first+offset)%slots)
		if !used[candidate] {
			port = candidate
			break
		}
	}
	if port != 0 {
		// Also rotate after a failed bind to a non-ZLM socket. One bounded API
		// attempt per worker cycle; an unavailable API does not trigger a scan.
		m.nextPort = port + 2
		if m.nextPort >= m.config.PortEnd {
			m.nextPort = m.config.PortStart
		}
	}
	if port == 0 {
		return MediaLease{}, errors.New("media ports exhausted")
	}
	b := make([]byte, 16)
	if _, e := rand.Read(b); e != nil {
		return MediaLease{}, e
	}
	// GB/T 28181-2016 Annex F: 0 + domain ID digits 4..8 + four
	// locally unique digits. Randomness alone is not a conforming SSRC.
	domain, _ := strconv.ParseUint(m.config.DomainID[3:8], 10, 32)
	base := uint32(domain) * 10000
	suffix := binary.BigEndian.Uint32(b[:4]) % 10000
	var ssrc uint32
	found := false
	for attempt := uint32(0); attempt < 10000; attempt++ {
		ssrc = base + (suffix+attempt)%10000
		if ssrc != 0 && !ssrcs[ssrc] {
			found = true
			break
		}
	}
	if !found {
		return MediaLease{}, errors.New("media SSRC capacity exhausted")
	}
	l := MediaLease{Stream: fmt.Sprintf("%s%x", namespace, b), Port: port, SSRC: ssrc, Mode: mode}
	m.leases[l.Stream] = l
	result, e := m.call(ctx, "openRtpServer", url.Values{"port": {strconv.Itoa(port)}, "stream_id": {l.Stream}, "tcp_mode": {strconv.Itoa(tcp)}, "local_ip": {m.config.ListenIP}, "ssrc": {strconv.FormatUint(uint64(ssrc), 10)}, "re_use_port": {"0"}, "app": {"rtp"}})
	if e != nil {
		m.pending[l.Stream] = true
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if _, ce := m.call(cleanupCtx, "closeRtpServer", url.Values{"stream_id": {l.Stream}}); ce == nil {
			m.retire(l.SSRC)
			delete(m.leases, l.Stream)
			delete(m.pending, l.Stream)
		}
		return MediaLease{}, e
	}
	var actual int
	if json.Unmarshal(result["port"], &actual) != nil || actual != port {
		m.pending[l.Stream] = true
		return MediaLease{}, errors.New("media port mismatch")
	}
	return l, nil
}
func (m *MediaReceiver) Close(ctx context.Context, l MediaLease) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	current, ok := m.leases[l.Stream]
	if !ok {
		return nil
	}
	if current != l {
		return errors.New("stale media lease")
	}
	if _, e := m.call(ctx, "closeRtpServer", url.Values{"stream_id": {l.Stream}}); e != nil {
		m.pending[l.Stream] = true
		return e
	}
	m.retire(l.SSRC)
	delete(m.leases, l.Stream)
	delete(m.pending, l.Stream)
	return nil
}

var errMediaPeerMismatch = errors.New("media peer does not match negotiated source")

// ZLM pins UDP to the first matching SSRC sender, not to the SDP IP.
// Verify the actual receiver peer before publishing and during the session.
// SDP validation alone cannot prove where received RTP originated.
func (m *MediaReceiver) VerifyPeer(ctx context.Context, l MediaLease, expectedIP string) error {
	result, err := m.call(ctx, "getRtpInfo", url.Values{"stream_id": {l.Stream}, "app": {"rtp"}})
	if err != nil {
		return err
	}
	var exists bool
	var actual string
	if json.Unmarshal(result["exist"], &exists) != nil || !exists {
		return errors.New("media peer unavailable")
	}
	if json.Unmarshal(result["peer_ip"], &actual) != nil || net.ParseIP(expectedIP) == nil || !net.ParseIP(expectedIP).Equal(net.ParseIP(actual)) {
		return errMediaPeerMismatch
	}
	return nil
}

func (m *MediaReceiver) Connect(ctx context.Context, l MediaLease, peerIP string, port int) error {
	if l.Mode != "tcp-active" || net.ParseIP(peerIP) == nil || port < 1 || port > 65535 {
		return errors.New("invalid active media peer")
	}
	_, e := m.call(ctx, "connectRtpServer", url.Values{"stream_id": {l.Stream}, "dst_url": {peerIP}, "dst_port": {strconv.Itoa(port)}})
	return e
}

// Annex D requires at least three reconnections after the initial connection
// fails. Keep the same negotiated lease for the initial attempt plus three
// retries, separated by at least one second. Cancellation stops the sequence.
func (m *MediaReceiver) ConnectWithRetry(ctx context.Context, l MediaLease, peerIP string, port int) error {
	var err error
	for attempt := 0; attempt < 4; attempt++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if attempt > 0 && !wait(ctx, time.Second) {
			return ctx.Err()
		}
		if err = m.Connect(ctx, l, peerIP, port); err == nil {
			return nil
		}
	}
	return err
}
func LiveSDP(serverID, channelID, ip string, l MediaLease) ([]byte, error) {
	if !deviceIDPattern.MatchString(serverID) || !deviceIDPattern.MatchString(channelID) || net.ParseIP(ip) == nil || strings.Contains(ip, ":") || l.Port < 1024 || l.Port > 65535 || l.SSRC == 0 || l.SSRC > 999999999 {
		return nil, errors.New("invalid SDP offer")
	}
	protocol, setup := "RTP/AVP", ""
	switch l.Mode {
	case "udp":
	case "tcp-passive":
		protocol = "TCP/RTP/AVP"
		setup = "a=setup:passive\r\na=connection:new\r\n"
	case "tcp-active":
		protocol = "TCP/RTP/AVP"
		setup = "a=setup:active\r\na=connection:new\r\n"
	default:
		return nil, errors.New("invalid media mode")
	}
	return []byte(fmt.Sprintf("v=0\r\no=%s 0 0 IN IP4 %s\r\ns=Play\r\nu=%s:0\r\nc=IN IP4 %s\r\nt=0 0\r\nm=video %d %s 96\r\na=recvonly\r\na=rtpmap:96 PS/90000\r\n%sy=%010d\r\n", serverID, ip, channelID, ip, l.Port, protocol, setup, l.SSRC)), nil
}
