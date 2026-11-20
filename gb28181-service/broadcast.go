package gateway

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/bits"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
)

// One audio sender per gateway. The input is 200ms of S16LE mono/8000.
type broadcast struct {
	binding                                   string
	id, device, target, source, transport, sn string
	registration                              *DeviceState
	generation                                uint64
	result                                    chan bool
	ready                                     chan struct{}
	done                                      chan struct{}
	dialog                                    *sipgo.DialogServerSession
	socket                                    *net.UDPConn
	peer                                      *net.UDPAddr
	pt                                        byte
	seq                                       uint16
	stamp, ssrc                               uint32
	writing                                   bool
	until                                     time.Time
}

func (s *Server) finishBroadcast(b *broadcast, bye bool) {
	s.mu.Lock()
	if b == nil || s.broadcast != b {
		s.mu.Unlock()
		return
	}
	s.broadcast = nil
	close(b.done)
	sock, dialog := b.socket, b.dialog
	s.mu.Unlock()
	if sock != nil {
		sock.Close()
	}
	if dialog != nil && bye {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_ = dialog.Bye(ctx)
			_ = dialog.Close()
		}()
	}
}

// Caller holds s.mu. Registration identity can change between watchdog ticks.
func (s *Server) broadcastCurrent(b *broadcast, now time.Time) bool {
	if b == nil || s.broadcast != b || s.broadcastClosed || !now.Before(b.until) {
		return false
	}
	st := s.states[b.device]
	return st != nil && st == b.registration && st.Generation == b.generation &&
		st.source == b.source && st.transport == b.transport && s.online(st, now)
}

func (s *Server) startBroadcast(ctx context.Context, binding Binding) (*broadcast, error) {
	raw := make([]byte, 22)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	s.mu.Lock()
	st := s.states[binding.DeviceID]
	if s.broadcastClosed || !s.online(st, time.Now()) || s.broadcast != nil {
		s.mu.Unlock()
		return nil, errors.New("设备离线或正在喊话")
	}
	b := &broadcast{binding: binding.ID, id: hex.EncodeToString(raw[:16]), device: binding.DeviceID, target: binding.ChannelID, source: st.source, transport: st.transport, registration: st, generation: st.Generation, sn: strconv.FormatUint(uint64(s.sequence.Add(1)), 10), seq: binary.BigEndian.Uint16(raw[16:]), stamp: binary.BigEndian.Uint32(raw[18:]), result: make(chan bool, 1), ready: make(chan struct{}), done: make(chan struct{}), until: time.Now().Add(14 * time.Second)}
	s.broadcast = b
	serverID := s.config.ServerID
	s.mu.Unlock()
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-b.done:
				return
			case <-ticker.C:
				s.mu.Lock()
				expired := !s.broadcastCurrent(b, time.Now())
				s.mu.Unlock()
				if expired {
					s.finishBroadcast(b, true)
					return
				}
			}
		}
	}()
	body := []byte(fmt.Sprintf("<?xml version=\"1.0\"?>\r\n<Notify><CmdType>Broadcast</CmdType><SN>%s</SN><SourceID>%s</SourceID><TargetID>%s</TargetID></Notify>", b.sn, serverID, b.target))
	req := s.request(sip.MESSAGE, b.device, b.source, b.transport, body, "Application/MANSCDP+xml")
	ctx, cancel := context.WithTimeout(ctx, 11*time.Second)
	defer cancel()
	res, err := s.client.Do(ctx, req)
	if err != nil || res.StatusCode != 200 {
		s.finishBroadcast(b, true)
		return nil, errors.New("设备未接受广播通知")
	}
	ready, result := b.ready, b.result
	for ready != nil || result != nil {
		select {
		case <-ctx.Done():
			s.finishBroadcast(b, true)
			return nil, errors.New("设备未完成广播协商")
		case <-b.done:
			return nil, errors.New("设备结束了广播")
		case ok := <-result:
			if !ok {
				s.finishBroadcast(b, true)
				return nil, errors.New("设备拒绝广播")
			}
			result = nil
		case <-ready:
			ready = nil
		}
	}
	s.mu.Lock()
	current := s.broadcastCurrent(b, time.Now())
	s.mu.Unlock()
	if !current {
		s.finishBroadcast(b, true)
		return nil, errors.New("广播注册已变化")
	}
	return b, nil
}

