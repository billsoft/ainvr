package gateway

import (
	"ainvr/ptzcontrol"
	"bufio"
	"context"
	"fmt"
	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	"io"
	"math"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/text/encoding/simplifiedchinese"
)

func TestPTZCodesAgainstAnnexBytes(t *testing.T) {
	for _, tc := range []struct {
		v    ptzcontrol.Vector
		wire string
	}{
		{ptzcontrol.Vector{}, "A50F0000000000B4"},
		{ptzcontrol.Vector{Pan: 1}, "A50F0001FF0000B4"},
		{ptzcontrol.Vector{Pan: -.5}, "A50F000280000036"},
		{ptzcontrol.Vector{Tilt: 1}, "A50F000800FF00BB"},
		{ptzcontrol.Vector{Zoom: 1}, "A50F00100000F0B4"},
		{ptzcontrol.Vector{Pan: .5, Tilt: -.5, Zoom: -.5}, "A50F002580808059"},
	} {
		got, e := PTZCode(tc.v)
		if e != nil || got != tc.wire {
			t.Fatalf("%+v got %s expected %s %v", tc.v, got, tc.wire, e)
		}
	}
	for _, v := range []ptzcontrol.Vector{{Pan: 2}, {Zoom: math.NaN()}, {Tilt: math.Inf(1)}} {
		if _, e := PTZCode(v); e == nil {
			t.Fatal("invalid vector accepted")
		}
	}
}
func TestPresetCodesAndVersionedXML(t *testing.T) {
	for action, want := range map[string]string{"save": "A50F008100010036", "goto": "A50F008200010037", "remove": "A50F008300010038"} {
		code, e := PresetCode(action, 1)
		if e != nil || code != want {
			t.Fatal(action, code, e)
		}
		for _, version := range []string{"2016", "2022"} {
			raw, e := ControlXML(sampleID, 42, version, code, "前门 <主入口>")
			if e != nil {
				t.Fatal(e)
			}
			text := string(raw)
			if version == "2022" {
				decoded, e := simplifiedchinese.GB18030.NewDecoder().Bytes(raw)
				if e != nil {
					t.Fatal(e)
				}
				text = string(decoded)
				if !strings.Contains(text, "<PTZCmdParams><PresetName>前门 &lt;主入口&gt;</PresetName>") {
					t.Fatal(text)
				}
			} else if strings.Contains(text, "PTZCmdParams") {
				t.Fatal("2022 extension sent to 2016")
			}
			if !strings.Contains(text, "<DeviceID>"+sampleID+"</DeviceID>") || !strings.Contains(text, "<CmdType>DeviceControl</CmdType>") {
				t.Fatal(text)
			}
		}
	}
	for _, n := range []int{0, 256, -1} {
		if _, e := PresetCode("goto", n); e == nil {
			t.Fatal("invalid preset accepted")
		}
	}
	if _, e := ControlXML(sampleID, 1, "2022", "A50F000000000000", ""); e == nil {
		t.Fatal("bad checksum")
	}
}
func TestPresetResponsesAreCorrelatedAndVersioned(t *testing.T) {
	for _, version := range []string{"2016", "2022"} {
		body := `<Response><CmdType>PresetQuery</CmdType><SN>42</SN><DeviceID>` + sampleID + `</DeviceID>`
		if version == "2022" {
			body += `<SumNum>1</SumNum>`
		}
		body += `<PresetList Num="1"><Item><PresetID>1</PresetID><PresetName>Gate</PresetName></Item></PresetList></Response>`
		m, e := ParseBusinessMessage([]byte(body), 100)
		if e != nil {
			t.Fatal(e)
		}
		q := &presetQuery{sn: "42", generation: 3, expires: time.Now().Add(time.Second), total: -1, items: map[string]PTZPreset{}, done: make(chan []PTZPreset, 1)}
		s := &Server{presetQueries: map[string]*presetQuery{sampleID + "/" + sampleID: q}}
		st := &DeviceState{Generation: 3, Version: Version{Profile: version}}
		if e = s.acceptPresets(sampleID, st, m); e != nil {
			t.Fatal(e)
		}
		select {
		case items := <-q.done:
			if len(items) != 1 || items[0].ID != "1" {
				t.Fatal(items)
			}
		default:
			t.Fatal("query never completed")
		}
		st.Generation = 4
		if e = s.acceptPresets(sampleID, st, m); e == nil {
			t.Fatal("late response crossed registration")
		}
	}
	for _, body := range []string{
		`<Response><CmdType>PresetQuery</CmdType><SN>1</SN><DeviceID>` + sampleID + `</DeviceID><PresetList><Item><PresetID>1</PresetID></Item></PresetList></Response>`,
		`<Response><CmdType>PresetQuery</CmdType><SN>1</SN><DeviceID>` + sampleID + `</DeviceID><PresetList Num="0"/><PresetList Num="0"/></Response>`,
	} {
		if _, e := ParseBusinessMessage([]byte(body), 100); e == nil {
			t.Fatal("invalid list accepted")
		}
	}
}

