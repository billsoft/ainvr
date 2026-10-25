package gateway

import (
	"strings"
	"testing"
	"time"

	"github.com/icholy/digest"
)

const sampleID = "34020000001320000001"

// Fixed wire fixtures do not use the production XML generator.
const catalogFixture = `<?xml version="1.0"?><Response><CmdType>Catalog</CmdType><SN>12</SN><DeviceID>34020000001320000001</DeviceID><SumNum>2</SumNum><DeviceList Num="1"><Item><DeviceID>34020000001320000002</DeviceID><Name>入口</Name><Status>ON</Status></Item></DeviceList></Response>`

func TestVersionProfiles(t *testing.T) {
	for _, tc := range []struct {
		config, header, profile string
		confirmed, bad          bool
	}{
		{"auto", "", "2016", false, false}, {"auto", "2.0", "2016", true, false}, {"auto", "3.0", "2022", true, false},
		{"2022", "", "2022", false, false}, {"2022", "2.0", "", false, true}, {"2016", "3.0", "2016", true, false},
		{"auto", "4.0", "", false, true}, {"unknown", "", "", false, true},
	} {
		t.Run(tc.config+"/"+tc.header, func(t *testing.T) {
			v, e := SelectVersion(tc.config, tc.header)
			if (e != nil) != tc.bad || (!tc.bad && (v.Profile != tc.profile || v.Confirmed != tc.confirmed)) {
				t.Fatalf("unexpected version %+v %v", v, e)
			}
		})
	}
}
func TestXMLBoundsAndCatalog(t *testing.T) {
	m, e := ParseBusinessMessage([]byte(catalogFixture), 100)
	if e != nil || m.List.Items[0].Name != "入口" {
		t.Fatalf("parse: %v", e)
	}
	for name, body := range map[string]string{
		"external entity": `<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/passwd">]>` + catalogFixture,
		"multiple roots":  catalogFixture + catalogFixture,
		"bad count":       strings.Replace(catalogFixture, `Num="1"`, `Num="2"`, 1),
		"huge total":      strings.Replace(catalogFixture, "<SumNum>2", "<SumNum>999999", 1),
		"deep":            strings.Repeat("<x>", 17) + strings.Repeat("</x>", 17),
		"huge":            strings.Repeat("x", MaxXMLBytes+1),
		"bad identity":    strings.ReplaceAll(catalogFixture, sampleID, "bad"),
	} {
		t.Run(name, func(t *testing.T) {
			if _, e := ParseBusinessMessage([]byte(body), 100); e == nil {
				t.Fatal("accepted invalid XML")
			}
		})
	}
}
func TestDirectoryGenerationAndDuplicates(t *testing.T) {
	now := time.Now()
	c := NewCatalog("12", now.Add(time.Minute), 100)
	m, _ := ParseBusinessMessage([]byte(catalogFixture), 100)
	if done, e := c.Add(m, now); done || e != nil {
		t.Fatalf("first chunk %v %v", done, e)
	}
	if done, e := c.Add(m, now); done || e != nil {
		t.Fatalf("duplicate chunk %v %v", done, e)
	}
	m.SN = "11"
	if _, e := c.Add(m, now); e == nil {
		t.Fatal("stale generation accepted")
	}
	m.SN = "12"
	m.List.Items[0].Name = "conflict"
	if _, e := c.Add(m, now); e == nil {
		t.Fatal("conflicting duplicate accepted")
	}
	m.List.Items[0].ID = "34020000001320000003"
	if done, e := c.Add(m, now); !done || e != nil {
		t.Fatalf("final chunk %v %v", done, e)
	}
	if len(c.Snapshot()) != 2 {
		t.Fatal("wrong unique item count")
	}
	if _, e := c.Add(m, now.Add(2*time.Minute)); e == nil {
		t.Fatal("expired query accepted")
	}
}
func TestDigestReplayAndBinding(t *testing.T) {
	now := time.Now()
	a := NewAuthenticator("3402000000", 4)
	challenge, e := a.Challenge(sampleID, "192.0.2.1:5060", now)
	if e != nil {
		t.Fatal(e)
	}
	ch, e := digest.ParseChallenge(challenge)
	if e != nil {
		t.Fatal(e)
	}
	opts := digest.Options{Method: "REGISTER", URI: "sip:34020000002000000001@3402000000", Username: sampleID, Password: "test-only-password", Count: 1, Cnonce: "independent-client"}
	cred, e := digest.Digest(ch, opts)
	if e != nil {
		t.Fatal(e)
	}
	verify := func(source, uri string, at time.Time) error {
		return a.Verify(cred.String(), sampleID, opts.Password, source, "REGISTER", uri, at)
	}
	if verify("192.0.2.2:5060", opts.URI, now) == nil {
		t.Fatal("source mismatch accepted")
	}
	if verify("192.0.2.1:5060", "sip:other", now) == nil {
		t.Fatal("URI mismatch accepted")
	}
	if e := verify("192.0.2.1:5060", opts.URI, now); e != nil {
		t.Fatal(e)
	}
	if verify("192.0.2.1:5060", opts.URI, now) == nil {
		t.Fatal("replay accepted")
	}
	opts.Count = 2
	cred, _ = digest.Digest(ch, opts)
	if e := verify("192.0.2.1:5060", opts.URI, now); e != nil {
		t.Fatal(e)
	}
	opts.Count = 3
	cred, _ = digest.Digest(ch, opts)
	if verify("192.0.2.1:5060", opts.URI, now.Add(3*time.Minute)) != ErrChallengeRequired {
		t.Fatal("expired nonce must request fresh authentication")
	}
	fresh, err := a.Challenge(sampleID, "192.0.2.1:5060", now.Add(3*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	ch, _ = digest.ParseChallenge(fresh)
	opts.Count = 1
	cred, _ = digest.Digest(ch, opts)
	if err := verify("192.0.2.1:5060", opts.URI, now.Add(3*time.Minute)); err != nil {
		t.Fatal("registration renewal failed", err)
	}
}
func TestAuthenticationBound(t *testing.T) {
	a := NewAuthenticator("realm", 1)
	now := time.Now()
	if _, e := a.Challenge(sampleID, "peer", now); e != nil {
		t.Fatal(e)
	}
	if _, e := a.Challenge(sampleID, "peer", now); e == nil {
		t.Fatal("unbounded nonce storage")
	}
	if _, e := a.Challenge(sampleID, "peer", now.Add(3*time.Minute)); e != nil {
		t.Fatal("expired capacity not reclaimed")
	}
}