// Accept a single UDP audio offer from the registered peer or provisioned media IP.
func audioOffer(body []byte, allowed []string) (*net.UDPAddr, byte, uint32, error) {
	bad := errors.New("unsupported audio SDP")
	if len(body) > 8192 {
		return nil, 0, 0, bad
	}
	var address string
	var port int
	pt := -1
	var ssrc uint64
	media := 0
	for _, line := range strings.Split(string(body), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "c="):
			f := strings.Fields(line)
			if len(f) != 3 || f[0] != "c=IN" || f[1] != "IP4" {
				return nil, 0, 0, bad
			}
			address = f[2]
		case strings.HasPrefix(line, "m="):
			media++
			f := strings.Fields(line)
			if media != 1 || len(f) < 4 || f[0] != "m=audio" || f[2] != "RTP/AVP" {
				return nil, 0, 0, bad
			}
			port, _ = strconv.Atoi(f[1])
			for _, v := range f[3:] {
				if v == "8" || v == "0" {
					pt, _ = strconv.Atoi(v)
					break
				}
			}
		case strings.HasPrefix(line, "y="):
			v, err := strconv.ParseUint(line[2:], 10, 32)
			if err != nil {
				return nil, 0, 0, bad
			}
			ssrc = v
		}
	}
	ip := net.ParseIP(address)
	if ip == nil || ip.To4() == nil || port < 1024 || port > 65535 || pt < 0 {
		return nil, 0, 0, bad
	}
	for _, a := range allowed {
		if ip.Equal(net.ParseIP(a)) {
			return &net.UDPAddr{IP: ip, Port: port}, byte(pt), uint32(ssrc), nil
		}
	}
	return nil, 0, 0, bad
}

func (s *Server) broadcastInvite(req *sip.Request, tx sip.ServerTransaction) {
	s.mu.Lock()
	b := s.broadcast
	if !s.broadcastCurrent(b, time.Now()) || req.Source() != b.source || req.Transport() != b.transport || req.Recipient.User != s.config.ServerID || b.dialog != nil || req.From() == nil || (req.From().Address.User != b.device && req.From().Address.User != b.target) {
		s.mu.Unlock()
		s.respond(req, tx, 481, "No Broadcast")
		return
	}
	host, _, _ := net.SplitHostPort(b.source)
	allowed := append([]string{host}, s.devices[b.device].MediaIPs...)
	peer, pt, ssrc, err := audioOffer(req.Body(), allowed)
	contact := req.Contact()
	if err != nil || contact == nil || !net.ParseIP(contact.Address.Host).Equal(net.ParseIP(host)) || req.GetHeader("Record-Route") != nil {
		s.mu.Unlock()
		s.respond(req, tx, 488, "Unsupported Audio Offer")
		return
	}
	sock, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP(s.config.AdvertiseIP)})
	if err != nil {
		s.mu.Unlock()
		s.respond(req, tx, 503, "Media Unavailable")
		return
	}
	dialog, err := s.audioDialogs[b.transport].ReadInvite(req, tx)
	if err != nil {
		sock.Close()
		s.mu.Unlock()
		s.respond(req, tx, 400, "Bad Invite")
		return
	}
	if ssrc == 0 {
		ssrc = 100000000 + uint32(b.seq)
	}
	b.dialog, b.socket, b.peer, b.pt, b.ssrc = dialog, sock, peer, pt, ssrc
	ip := s.config.AdvertiseIP
	codec := "PCMA"
	if pt == 0 {
		codec = "PCMU"
	}
	answer := fmt.Sprintf("v=0\r\no=%s 0 0 IN IP4 %s\r\ns=Play\r\nc=IN IP4 %s\r\nt=0 0\r\nm=audio %d RTP/AVP %d\r\na=sendonly\r\na=rtpmap:%d %s/8000\r\ny=%010d\r\nf=v////a/1/8/1\r\n", s.config.ServerID, ip, ip, sock.LocalAddr().(*net.UDPAddr).Port, pt, pt, codec, ssrc)
	s.mu.Unlock()
	if err := dialog.RespondSDP([]byte(answer)); err != nil {
		s.finishBroadcast(b, false)
		dialog.Close()
	}
}

func (s *Server) broadcastDialog(req *sip.Request, tx sip.ServerTransaction, ack bool) bool {
	s.mu.Lock()
	b := s.broadcast
	if !s.broadcastCurrent(b, time.Now()) || b.dialog == nil || req.Source() != b.source || req.Transport() != b.transport {
		s.mu.Unlock()
		return false
	}
	cache := s.audioDialogs[b.transport]
	d, err := cache.MatchDialogRequest(req)
	if err != nil || d != b.dialog {
		s.mu.Unlock()
		return false
	}
	s.mu.Unlock()
	if ack {
		if d.ReadAck(req, tx) == nil {
			s.mu.Lock()
			select {
			case <-b.ready:
			default:
				close(b.ready)
			}
			s.mu.Unlock()
		}
	} else {
		_ = d.ReadBye(req, tx)
		s.finishBroadcast(b, false)
	}
	return true
}

