package gateway

import (
	"context"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
)

func TestCancelledInviteAcknowledgesLateSuccess(t *testing.T) {
	peer, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
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
		case <-time.After(time.Second):
			t.Fatal("listen timeout")
		}
	}
	reply := func(request string, code int, reason string) string {
		out := fmt.Sprintf("SIP/2.0 %d %s\r\n", code, reason)
		for _, line := range strings.Split(request, "\r\n") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) != 2 {
				continue
			}
			key := strings.ToLower(parts[0])
			if key == "via" || key == "from" || key == "to" || key == "call-id" || key == "cseq" {
				if key == "to" && !strings.Contains(line, ";tag=") {
					line += ";tag=late-peer"
				}
				out += line + "\r\n"
			}
		}
		return out + fmt.Sprintf("Contact: <sip:%s@%s>\r\nContent-Length: 0\r\n\r\n", sampleID, peer.LocalAddr())
	}
	observed := make(chan error, 1)
	go func() {
		peer.SetDeadline(time.Now().Add(5 * time.Second))
		buf := make([]byte, 65536)
		n, remote, e := peer.ReadFrom(buf)
		if e != nil {
			observed <- e
			return
		}
		invite := string(buf[:n])
		peer.WriteTo([]byte(reply(invite, 100, "Trying")), remote)
		seen := map[string]bool{}
		for !seen["BYE"] {
			n, remote, e = peer.ReadFrom(buf)
			if e != nil {
				observed <- e
				return
			}
			packet := string(buf[:n])
			method := strings.SplitN(packet, " ", 2)[0]
			seen[method] = true
			if method == "CANCEL" {
				peer.WriteTo([]byte(reply(packet, 200, "OK")), remote)
				peer.WriteTo([]byte(reply(invite, 200, "OK")), remote)
			}
			if method == "BYE" {
				peer.WriteTo([]byte(reply(packet, 200, "OK")), remote)
			}
		}
		if !seen["CANCEL"] || !seen["ACK"] {
			observed <- fmt.Errorf("missing cancel/ack: %v", seen)
			return
		}
		observed <- nil
	}()
	req := server.request(sip.INVITE, sampleID, peer.LocalAddr().String(), "UDP", nil, "application/sdp")
	dialog, err := server.dialogs["UDP"].WriteInvite(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	defer dialog.Close()
	if err = server.waitLiveAnswer(ctx, dialog, 50*time.Millisecond); err == nil {
		t.Fatal("cancelled invite reported success")
	}
	select {
	case err = <-observed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("late success cleanup timed out")
	}
}
