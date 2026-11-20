package gateway

import (
	"bufio"
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
)

const positionChannelID = "34020000001320000002"

func positionBody(sn, fields string) string {
	return "<Response><CmdType>PTZPosition</CmdType><SN>" + sn + "</SN><DeviceID>" + positionChannelID + "</DeviceID>" + fields + "</Response>"
}

func TestPositionOptionalNumbers(t *testing.T) {
	for _, profile := range []string{"2016", "2022"} {
		b, e := QueryXMLForProfile("PTZPosition", positionChannelID, 7, profile)
		if e != nil || !strings.Contains(string(b), "<Query><CmdType>PTZPosition</CmdType><SN>7</SN><DeviceID>"+positionChannelID+"</DeviceID></Query>") {
			t.Fatal(profile, e)
		}
	}
	for _, tc := range []struct{ fields, want string }{
		{"", "{}"}, {"<Pan>0</Pan>", "{\"pan\":0}"},
		{"<Tilt> -2.5 </Tilt><Zoom>1e1</Zoom><HorizontalFieldAngle>60</HorizontalFieldAngle><VerticalFieldAngle>30</VerticalFieldAngle><MaxViewDistance>20</MaxViewDistance>",
			"{\"tilt\":-2.5,\"zoom\":10,\"horizontalFieldAngle\":60,\"verticalFieldAngle\":30,\"maxViewDistance\":20}"},
	} {
		m, e := ParseBusinessMessage([]byte(positionBody("7", tc.fields)), 10)
		v, err := json.Marshal(m.Position)
		if e != nil || err != nil || string(v) != tc.want {
			t.Fatalf("%s: %s %v %v", tc.fields, v, e, err)
		}
	}
	for _, bad := range []string{"<Pan/>", "<Pan> </Pan>", "<Pan>0</Pan><Pan>1</Pan>", "<Zoom>NaN</Zoom>", "<Tilt>Inf</Tilt>", "<HorizontalFieldAngle>1e999</HorizontalFieldAngle>", "<Pan>1<a/>2</Pan>"} {
		if _, e := ParseBusinessMessage([]byte(positionBody("7", bad)), 10); e == nil {
			t.Fatal(bad)
		}
	}
}

func TestPositionResponseIdentity(t *testing.T) {
	st := &DeviceState{Generation: 3, source: "127.0.0.1:2001", transport: "UDP"}
	s := &Server{states: map[string]*DeviceState{sampleID: st}, positionQueries: map[string]*positionQuery{}}
	target := &gbPTZTarget{s, sampleID, positionChannelID, 3}
	s.config.HeartbeatTimeoutSec = 60
	st.Registered = true
	st.ExpiresAt = time.Now().Add(time.Minute)
	st.LastSeen = time.Now()
	st.Catalog = []CatalogItem{{ID: positionChannelID}}
	for i := 0; i < 4; i++ {
		s.positionQueries[strconv.Itoa(i)] = &positionQuery{}
	}
	if _, err := target.position(context.Background(), 2); err == nil || err.Error() != "ptz_query_busy" {
		t.Fatal("global bound", err)
	}
	q := &positionQuery{state: st, sn: "7", generation: 3, source: st.source, transport: st.transport, deadline: time.Now().Add(time.Second), done: make(chan positionReply, 1)}
	s.positionQueries[sampleID+"/"+positionChannelID] = q
	msg := BusinessMessage{Command: "PTZPosition", XMLName: xml.Name{Local: "Response"}, SN: "7", DeviceID: positionChannelID}
	accept := func(device string, m BusinessMessage, source, transport string) bool {
		return s.acceptPosition(device, st, m, source, transport)
	}
	if accept(positionChannelID, msg, st.source, st.transport) || accept(sampleID, msg, "wrong", st.transport) || accept(sampleID, msg, st.source, "TCP") {
		t.Fatal("wrong peer accepted")
	}
	bad := msg
	bad.SN = "8"
	if accept(sampleID, bad, st.source, st.transport) {
		t.Fatal("wrong SN")
	}
	bad = msg
	bad.DeviceID = sampleID
	if accept(sampleID, bad, st.source, st.transport) {
		t.Fatal("wrong channel")
	}
	bad = msg
	bad.XMLName.Local = "Notify"
	if accept(sampleID, bad, st.source, st.transport) {
		t.Fatal("notification")
	}
	st.Generation++
	if accept(sampleID, msg, st.source, st.transport) {
		t.Fatal("wrong generation")
	}
	st.Generation--
	s.states[sampleID] = &DeviceState{}
	if accept(sampleID, msg, st.source, st.transport) {
		t.Fatal("replaced peer")
	}
	s.states[sampleID] = st
	q.deadline = time.Now().Add(-time.Second)
	if accept(sampleID, msg, st.source, st.transport) {
		t.Fatal("late response")
	}
	q.deadline = time.Now().Add(time.Second)
	if !accept(sampleID, msg, st.source, st.transport) || accept(sampleID, msg, st.source, st.transport) {
		t.Fatal("first result or replay")
	}
}