func TestPTZSocketDeliveryAndIndependentWatchdog(t *testing.T) {
	for _, network := range []string{"udp", "tcp"} {
		for _, version := range []string{"2016", "2022"} {
			t.Run(network+"/"+version, func(t *testing.T) {
				var peer net.PacketConn
				var tcpPeer net.Conn
				var err error
				var address string
				if network == "udp" {
					peer, err = net.ListenPacket("udp", "127.0.0.1:0")
					if err == nil {
						address = peer.LocalAddr().String()
						defer peer.Close()
					}
				}
				if err != nil {
					t.Fatal(err)
				}
				probe, err := net.Listen("tcp", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				addr := probe.Addr().String()
				probe.Close()
				server, err := NewServer(testConfig(addr))
				if err != nil {
					t.Fatal(err)
				}
				defer server.Close()
				ready := make(chan struct{}, 2)
				ctx, cancel := context.WithCancel(context.WithValue(context.Background(), sipgo.ListenReadyCtxKey, sipgo.ListenReadyFuncCtxValue(func(string, string) { ready <- struct{}{} })))
				defer cancel()
				go server.Run(ctx)
				for i := 0; i < 2; i++ {
					select {
					case <-ready:
					case <-time.After(2 * time.Second):
						t.Fatal("listener timeout")
					}
				}
				var registeredConnection sip.Connection
				if network == "tcp" {
					tcpPeer, err = net.Dial("tcp", addr)
					if err != nil {
						t.Fatal(err)
					}
					defer tcpPeer.Close()
					address = tcpPeer.LocalAddr().String()
					request := fmt.Sprintf("REGISTER sip:34020000002000000001@3402000000 SIP/2.0\r\nVia: SIP/2.0/TCP %s;branch=z9hG4bK-ptz-connect;rport\r\nFrom: <sip:%s@3402000000>;tag=ptz-camera\r\nTo: <sip:34020000002000000001@3402000000>\r\nCall-ID: ptz-connect\r\nCSeq: 1 REGISTER\r\nContact: <sip:%s@%s>\r\nExpires: 3600\r\nMax-Forwards: 70\r\nContent-Length: 0\r\n\r\n", address, sampleID, sampleID, address)
					tcpPeer.SetDeadline(time.Now().Add(2 * time.Second))
					tcpPeer.Write([]byte(request))
					buf := bufio.NewReader(tcpPeer)
					first, e := buf.ReadString('\n')
					if e != nil || !strings.HasPrefix(first, "SIP/2.0 401") {
						t.Fatal("connection setup", first, e)
					}
					for {
						line, e := buf.ReadString('\n')
						if e != nil {
							t.Fatal(e)
						}
						if line == "\r\n" {
							break
						}
					}
					registeredConnection, err = server.ua.TransportLayer().GetConnection("tcp", address)
					if err != nil {
						t.Fatal(err)
					}
					registeredConnection.TryClose()
				}
				channel := "34020000001320000002"
				server.mu.Lock()
				server.states[sampleID] = &DeviceState{ID: sampleID, Registered: true, Version: Version{Profile: version}, Generation: 1, LastSeen: time.Now(), ExpiresAt: time.Now().Add(time.Hour), Catalog: []CatalogItem{{ID: channel}}, source: address, transport: strings.ToUpper(network), connection: registeredConnection}
				server.mu.Unlock()
				packets := make(chan []string, 1)
				failure := make(chan error, 1)
				go func() {
					var conn net.Conn
					var reader *bufio.Reader
					if tcpPeer != nil {
						conn = tcpPeer
						conn.SetDeadline(time.Now().Add(4 * time.Second))
						reader = bufio.NewReader(conn)
					} else {
						peer.SetDeadline(time.Now().Add(4 * time.Second))
					}
					wires := []string{}
					for i := 0; i < 2; i++ {
						var wire string
						var remote net.Addr
						if peer != nil {
							buf := make([]byte, 65536)
							n, from, e := peer.ReadFrom(buf)
							if e != nil {
								failure <- e
								return
							}
							wire = string(buf[:n])
							remote = from
						} else {
							var out strings.Builder
							length := 0
							for {
								line, e := reader.ReadString('\n')
								if e != nil {
									failure <- e
									return
								}
								out.WriteString(line)
								if strings.HasPrefix(strings.ToLower(line), "content-length:") {
									length, _ = strconv.Atoi(strings.TrimSpace(strings.SplitN(line, ":", 2)[1]))
								}
								if line == "\r\n" {
									break
								}
							}
							body := make([]byte, length)
							if _, e := io.ReadFull(reader, body); e != nil {
								failure <- e
								return
							}
							out.Write(body)
							wire = out.String()
						}
						wires = append(wires, wire)
						reply := "SIP/2.0 200 OK\r\n"
						for _, line := range strings.Split(wire, "\r\n") {
							parts := strings.SplitN(line, ":", 2)
							if len(parts) != 2 {
								continue
							}
							key := strings.ToLower(parts[0])
							if key == "via" || key == "from" || key == "to" || key == "call-id" || key == "cseq" {
								if key == "to" && !strings.Contains(line, ";tag=") {
									line += ";tag=independent-camera"
								}
								reply += line + "\r\n"
							}
						}
						reply += "Content-Length: 0\r\n\r\n"
						if peer != nil {
							peer.WriteTo([]byte(reply), remote)
						} else {
							conn.Write([]byte(reply))
						}
					}
					packets <- wires
				}()
				target, err := server.ptzTarget(sampleID, channel)
				if err != nil {
					t.Fatal(err)
				}
				_, err = server.ptz.Execute(ctx, sampleID+"/"+channel, target, ptzcontrol.Command{Session: "session-111111111111", Sequence: 1, Vector: ptzcontrol.Vector{Pan: 1}, TTLMS: 150, ExpiresAtMS: time.Now().Add(150 * time.Millisecond).UnixMilli()})
				if err != nil {
					t.Fatal(err)
				}
				select {
				case wires := <-packets:
					for i, code := range []string{"A50F0001FF0000B4", "A50F0000000000B4"} {
						if !strings.HasPrefix(wires[i], "MESSAGE sip:"+sampleID+"@") || !strings.Contains(wires[i], "<DeviceID>"+channel+"</DeviceID>") || !strings.Contains(wires[i], "<PTZCmd>"+code+"</PTZCmd>") {
							t.Fatal(fmt.Sprintf("wrong NVR target or code: %s", wires[i]))
						}
					}
				case e := <-failure:
					t.Fatal(e)
				case <-time.After(5 * time.Second):
					t.Fatal("watchdog Stop not delivered")
				}
				confirmed := false
				for i := 0; i < 50; i++ {
					state, ok := server.ptz.Status(sampleID + "/" + channel)
					if ok && state.StopConfirmed {
						confirmed = true
						break
					}
					time.Sleep(20 * time.Millisecond)
				}
				if !confirmed {
					t.Fatal("Stop response was not processed")
				}

			})
		}
	}
}
func TestPresetChunksNormalizeIdentifiersAndRejectConflicts(t *testing.T) {
	q := &presetQuery{sn: "42", generation: 1, expires: time.Now().Add(time.Second), total: -1, items: map[string]PTZPreset{}, done: make(chan []PTZPreset, 1)}
	s := &Server{presetQueries: map[string]*presetQuery{sampleID + "/" + sampleID: q}}
	st := &DeviceState{Generation: 1, Version: Version{Profile: "2022"}}
	parse := func(id, name string) BusinessMessage {
		m, e := ParseBusinessMessage([]byte(`<Response><CmdType>PresetQuery</CmdType><SN>42</SN><DeviceID>`+sampleID+`</DeviceID><SumNum>2</SumNum><PresetList Num="1"><Item><PresetID>`+id+`</PresetID><PresetName>`+name+`</PresetName></Item></PresetList></Response>`), 100)
		if e != nil {
			t.Fatal(e)
		}
		return m
	}
	if e := s.acceptPresets(sampleID, st, parse("001", "Gate")); e != nil {
		t.Fatal(e)
	}
	if e := s.acceptPresets(sampleID, st, parse("1", "Gate")); e != nil {
		t.Fatal(e)
	}
	select {
	case <-q.done:
		t.Fatal("duplicate counted twice")
	default:
	}
	if e := s.acceptPresets(sampleID, st, parse("1", "Other")); e == nil {
		t.Fatal("conflict accepted")
	}
	if e := s.acceptPresets(sampleID, st, parse("2", "Back")); e != nil {
		t.Fatal(e)
	}
	if items := <-q.done; len(items) != 2 || items[0].ID != "1" {
		t.Fatal(items)
	}
}
