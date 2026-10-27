package gateway

import (
	"bufio"
	"context"
	"crypto/md5"
	"fmt"
	"io"
	"net"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/emiago/sipgo"
)

func testConfig(listen string) Config {
	return Config{ServerID: "34020000002000000001", Realm: "3402000000", Listen: listen, AdvertiseIP: "127.0.0.1", MaxDevices: 4, MaxCatalogItems: 100, HeartbeatTimeoutSec: 60, Devices: []DeviceConfig{{ID: sampleID, Password: "fixture-password", Version: "auto", Enabled: true}}}
}

// Independent socket peer: no sipgo parser, transaction or digest generator is
// used on the simulated device side. This tests real UDP and TCP framing.
func TestWireRegistrationAndHeartbeat(t *testing.T) {
	for _, network := range []string{"udp", "tcp"} {
		for _, version := range []string{"2.0", "3.0"} {
			t.Run(network+"/"+version, func(t *testing.T) {
				probe, e := net.Listen("tcp", "127.0.0.1:0")
				if e != nil {
					t.Fatal(e)
				}
				addr := probe.Addr().String()
				probe.Close()
				config := testConfig(addr)
				config.MaxCatalogItems = 256
				s, e := NewServer(config)
				if e != nil {
					t.Fatal(e)
				}
				defer s.Close()
				ready := make(chan struct{}, 2)
				ctx, cancel := context.WithCancel(context.WithValue(context.Background(), sipgo.ListenReadyCtxKey, sipgo.ListenReadyFuncCtxValue(func(string, string) { ready <- struct{}{} })))
				defer cancel()
				done := make(chan error, 1)
				go func() { done <- s.Run(ctx) }()
				for i := 0; i < 2; i++ {
					select {
					case <-ready:
					case e := <-done:
						t.Fatalf("listener: %v", e)
					case <-time.After(3 * time.Second):
						t.Fatal("listen timeout")
					}
				}
				conn, e := net.Dial(network, addr)
				if e != nil {
					t.Fatal(e)
				}
				defer conn.Close()
				reader := bufio.NewReader(conn)
				exchange := func(request string) string {
					t.Helper()
					conn.SetDeadline(time.Now().Add(2 * time.Second))
					if _, e := conn.Write([]byte(request)); e != nil {
						t.Fatal(e)
					}
					if network == "udp" {
						b := make([]byte, 65536)
						n, e := conn.Read(b)
						if e != nil {
							t.Fatal(e)
						}
						return string(b[:n])
					}
					var out strings.Builder
					length := 0
					for {
						line, e := reader.ReadString('\n')
						if e != nil {
							t.Fatal(e)
						}
						out.WriteString(line)
						if strings.HasPrefix(strings.ToLower(line), "content-length:") {
							length, _ = strconv.Atoi(strings.TrimSpace(strings.SplitN(line, ":", 2)[1]))
						}
						if line == "\r\n" {
							break
						}
					}
					b := make([]byte, length)
					if _, e := io.ReadFull(reader, b); e != nil {
						t.Fatal(e)
					}
					out.Write(b)
					return out.String()
				}
				uri := "sip:34020000002000000001@3402000000"
				request := func(method string, seq int, auth, body string) string {
					return fmt.Sprintf("%s %s SIP/2.0\r\nVia: SIP/2.0/%s %s;branch=z9hG4bK-fixture-%d;rport\r\nFrom: <sip:%s@3402000000>;tag=device-test\r\nTo: <%s>\r\nCall-ID: wire-fixture-%s-%s\r\nCSeq: %d %s\r\nMax-Forwards: 70\r\nContact: <sip:%s@%s>\r\nExpires: 3600\r\nX-GB-Ver: %s\r\n%sContent-Type: Application/MANSCDP+xml\r\nContent-Length: %d\r\n\r\n%s", method, uri, strings.ToUpper(network), conn.LocalAddr(), seq, sampleID, uri, network, version, seq, method, sampleID, conn.LocalAddr(), version, auth, len(body), body)
				}
				// GB/T 28181 9.1.1: minimum one hour; RFC 3261 423
				// tells a short-lease peer exactly which value to retry.
				for i, expiry := range []string{"1", "60", "3599"} {
					short := strings.Replace(request("REGISTER", 100+i, "", ""), "Expires: 3600", "Expires: "+expiry, 1)
					reply := exchange(short)
					if !strings.HasPrefix(reply, "SIP/2.0 423") || !strings.Contains(strings.ToLower(reply), "min-expires: 3600") {
						t.Fatalf("short registration accepted: %s", reply)
					}
				}
				r := exchange(request("REGISTER", 1, "", ""))
				if !strings.HasPrefix(r, "SIP/2.0 401 ") {
					t.Fatalf("expected challenge: %s", r)
				}
				match := regexp.MustCompile(`nonce="([a-f0-9]+)"`).FindStringSubmatch(r)
				if len(match) != 2 {
					t.Fatal("missing nonce")
				}
				nonce := match[1]
				hash := func(v string) string { return fmt.Sprintf("%x", md5.Sum([]byte(v))) }
				digest := hash(hash(sampleID+":3402000000:fixture-password") + ":" + nonce + ":00000001:fixed-client:auth:" + hash("REGISTER:"+uri))
				auth := fmt.Sprintf("Authorization: Digest username=\"%s\", realm=\"3402000000\", nonce=\"%s\", uri=\"%s\", response=\"%s\", algorithm=MD5, qop=auth, nc=00000001, cnonce=\"fixed-client\"\r\n", sampleID, nonce, uri, digest)
				r = exchange(request("REGISTER", 2, auth, ""))
				if !strings.HasPrefix(r, "SIP/2.0 200 ") {
					t.Fatalf("register failed: %s", r)
				}
				states := s.Snapshot()
				if len(states) != 1 || !states[0].Registered || !states[0].Version.Confirmed {
					t.Fatalf("wrong state: %+v", states)
				}
				r = exchange(request("REGISTER", 3, auth, ""))
				if !strings.HasPrefix(r, "SIP/2.0 403 ") {
					t.Fatal("authentication replay was accepted")
				}
				body := `<Notify><CmdType>Keepalive</CmdType><SN>4</SN><DeviceID>34020000001320000001</DeviceID><Status>OK</Status></Notify>`
				r = exchange(request("MESSAGE", 4, "", body))
				if !strings.HasPrefix(r, "SIP/2.0 200 ") {
					t.Fatalf("heartbeat failed: %s", r)
				}
				r = exchange(request("MESSAGE", 40, "", strings.Replace(body, "<Status>OK", "<Status>ERROR", 1)))
				if !strings.HasPrefix(r, "SIP/2.0 200 ") || !s.Snapshot()[0].Registered || s.Snapshot()[0].LastError != "device_reported_error" {
					t.Fatal("live device fault was rejected or hidden")
				}
				r = exchange(request("MESSAGE", 41, "", body))
				if !strings.HasPrefix(r, "SIP/2.0 200 ") || s.Snapshot()[0].LastError != "" {
					t.Fatal("device recovery not observed")
				}
				info := `<Response><CmdType>DeviceInfo</CmdType><SN>50</SN><DeviceID>34020000001320000001</DeviceID><Result>OK</Result><DeviceName>Camera</DeviceName><Manufacturer>Independent</Manufacturer><Model>Fixture</Model><Firmware>1</Firmware></Response>`
				r = exchange(request("MESSAGE", 5, "", info))
				if !strings.HasPrefix(r, "SIP/2.0 400 ") {
					t.Fatal("unsolicited device info accepted")
				}
				s.mu.Lock()
				s.states[sampleID].pending = map[string]pendingQuery{"DeviceInfo": {"50", time.Now().Add(time.Second)}, "DeviceStatus": {"51", time.Now().Add(time.Second)}}
				s.mu.Unlock()
				r = exchange(request("MESSAGE", 6, "", info))
				if !strings.HasPrefix(r, "SIP/2.0 200 ") || s.Snapshot()[0].Info.Manufacturer != "Independent" {
					t.Fatal("device info rejected")
				}
				status := `<Response><CmdType>DeviceStatus</CmdType><SN>51</SN><DeviceID>34020000001320000001</DeviceID><Result>OK</Result><Online>ONLINE</Online><Status>OK</Status></Response>`
				r = exchange(request("MESSAGE", 7, "", status))
				if !strings.HasPrefix(r, "SIP/2.0 200 ") || s.Snapshot()[0].DeviceOnline != "ONLINE" {
					t.Fatal("device status rejected")
				}
				s.mu.Lock()
				s.states[sampleID].pending["DeviceStatus"] = pendingQuery{"51", time.Now().Add(time.Minute)}
				s.mu.Unlock()
				r = exchange(request("MESSAGE", 80, "", strings.Replace(status, "<Status>OK", "<Status>UNKNOWN", 1)))
				if !strings.HasPrefix(r, "SIP/2.0 400 ") {
					t.Fatal("invalid DeviceStatus working state accepted")
				}
				r = exchange(request("MESSAGE", 81, "", strings.Replace(status, "<Status>OK", "<Status>ERROR", 1)))
				if !strings.HasPrefix(r, "SIP/2.0 200 ") || s.Snapshot()[0].LastError != "device_reported_error" || !s.Snapshot()[0].Registered {
					t.Fatal("registered device self-check failure was hidden")
				}
				r = exchange(request("MESSAGE", 82, "", body))
				if !strings.HasPrefix(r, "SIP/2.0 200 ") || s.Snapshot()[0].LastError != "device_reported_error" {
					t.Fatal("healthy heartbeat cleared a separate device self-check fault")
				}
				r = exchange(request("MESSAGE", 83, "", status))
				if !strings.HasPrefix(r, "SIP/2.0 200 ") || s.Snapshot()[0].LastError != "" {
					t.Fatal("healthy device self-check did not clear its fault")
				}
				r = exchange(request("MESSAGE", 84, "", strings.Replace(body, "<Status>OK", "<Status>ERROR", 1)))
				if !strings.HasPrefix(r, "SIP/2.0 200 ") {
					t.Fatal("fault heartbeat rejected")
				}
				r = exchange(request("MESSAGE", 85, "", status))
				if !strings.HasPrefix(r, "SIP/2.0 200 ") || s.Snapshot()[0].LastError != "device_reported_error" {
					t.Fatal("device status cleared a separate heartbeat fault")
				}
				r = exchange(request("MESSAGE", 86, "", body))
				if !strings.HasPrefix(r, "SIP/2.0 200 ") || s.Snapshot()[0].LastError != "" {
					t.Fatal("heartbeat fault did not recover")
				}
				// Exercise admission on actual UDP/TCP requests for both versions.
				// Synthetic accounting fills the other-device cache without a
				// large allocation; the original directory must survive rejection.
				s.mu.Lock()
				previous := CatalogItem{ID: "34020000001320000002", Name: "previous", Status: "ON"}
				st := s.states[sampleID]
				st.Catalog = []CatalogItem{previous}
				st.catalogBytes = catalogSliceBytes(st.Catalog)
				st.query = NewCatalog("53", time.Now().Add(5*time.Second), 100)
				s.states["capacity-fixture"] = &DeviceState{ID: "capacity-fixture", catalogBytes: catalogCacheBudget}
				s.mu.Unlock()
				batch := strings.ReplaceAll(catalogFixture, "<SN>12</SN>", "<SN>53</SN>")
				batch = strings.ReplaceAll(batch, "<SumNum>2</SumNum>", "<SumNum>1</SumNum>")
				r = exchange(request("MESSAGE", 65, "", batch))
				if !strings.HasPrefix(r, "SIP/2.0 503 ") || !strings.Contains(r, "X-GB-Ver: 3.0") {
					t.Fatalf("global directory budget not reported: %s", r)
				}
				s.mu.Lock()
				preserved := len(st.Catalog) == 1 && st.Catalog[0] == previous && st.query == nil && st.LastError == "catalog_capacity_exceeded"
				delete(s.states, "capacity-fixture")
				st.query = NewCatalog("53", time.Now().Add(5*time.Second), 100)
				s.mu.Unlock()
				if !preserved {
					t.Fatal("over-budget response lost prior directory or retained partial work")
				}
				r = exchange(request("MESSAGE", 66, "", batch))
				if !strings.HasPrefix(r, "SIP/2.0 200 ") || s.Snapshot()[0].LastError != "" || len(s.Snapshot()[0].Catalog) != 1 || s.Snapshot()[0].Catalog[0].Name != "入口" {
					t.Fatal("directory did not recover after capacity was released")
				}
				if network == "tcp" {
					s.mu.Lock()
					s.states[sampleID].query = NewCatalog("52", time.Now().Add(5*time.Second), config.MaxCatalogItems)
					s.mu.Unlock()
					var items strings.Builder
					for i := 0; i < 160; i++ {
						fmt.Fprintf(&items, "<Item><DeviceID>3402000000132%07d</DeviceID><Name>%s</Name><Status>ON</Status></Item>", i, strings.Repeat("N", 450))
					}
					catalog := fmt.Sprintf("<Response><CmdType>Catalog</CmdType><SN>52</SN><DeviceID>%s</DeviceID><SumNum>160</SumNum><DeviceList Num=\"160\">%s</DeviceList></Response>", sampleID, items.String())
					if len(catalog) <= 65535 || len(catalog) >= MaxXMLBytes {
						t.Fatal("wrong large-wire fixture size")
					}
					r = exchange(request("MESSAGE", 70, "", catalog))
					if !strings.HasPrefix(r, "SIP/2.0 200 ") || len(s.Snapshot()[0].Catalog) != 160 {
						t.Fatal("bounded TCP directory above 64 KiB rejected")
					}
				}
				// A reboot creates a new local port, but must authenticate afresh.
				oldConn := conn
				if network == "tcp" {
					_ = oldConn.Close()
					deadline := time.Now().Add(time.Second)
					for s.Snapshot()[0].Registered && time.Now().Before(deadline) {
						time.Sleep(5 * time.Millisecond)
					}
					if s.Snapshot()[0].Registered {
						t.Fatal("closed TCP registration remained online")
					}
				}
				oldGeneration := s.Snapshot()[0].Generation
				conn, e = net.Dial(network, addr)
				if e != nil {
					t.Fatal(e)
				}
				defer conn.Close()
				reader = bufio.NewReader(conn)
				r = exchange(request("REGISTER", 8, "", ""))
				if !strings.HasPrefix(r, "SIP/2.0 401 ") {
					t.Fatal("new endpoint must authenticate")
				}
				match = regexp.MustCompile(`nonce="([a-f0-9]+)"`).FindStringSubmatch(r)
				if len(match) != 2 {
					t.Fatal("missing rebind nonce")
				}
				nonce = match[1]
				digest = hash(hash(sampleID+":3402000000:fixture-password") + ":" + nonce + ":00000001:fixed-client:auth:" + hash("REGISTER:"+uri))
				auth = fmt.Sprintf("Authorization: Digest username=\"%s\", realm=\"3402000000\", nonce=\"%s\", uri=\"%s\", response=\"%s\", algorithm=MD5, qop=auth, nc=00000001, cnonce=\"fixed-client\"\r\n", sampleID, nonce, uri, digest)
				r = exchange(request("REGISTER", 9, auth, ""))
				if !strings.HasPrefix(r, "SIP/2.0 200 ") || s.Snapshot()[0].Generation <= oldGeneration {
					t.Fatal("authenticated port rebind failed")
				}
				if network == "udp" {
					conn = oldConn
					reader = bufio.NewReader(conn)
					r = exchange(request("MESSAGE", 10, "", body))
					if !strings.HasPrefix(r, "SIP/2.0 403 ") {
						t.Fatal("obsolete endpoint kept authority")
					}
				}
				cancel()
				select {
				case <-done:
				case <-time.After(3 * time.Second):
					t.Fatal("server did not stop")
				}
			})
		}
	}
}
