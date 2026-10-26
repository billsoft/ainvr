package onvif

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net"
	"strings"
	"syscall"
	"time"
)

type Candidate struct {
	EPR    string   `json:"epr"`
	URL    string   `json:"url"`
	Scopes []string `json:"scopes"`
}

const discoveryNS = "http://schemas.xmlsoap.org/ws/2005/04/discovery"
const addressingNS = "http://schemas.xmlsoap.org/ws/2004/08/addressing"

func discoveryCandidates(data []byte, messageID string, p Policy) []Candidate {
	root, e := parseXML(data)
	if e != nil || root.Name.Space != soapNS || root.Name.Local != "Envelope" {
		return nil
	}
	var header, body *node
	for _, n := range root.Children {
		if n.Name.Space == soapNS {
			if n.Name.Local == "Header" {
				header = n
			}
			if n.Name.Local == "Body" {
				body = n
			}
		}
	}
	related, action := "", ""
	if header != nil {
		for _, n := range header.Children {
			if n.Name.Space == addressingNS {
				if n.Name.Local == "RelatesTo" {
					related = strings.TrimSpace(n.Text)
				}
				if n.Name.Local == "Action" {
					action = strings.TrimSpace(n.Text)
				}
			}
		}
	}
	if related != messageID || action != discoveryNS+"/ProbeMatches" {
		return nil
	}
	out := []Candidate{}
	if body == nil {
		return out
	}
	for _, matches := range body.Children {
		if matches.Name.Space != discoveryNS || matches.Name.Local != "ProbeMatches" {
			continue
		}
		for _, m := range matches.Children {
			if m.Name.Space != discoveryNS || m.Name.Local != "ProbeMatch" {
				continue
			}
			candidate := Candidate{}
			for _, n := range m.Children {
				if n.Name.Space == addressingNS && n.Name.Local == "EndpointReference" {
					for _, a := range n.Children {
						if a.Name.Space == addressingNS && a.Name.Local == "Address" {
							candidate.EPR = strings.TrimSpace(a.Text)
						}
					}
				}
				if n.Name.Space == discoveryNS && n.Name.Local == "Scopes" {
					candidate.Scopes = strings.Fields(n.Text)
					if len(candidate.Scopes) > 32 {
						candidate.Scopes = candidate.Scopes[:32]
					}
				}
				if n.Name.Space == discoveryNS && n.Name.Local == "XAddrs" {
					for _, raw := range strings.Fields(n.Text) {
						u, e := p.checkURL(raw, "soap")
						if e != nil {
							continue
						}
						ip := net.ParseIP(u.Hostname())
						if ip == nil {
							continue
						}
						parsed, e := netipAddress(ip)
						if e == nil && p.allowed(parsed) {
							candidate.URL = u.String()
							break
						}
					}
				}
			}
			if candidate.EPR != "" && len(candidate.EPR) <= 300 && candidate.URL != "" {
				out = append(out, candidate)
			}
		}
	}
	return out
}
func Discover(ctx context.Context, interfaceName string, p Policy) ([]Candidate, error) {
	iface, e := net.InterfaceByName(interfaceName)
	if e != nil || iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
		return nil, failure("invalid_interface")
	}
	addresses, e := iface.Addrs()
	if e != nil {
		return nil, failure("invalid_interface")
	}
	var local net.IP
	for _, a := range addresses {
		ip, _, e := net.ParseCIDR(a.String())
		if e == nil && ip.To4() != nil {
			addr, _ := netipAddress(ip)
			if addr.IsGlobalUnicast() && !addr.IsLoopback() {
				local = ip.To4()
				break
			}
		}
	}
	if local == nil {
		return nil, failure("interface_not_allowed")
	}
	conn, e := net.ListenUDP("udp4", &net.UDPAddr{IP: local})
	if e != nil {
		return nil, failure("discovery_unavailable")
	}
	defer conn.Close()
	raw, e := conn.SyscallConn()
	if e != nil {
		return nil, failure("discovery_unavailable")
	}
	var socketErr error
	e = raw.Control(func(fd uintptr) {
		var ip [4]byte
		copy(ip[:], local)
		socketErr = syscall.SetsockoptInet4Addr(int(fd), syscall.IPPROTO_IP, syscall.IP_MULTICAST_IF, ip)
		if socketErr == nil {
			socketErr = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_IP, syscall.IP_MULTICAST_TTL, 1)
		}
	})
	if e != nil || socketErr != nil {
		return nil, failure("discovery_unavailable")
	}
	random := make([]byte, 16)
	_, _ = rand.Read(random)
	id := hex.EncodeToString(random)
	messageID := "urn:uuid:" + id[:8] + "-" + id[8:12] + "-" + id[12:16] + "-" + id[16:20] + "-" + id[20:]
	request := `<s:Envelope xmlns:s="` + soapNS + `" xmlns:a="` + addressingNS + `" xmlns:d="` + discoveryNS + `" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><s:Header><a:MessageID>` + messageID + `</a:MessageID><a:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To><a:Action>` + discoveryNS + `/Probe</a:Action></s:Header><s:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></s:Body></s:Envelope>`
	if _, e = conn.WriteToUDP([]byte(request), &net.UDPAddr{IP: net.ParseIP("239.255.255.250"), Port: 3702}); e != nil {
		return nil, failure("discovery_unavailable")
	}
	deadline := time.Now().Add(5 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	_ = conn.SetReadDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { _ = conn.SetReadDeadline(time.Now()) })
	defer stop()
	results := []Candidate{}
	seen := map[string]bool{}
	buf := make([]byte, 65536)
	for packets := 0; packets < 512 && len(results) < 128; packets++ {
		n, _, e := conn.ReadFromUDP(buf)
		if e != nil {
			break
		}
		for _, candidate := range discoveryCandidates(buf[:n], messageID, p) {
			if !seen[candidate.EPR] {
				seen[candidate.EPR] = true
				results = append(results, candidate)
			}
		}
	}
	return results, nil
}