func encodeG711(v int16, pt byte) byte {
	x := int(v)
	if pt == 8 {
		mask := 0xd5
		if x < 0 {
			mask = 0x55
			x = -x - 1
		}
		e := bits.Len(uint(x >> 8))
		mantissa := x >> 4
		if e > 0 {
			mantissa = x >> (e + 3)
		}
		return byte((e<<4)|(mantissa&15)) ^ byte(mask)
	}
	mask := 0xff
	if x < 0 {
		mask = 0x7f
		x = -x
	}
	x = min(x, 32635) + 132
	e := bits.Len(uint(x >> 8))
	return byte((e<<4)|((x>>(e+3))&15)) ^ byte(mask)
}

func (s *Server) sendAudio(ctx context.Context, b *broadcast, pcm []byte) error {
	s.mu.Lock()
	if !s.broadcastCurrent(b, time.Now()) || b.writing || b.socket == nil || len(pcm) != 3200 {
		s.mu.Unlock()
		return errors.New("inactive audio")
	}
	select {
	case <-b.ready:
	default:
		s.mu.Unlock()
		return errors.New("audio dialog not ready")
	}
	b.writing = true
	b.until = time.Now().Add(5 * time.Second)
	s.mu.Unlock()
	defer func() { s.mu.Lock(); b.writing = false; s.mu.Unlock() }()
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	var pkt [172]byte
	pkt[0] = 128
	pkt[1] = b.pt
	for pos := 0; pos < len(pcm); pos += 320 {
		if pos > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-b.done:
				return errors.New("closed")
			case <-tick.C:
			}
		}
		binary.BigEndian.PutUint16(pkt[2:], b.seq)
		binary.BigEndian.PutUint32(pkt[4:], b.stamp)
		binary.BigEndian.PutUint32(pkt[8:], b.ssrc)
		for i := 0; i < 160; i++ {
			pkt[12+i] = encodeG711(int16(binary.LittleEndian.Uint16(pcm[pos+i*2:])), b.pt)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		s.mu.Lock()
		if !s.broadcastCurrent(b, time.Now()) {
			s.mu.Unlock()
			return errors.New("audio session changed")
		}
		s.mu.Unlock()
		if _, err := b.socket.WriteToUDP(pkt[:], b.peer); err != nil {
			return err
		}
		b.seq++
		b.stamp += 160
	}
	return nil
}

func (m *Manager) broadcastHTTP(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	rt := m.runtime
	m.mu.Unlock()
	if rt == nil || rt.server == nil {
		http.Error(w, "offline", 503)
		return
	}
	s := rt.server
	var in struct {
		Binding string
		Session string
		PCM     []byte
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 5000))
	d.DisallowUnknownFields()
	if d.Decode(&in) != nil || d.Decode(new(any)) != io.EOF {
		http.Error(w, "invalid", 400)
		return
	}
	switch r.URL.Path {
	case "/v1/broadcast/start":
		rt.mu.Lock()
		var binding Binding
		for _, v := range rt.config.Bindings {
			if v.Enabled && v.ID == in.Binding {
				binding = v
				break
			}
		}
		rt.mu.Unlock()
		if binding.ID == "" {
			http.Error(w, "binding unavailable", 409)
			return
		}
		b, err := s.startBroadcast(r.Context(), binding)
		if err != nil {
			http.Error(w, err.Error(), 422)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"session": b.id})
	case "/v1/broadcast/audio", "/v1/broadcast/stop":
		s.mu.Lock()
		b := s.broadcast
		s.mu.Unlock()
		if b == nil || b.id != in.Session {
			http.Error(w, "expired", 410)
			return
		}
		if r.URL.Path == "/v1/broadcast/audio" {
			rt.mu.Lock()
			valid := false
			for _, binding := range rt.config.Bindings {
				if binding.ID == b.binding && binding.Enabled && binding.DeviceID == b.device && binding.ChannelID == b.target {
					valid = true
					break
				}
			}
			rt.mu.Unlock()
			if !valid {
				s.finishBroadcast(b, true)
				http.Error(w, "binding changed", 409)
				return
			}
		}
		if r.URL.Path == "/v1/broadcast/stop" {
			s.finishBroadcast(b, true)
		} else if s.sendAudio(r.Context(), b, in.PCM) != nil {
			http.Error(w, "send failed", 409)
			return
		}
		io.WriteString(w, "{}")
	default:
		http.NotFound(w, r)
	}
}
