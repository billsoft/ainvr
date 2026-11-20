package gateway

import (
	"context"
	"encoding/xml"
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/emiago/sipgo/sip"
)

// GB/T 28181-2022 A.2.6.15. Preserve raw device units and field presence.
type PTZPosition struct {
	Pan                  *positionNumber `xml:"Pan" json:"pan,omitempty"`
	Tilt                 *positionNumber `xml:"Tilt" json:"tilt,omitempty"`
	Zoom                 *positionNumber `xml:"Zoom" json:"zoom,omitempty"`
	HorizontalFieldAngle *positionNumber `xml:"HorizontalFieldAngle" json:"horizontalFieldAngle,omitempty"`
	VerticalFieldAngle   *positionNumber `xml:"VerticalFieldAngle" json:"verticalFieldAngle,omitempty"`
	MaxViewDistance      *positionNumber `xml:"MaxViewDistance" json:"maxViewDistance,omitempty"`
}

type positionNumber float64

var decimalPosition = regexp.MustCompile(`^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$`)

func (n *positionNumber) UnmarshalXML(d *xml.Decoder, start xml.StartElement) error {
	var field struct {
		Text     string     `xml:",chardata"`
		Children []struct{} `xml:",any"`
	}
	if err := d.DecodeElement(&field, &start); err != nil {
		return err
	}
	v := strings.TrimSpace(field.Text)
	if len(field.Children) > 0 || len(v) > 64 || !decimalPosition.MatchString(v) {
		return errors.New("invalid position number")
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return errors.New("nonfinite position number")
	}
	*n = positionNumber(f)
	return nil
}

type positionReading struct {
	PTZPosition
	Position     bool   `json:"position"`
	Device       string `json:"deviceId"`
	Channel      string `json:"channelId"`
	Generation   uint64 `json:"generation"`
	Revision     int64  `json:"revision"`
	SN           string `json:"sn"`
	ObservedAtMs int64  `json:"observedAtMs"`
}

type positionReply struct {
	measurement PTZPosition
	at          time.Time
	failed      bool
}

type positionQuery struct {
	sn, source, transport string
	state                 *DeviceState
	generation            uint64
	deadline              time.Time
	answered              bool
	done                  chan positionReply
}

// Caller holds server.mu.
func (t *gbPTZTarget) positionChannel(st *DeviceState) *CatalogItem {
	if !t.server.online(st, time.Now()) || st.Generation != t.generation {
		return nil
	}
	for i := range st.Catalog {
		if st.Catalog[i].ID == t.channel {
			return &st.Catalog[i]
		}
	}
	return nil
}

func (t *gbPTZTarget) position(parent context.Context, revision int64) (*positionReading, error) {
	ctx, cancel := context.WithTimeout(parent, 3*time.Second)
	defer cancel()
	s := t.server
	key := t.device + "/" + t.channel
	s.mu.Lock()
	st := s.states[t.device]
	item := t.positionChannel(st)
	if item == nil {
		s.mu.Unlock()
		return nil, errors.New("ptz_source_changed")
	}
	// Leave regular command slots available in addition to the reserved Stop slots.
	if len(s.positionQueries) >= 4 || s.positionQueries[key] != nil {
		s.mu.Unlock()
		return nil, errors.New("ptz_query_busy")
	}
	sn := s.sequence.Add(1)
	if sn == 0 {
		sn = s.sequence.Add(1)
	}
	body, err := QueryXMLForProfile("PTZPosition", t.channel, sn, st.Version.Profile)
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	deadline, _ := ctx.Deadline()
	q := &positionQuery{sn: strconv.FormatUint(uint64(sn), 10), source: st.source, transport: st.transport,
		state: st, generation: st.Generation, deadline: deadline, done: make(chan positionReply, 1)}
	if s.positionQueries == nil {
		s.positionQueries = make(map[string]*positionQuery)
	}
	s.positionQueries[key] = q
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.positionQueries, key); s.mu.Unlock() }()

	req := s.request(sip.MESSAGE, t.device, q.source, q.transport, body, "Application/MANSCDP+xml")
	ack, err := s.client.Do(ctx, req)
	if ctx.Err() != nil {
		return nil, errors.New("ptz_query_timeout")
	}
	if err != nil || ack == nil || ack.StatusCode != 200 {
		return nil, errors.New("ptz_query_failed")
	}
	select {
	case <-ctx.Done():
		return nil, errors.New("ptz_query_timeout")
	case reply := <-q.done:
		s.mu.Lock()
		defer s.mu.Unlock()
		current := s.states[t.device]
		item = t.positionChannel(current)
		if item == nil || current != st || current.source != q.source || current.transport != q.transport {
			return nil, errors.New("ptz_source_changed")
		}
		if ctx.Err() != nil || !time.Now().Before(q.deadline) {
			return nil, errors.New("ptz_query_timeout")
		}
		if reply.failed {
			return nil, errors.New("ptz_query_failed")
		}
		full := reply.measurement.Pan != nil && reply.measurement.Tilt != nil
		return &positionReading{PTZPosition: reply.measurement, Position: full, Device: t.device, Channel: t.channel,
			Generation: q.generation, Revision: revision, SN: q.sn, ObservedAtMs: reply.at.UnixMilli()}, nil
	}
}

// Called under s.mu after MESSAGE transport authorization and XML validation.
func (s *Server) acceptPosition(device string, st *DeviceState, m BusinessMessage, source, transport string) bool {
	q := s.positionQueries[device+"/"+m.DeviceID]
	now := time.Now()
	if m.Command != "PTZPosition" || m.XMLName.Local != "Response" || q == nil || q.answered || q.sn != m.SN ||
		st == nil || s.states[device] != st || q.state != st || q.generation != st.Generation ||
		q.source != source || q.transport != transport || st.source != source || st.transport != transport ||
		!now.Before(q.deadline) {
		return false
	}
	q.answered = true
	q.done <- positionReply{measurement: m.Position, at: now, failed: m.Result != "" && m.Result != "OK"}
	return true
}
