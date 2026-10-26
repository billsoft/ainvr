package onvif

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

type Error struct {
	Code string `json:"code"`
}

func (e *Error) Error() string  { return e.Code }
func failure(code string) error { return &Error{code} }
func Code(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return "device_unreachable"
}

type Policy struct {
	AllowedCIDRs   []string `json:"allowedCIDRs"`
	TimeoutSeconds int      `json:"timeoutSeconds"`
}

func (p Policy) Validate() error {
	if p.TimeoutSeconds < 1 || p.TimeoutSeconds > 15 || len(p.AllowedCIDRs) > 32 {
		return failure("invalid_policy")
	}
	for _, v := range p.AllowedCIDRs {
		if _, e := netip.ParsePrefix(v); e != nil {
			return failure("invalid_network")
		}
	}
	return nil
}
func (p Policy) allowed(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsValid() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsMulticast() {
		return false
	}
	for _, v := range p.AllowedCIDRs {
		prefix, e := netip.ParsePrefix(v)
		if e == nil && prefix.Contains(ip) {
			return true
		}
	}
	return false
}
func (p Policy) checkURL(raw, scheme string) (*url.URL, error) {
	if len(raw) == 0 || len(raw) > 2048 || strings.IndexFunc(raw, func(r rune) bool { return r <= 32 || r == 127 }) >= 0 {
		return nil, failure("invalid_device_address")
	}
	u, e := url.Parse(raw)
	if e != nil || u.Hostname() == "" || u.Fragment != "" || u.User != nil {
		return nil, failure("invalid_device_address")
	}
	if scheme == "soap" {
		if u.Scheme != "http" && u.Scheme != "https" {
			return nil, failure("invalid_device_address")
		}
	} else if u.Scheme != scheme {
		return nil, failure("unsupported_media_uri")
	}
	return u, nil
}
func (p Policy) resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	if a, e := netip.ParseAddr(host); e == nil {
		if !p.allowed(a) {
			return nil, failure("address_not_allowed")
		}
		return []netip.Addr{a}, nil
	}
	bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	ips, e := net.DefaultResolver.LookupNetIP(bounded, "ip", host)
	if e != nil || len(ips) == 0 {
		return nil, failure("device_unreachable")
	}
	for _, ip := range ips {
		if !p.allowed(ip) {
			return nil, failure("address_not_allowed")
		}
	}
	return ips, nil
}
func (p Policy) dial(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, e := net.SplitHostPort(address)
	if e != nil {
		return nil, failure("invalid_device_address")
	}
	ips, e := p.resolve(ctx, host)
	if e != nil {
		return nil, e
	}
	d := net.Dialer{Timeout: time.Duration(p.TimeoutSeconds) * time.Second}
	var last error
	for _, ip := range ips {
		c, e := d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if e == nil {
			return c, nil
		}
		last = e
	}
	return nil, last
}
