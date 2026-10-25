package gateway

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"sync"
	"time"

	"github.com/icholy/digest"
)

type challengeState struct {
	device, source string
	expires        time.Time
	count          int
	used           bool
}

var ErrChallengeRequired = errors.New("fresh authentication challenge required")

type Authenticator struct {
	mu         sync.Mutex
	realm      string
	ttl        time.Duration
	max        int
	challenges map[string]challengeState
}

func NewAuthenticator(realm string, max int) *Authenticator {
	return &Authenticator{realm: realm, ttl: 2 * time.Minute, max: max, challenges: make(map[string]challengeState)}
}
func (a *Authenticator) Challenge(device, source string, now time.Time) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for n, c := range a.challenges {
		if !now.Before(c.expires) {
			delete(a.challenges, n)
		}
	}
	if len(a.challenges) >= a.max {
		return "", errors.New("authentication capacity exhausted")
	}
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		return "", e
	}
	nonce := hex.EncodeToString(b)
	a.challenges[nonce] = challengeState{device: device, source: source, expires: now.Add(a.ttl)}
	return (&digest.Challenge{Realm: a.realm, Nonce: nonce, Algorithm: "MD5", QOP: []string{"auth"}}).String(), nil
}

// Authentication failures deliberately have a single public error. Responses
// and plaintext credentials must never be logged. Legacy no-qop is one-use.
func (a *Authenticator) Verify(header, device, password, source, method, uri string, now time.Time) error {
	bad := errors.New("authentication rejected")
	if len(header) > 4096 || len(password) == 0 {
		return bad
	}
	c, e := digest.ParseCredentials(header)
	if e != nil {
		return bad
	}
	if c.Username != device || c.Realm != a.realm || c.URI != uri || c.Userhash || c.Opaque != "" || (c.Algorithm != "" && c.Algorithm != "MD5") || (c.QOP != "" && c.QOP != "auth") {
		return bad
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	n, ok := a.challenges[c.Nonce]
	if !ok {
		return ErrChallengeRequired
	}
	if n.device != device || n.source != source {
		return bad
	}
	if !now.Before(n.expires) {
		return ErrChallengeRequired
	}
	if n.used {
		return bad
	}
	qop := []string(nil)
	if c.QOP == "auth" {
		if c.Nc <= n.count || c.Nc <= 0 || c.Cnonce == "" || len(c.Cnonce) > 128 {
			return bad
		}
		qop = []string{"auth"}
	}
	expected, e := digest.Digest(&digest.Challenge{Realm: a.realm, Nonce: c.Nonce, Algorithm: "MD5", QOP: qop}, digest.Options{Method: method, URI: uri, Username: device, Password: password, Count: c.Nc, Cnonce: c.Cnonce})
	if e != nil || subtle.ConstantTimeCompare([]byte(expected.Response), []byte(c.Response)) != 1 {
		return bad
	}
	n.count = c.Nc
	if c.QOP == "" {
		n.used = true
	}
	a.challenges[c.Nonce] = n
	return nil
}