// Simulate a device behind NAT: the gateway must use the open incoming TCP
// connection even with unconfirmed 2016 profile. Only loopback is involved.
func TestPositionHTTPRegisteredTCP(t *testing.T) {
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	addr := l.Addr().String()
	l.Close()
	s, e := NewServer(testConfig(addr))
	if e != nil {
		t.Fatal(e)
	}
	ready := make(chan struct{}, 2)
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), sipgo.ListenReadyCtxKey, sipgo.ListenReadyFuncCtxValue(func(string, string) { ready <- struct{}{} })))
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()
	defer func() { cancel(); <-done; s.Close() }()
	for i := 0; i < 2; i++ {
		select {
		case <-ready:
		case <-time.After(2 * time.Second):
			t.Fatal("listen timeout")
		}
	}
	conn, e := net.DialTimeout("tcp", addr, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	reader := bufio.NewReader(conn)
	read := func() sip.Message {
		t.Helper()
		conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		var b strings.Builder
		length := 0
		for {
			line, e := reader.ReadString('\n')
			if e != nil {
				t.Fatal(e)
			}
			b.WriteString(line)
			if strings.HasPrefix(strings.ToLower(line), "content-length:") {
				length, e = strconv.Atoi(strings.TrimSpace(strings.SplitN(line, ":", 2)[1]))
				if e != nil {
					t.Fatal(e)
				}
			}
			if line == "\r\n" {
				break
			}
		}
		body := make([]byte, length)
		if _, e := io.ReadFull(reader, body); e != nil {
			t.Fatal(e)
		}
		b.Write(body)
		m, e := sip.ParseMessage([]byte(b.String()))
		if e != nil {
			t.Fatal(e)
		}
		return m
	}
	seq := 0
	send := func(method, body string) {
		t.Helper()
		seq++
		_, e := fmt.Fprintf(conn, "%s sip:34020000002000000001@3402000000 SIP/2.0\r\nVia: SIP/2.0/TCP %s;branch=z9hG4bK-position-%d;rport\r\nFrom: <sip:%s@3402000000>;tag=fixture\r\nTo: <sip:34020000002000000001@3402000000>\r\nCall-ID: position-%d\r\nCSeq: %d %s\r\nContact: <sip:%s@%s>\r\nExpires: 3600\r\nContent-Type: Application/MANSCDP+xml\r\nContent-Length: %d\r\n\r\n%s", method, conn.LocalAddr(), seq, sampleID, seq, seq, method, sampleID, conn.LocalAddr(), len(body), body)
		if e != nil {
			t.Fatal(e)
		}
	}
	send("REGISTER", "")
	if read().(*sip.Response).StatusCode != 401 {
		t.Fatal("fixture handshake")
	}
	sc, e := s.ua.TransportLayer().GetConnection("tcp", conn.LocalAddr().String())
	if e != nil {
		t.Fatal(e)
	}
	sc.TryClose()
	s.mu.Lock()
	s.states[sampleID] = &DeviceState{ID: sampleID, Registered: true, Generation: 1, Version: Version{Profile: "2016"}, LastSeen: time.Now(), ExpiresAt: time.Now().Add(time.Hour), source: conn.LocalAddr().String(), transport: "TCP", connection: sc, Catalog: []CatalogItem{{ID: positionChannelID}}}
	s.mu.Unlock()
	rt := &Runtime{server: s, config: RuntimeConfig{Revision: 2, Bindings: []Binding{{ID: "b", DeviceID: sampleID, ChannelID: positionChannelID, Enabled: true}}}}
	manager := &Manager{runtime: rt}
	token := strings.Repeat("x", 32)
	handler := manager.Handler(ctx, token)
	post := func(c context.Context, path, auth, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/v1/ptz/"+path, strings.NewReader(body)).WithContext(c)
		r.Header.Set("X-Service-Token", auth)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	const payload = `{"binding":"b","revision":2,"generation":1}`
	prepare := func() {
		t.Helper()
		w := post(ctx, "prepare", token, `{"binding":"b"}`)
		var r struct{ Position *bool }
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &r) != nil || r.Position == nil || *r.Position {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if w := post(ctx, "position", "", payload); w.Code != 401 {
		t.Fatal("auth", w.Code)
	}
	if w := post(ctx, "position", token, `{"binding":"b","revision":1,"generation":1}`); w.Code != 409 {
		t.Fatal("revision", w.Code)
	}
	prepare()
	for _, tc := range []struct {
		fields   string
		expected bool
	}{{"<Pan>0</Pan><Tilt>-2</Tilt>", true}, {"<Zoom>3</Zoom>", false}, {"", false}} {
		result := make(chan *httptest.ResponseRecorder, 1)
		go func() { result <- post(ctx, "position", token, payload) }()
		req := read().(*sip.Request)
		if req.Method != sip.MESSAGE || req.Recipient.User != sampleID || !strings.Contains(string(req.Body()), "<Query><CmdType>PTZPosition</CmdType>") {
			t.Fatal("unexpected outbound request")
		}
		var query struct{ SN, DeviceID string }
		if xmlDecoder(req.Body()).Decode(&query) != nil || query.DeviceID != positionChannelID {
			t.Fatal("query target")
		}
		if w := post(ctx, "position", token, payload); w.Code != 429 {
			t.Fatal("simultaneous query", w.Code)
		}
		send("MESSAGE", positionBody(query.SN, tc.fields))
		if read().(*sip.Response).StatusCode != 200 {
			t.Fatal("asynchronous response rejected")
		}
		if _, e := io.WriteString(conn, sip.NewResponseFromRequest(req, 200, "OK", nil).String()); e != nil {
			t.Fatal(e)
		}
		w := <-result
		var r positionReading
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &r) != nil || r.Position != tc.expected || r.SN != query.SN || r.Channel != positionChannelID || r.Device != sampleID || r.ObservedAtMs <= 0 {
			t.Fatal(w.Code, w.Body.String())
		}
		if tc.expected && (r.Pan == nil || *r.Pan != 0 || r.Tilt == nil || *r.Tilt != -2) {
			t.Fatal(w.Body.String())
		}
		if !tc.expected && r.Pan != nil {
			t.Fatal("missing pan became zero")
		}
		prepare()
	}
	c, stop := context.WithCancel(ctx)
	defer stop()
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- post(c, "position", token, payload) }()
	req := read().(*sip.Request)
	io.WriteString(conn, sip.NewResponseFromRequest(req, 200, "OK", nil).String())
	select {
	case <-result:
		t.Fatal("transport ACK counted as position")
	case <-time.After(25 * time.Millisecond):
	}
	stop()
	if w := <-result; w.Code != 504 {
		t.Fatal(w.Code, w.Body.String())
	}
	s.mu.Lock()
	n := len(s.positionQueries)
	s.mu.Unlock()
	if n != 0 {
		t.Fatal("query leaked")
	}
	// A silent device must release admission without any caller-side deadline.
	go func() { result <- post(ctx, "position", token, payload) }()
	req = read().(*sip.Request)
	io.WriteString(conn, sip.NewResponseFromRequest(req, 200, "OK", nil).String())
	select {
	case w := <-result:
		if w.Code != 504 {
			t.Fatal(w.Code, w.Body.String())
		}
	case <-time.After(4 * time.Second):
		t.Fatal("no gateway deadline")
	}
	// An in-place configuration revision change fences an already-sent query.
	go func() { result <- post(ctx, "position", token, payload) }()
	req = read().(*sip.Request)
	var query struct{ SN string }
	if xmlDecoder(req.Body()).Decode(&query) != nil {
		t.Fatal("query")
	}
	rt.mu.Lock()
	rt.config.Revision++
	rt.mu.Unlock()
	send("MESSAGE", positionBody(query.SN, "<Pan>0</Pan><Tilt>0</Tilt>"))
	if read().(*sip.Response).StatusCode != 200 {
		t.Fatal("business response")
	}
	io.WriteString(conn, sip.NewResponseFromRequest(req, 200, "OK", nil).String())
	if w := <-result; w.Code != 409 {
		t.Fatal("stale revision accepted", w.Code, w.Body.String())
	}
	prepare()
}
