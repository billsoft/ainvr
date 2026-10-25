package gateway

import (
	"errors"
	"net"
	"strconv"
	"strings"
)

type MediaAnswer struct {
	IP   string
	Port int
	SSRC uint32
}

// Only the offered single PS video stream is accepted. Device SDP must not
// turn the gateway into an arbitrary TCP client (loopback/metadata/other peer).
// Additional media IPs are explicitly provisioned per device, never learned from SDP.
func validDeviceMediaIP(value string) bool {
	ip := net.ParseIP(value)
	return ip != nil && ip.To4() != nil && ip.IsGlobalUnicast() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast()
}
func ParseMediaAnswer(body []byte, offer MediaLease, registeredIP string, trustedIPs ...string) (MediaAnswer, error) {
	var a MediaAnswer
	if len(body) > 16*1024 {
		return a, errors.New("SDP size limit")
	}
	mediaCount := 0
	protocol, setup, rtpmap, direction := "", "", "", ""
	payload := ""
	version := false
	seen := map[string]bool{}
	for _, raw := range strings.Split(string(body), "\n") {
		line := strings.TrimSpace(raw)
		// Do not let a later, contradictory singleton hide an earlier value.
		key := ""
		switch {
		case strings.HasPrefix(line, "v="), strings.HasPrefix(line, "y="):
			key = line[:2]
		case strings.HasPrefix(line, "c="):
			key = "session-address"
			if mediaCount > 0 {
				key = "media-address"
			}
		case strings.HasPrefix(line, "a=setup:"):
			key = "setup"
		case strings.HasPrefix(line, "a=connection:"):
			key = "connection"
			if line != "a=connection:new" {
				return a, errors.New("unsupported reused media connection")
			}
		case strings.HasPrefix(line, "a=rtpmap:"):
			key = "rtpmap"
		case line == "a=sendonly" || line == "a=sendrecv" || line == "a=recvonly" || line == "a=inactive":
			key = "session-direction"
			if mediaCount > 0 {
				key = "media-direction"
			}
			direction = line
		}
		if key != "" {
			if seen[key] {
				return a, errors.New("duplicate SDP attribute")
			}
			seen[key] = true
		}
		switch {
		case line == "v=0":
			version = true
		case strings.HasPrefix(line, "c="):
			v := strings.Fields(strings.TrimPrefix(line, "c="))
			if len(v) != 3 || v[0] != "IN" || v[1] != "IP4" || net.ParseIP(v[2]) == nil {
				return a, errors.New("unsupported SDP address")
			}
			a.IP = v[2]
		case strings.HasPrefix(line, "m="):
			mediaCount++
			v := strings.Fields(strings.TrimPrefix(line, "m="))
			if len(v) != 4 || v[0] != "video" {
				return a, errors.New("unoffered media stream")
			}
			p, e := strconv.Atoi(v[1])
			if e != nil || p < 1 || p > 65535 {
				return a, errors.New("invalid media port")
			}
			a.Port = p
			protocol = v[2]
			payload = v[3]
		case strings.HasPrefix(line, "a=setup:"):
			setup = strings.TrimPrefix(line, "a=setup:")
		case strings.HasPrefix(line, "a=rtpmap:"):
			rtpmap = strings.TrimPrefix(line, "a=rtpmap:")
		case line == "a=sendonly" || line == "a=sendrecv":
			direction = line
		case strings.HasPrefix(line, "y="):
			y := strings.TrimPrefix(line, "y=")
			v, e := strconv.ParseUint(y, 10, 32)
			if e != nil || len(y) != 10 || v == 0 {
				return a, errors.New("invalid SSRC")
			}
			a.SSRC = uint32(v)
		}
	}
	// Annex G permits compliant PS without rtpmap; an explicit incompatible
	// mapping is still rejected. RFC 4566 defaults an absent direction to sendrecv.
	if !version || mediaCount != 1 || payload != "96" || (rtpmap != "" && rtpmap != "96 PS/90000") || direction == "a=recvonly" || direction == "a=inactive" || a.SSRC != offer.SSRC {
		return a, errors.New("answer does not match offer")
	}
	approved := net.ParseIP(a.IP) != nil && net.ParseIP(a.IP).Equal(net.ParseIP(registeredIP))
	for _, allowed := range trustedIPs {
		if validDeviceMediaIP(allowed) && net.ParseIP(a.IP).Equal(net.ParseIP(allowed)) {
			approved = true
		}
	}
	if !approved {
		return a, errors.New("unapproved media source address")
	}
	switch offer.Mode {
	case "udp":
		if protocol != "RTP/AVP" {
			return a, errors.New("media transport mismatch")
		}
	case "tcp-passive":
		if protocol != "TCP/RTP/AVP" || setup != "active" {
			return a, errors.New("TCP role mismatch")
		}
	case "tcp-active":
		if protocol != "TCP/RTP/AVP" || setup != "passive" {
			return a, errors.New("TCP role mismatch")
		}
	default:
		return a, errors.New("unsupported offer")
	}
	return a, nil
}
