package gateway

import (
	"ainvr/ptzcontrol"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/emiago/sipgo/sip"
	"golang.org/x/text/encoding/simplifiedchinese"
)

type PTZPreset struct {
	ID   string `xml:"PresetID" json:"id"`
	Name string `xml:"PresetName" json:"name"`
}
type presetQuery struct {
	sn         string
	generation uint64
	expires    time.Time
	items      map[string]PTZPreset
	total      int
	done       chan []PTZPreset
}

// Annex A.3.1-A.3.4 in both editions. The unused address bytes are zero;
// XML DeviceID identifies the actual channel, never the NVR registration ID.
func PTZCode(v ptzcontrol.Vector) (string, error) {
	if !v.Valid() {
		return "", errors.New("ptz_invalid_vector")
	}
	var cmd, pan, tilt, zoom byte
	if v.Pan > 0 {
		cmd |= 1
	}
	if v.Pan < 0 {
		cmd |= 2
	}
	if v.Tilt > 0 {
		cmd |= 8
	}
	if v.Tilt < 0 {
		cmd |= 4
	}
	if v.Zoom > 0 {
		cmd |= 16
	}
	if v.Zoom < 0 {
		cmd |= 32
	}
	speed := func(v float64, max float64) byte {
		if v == 0 {
			return 0
		}
		return byte(math.Max(1, math.Round(math.Abs(v)*max)))
	}
	pan = speed(v.Pan, 255)
	tilt = speed(v.Tilt, 255)
	zoom = speed(v.Zoom, 15) << 4
	return frontEndCode(cmd, pan, tilt, zoom), nil
}
func frontEndCode(cmd, a, b, c byte) string {
	wire := []byte{0xa5, 0x0f, 0, cmd, a, b, c, 0}
	for _, v := range wire[:7] {
		wire[7] += v
	}
	return strings.ToUpper(hex.EncodeToString(wire))
}
func PresetCode(action string, id int) (string, error) {
	if id < 1 || id > 255 {
		return "", errors.New("ptz_invalid_preset")
	}
	code := byte(0)
	switch action {
	case "save":
		code = 0x81
	case "goto":
		code = 0x82
	case "remove":
		code = 0x83
	default:
		return "", errors.New("ptz_invalid_preset_action")
	}
	return frontEndCode(code, 0, byte(id), 0), nil
}
func ControlXML(channel string, sn uint32, profile, code, name string) ([]byte, error) {
	if !deviceIDPattern.MatchString(channel) || sn == 0 || len(code) != 16 {
		return nil, errors.New("ptz_invalid_identity")
	}
	raw, e := hex.DecodeString(code)
	if e != nil || raw[0] != 0xa5 || raw[1] != 0x0f {
		return nil, errors.New("ptz_invalid_code")
	}
	sum := byte(0)
	for _, b := range raw[:7] {
		sum += b
	}
	if sum != raw[7] {
		return nil, errors.New("ptz_invalid_checksum")
	}
	charset := "GB2312"
	params := ""
	if profile == "2022" {
		charset = "GB18030"
		if name != "" {
			if len([]rune(name)) > 100 {
				return nil, errors.New("ptz_invalid_name")
			}
			var b bytes.Buffer
			xml.EscapeText(&b, []byte(name))
			params = "<PTZCmdParams><PresetName>" + b.String() + "</PresetName></PTZCmdParams>"
		}
	} else if profile != "2016" {
		return nil, errors.New("ptz_invalid_version")
	}
	body := fmt.Sprintf("<?xml version=\"1.0\" encoding=\"%s\"?>\r\n<Control><CmdType>DeviceControl</CmdType><SN>%d</SN><DeviceID>%s</DeviceID><PTZCmd>%s</PTZCmd>%s<Info><ControlPriority>5</ControlPriority></Info></Control>\r\n", charset, sn, channel, code, params)
	if profile == "2022" {
		return simplifiedchinese.GB18030.NewEncoder().Bytes([]byte(body))
	}
	return []byte(body), nil
}

type gbPTZTarget struct {
	server          *Server
	device, channel string
	generation      uint64
}

func (s *Server) ptzTarget(device, channel string) (*gbPTZTarget, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.states[device]
	if !s.online(st, time.Now()) {
		return nil, errors.New("ptz_device_offline")
	}
	found := false
	for _, item := range st.Catalog {
		if item.ID == channel {
			found = true
			break
		}
	}
	if !found {
		return nil, errors.New("ptz_channel_not_found")
	}
	return &gbPTZTarget{s, device, channel, st.Generation}, nil
}
func (t *gbPTZTarget) send(ctx context.Context, code, name string) error {
	s := t.server
	s.mu.Lock()
	st := s.states[t.device]
	if !s.online(st, time.Now()) || st.Generation != t.generation {
		s.mu.Unlock()
		return errors.New("ptz_source_changed")
	}
	source, transport, profile := st.source, st.transport, st.Version.Profile
	s.mu.Unlock()
	sn := s.sequence.Add(1)
	if sn == 0 {
		sn = s.sequence.Add(1)
	}
	body, e := ControlXML(t.channel, sn, profile, code, name)
	if e != nil {
		return e
	}
	req := s.request(sip.MESSAGE, t.device, source, transport, body, "Application/MANSCDP+xml")
	// A transaction 200 acknowledges delivery only. PTZ has no DeviceControl
	// business response; waiting for one would falsely time out a valid command.
	response, e := s.client.Do(ctx, req)
	if e != nil {
		return errors.New("ptz_transport_failed")
	}
	if response.StatusCode != 200 {
		return errors.New("ptz_command_rejected")
	}
	return nil
}
func (t *gbPTZTarget) Move(ctx context.Context, v ptzcontrol.Vector, _ time.Duration) error {
	code, e := PTZCode(v)
	if e != nil {
		return e
	}
	return t.send(ctx, code, "")
}
func (t *gbPTZTarget) Stop(ctx context.Context) error {
	code, _ := PTZCode(ptzcontrol.Vector{})
	return t.send(ctx, code, "")
}
func (t *gbPTZTarget) Preset(ctx context.Context, id string) error {
	n, e := strconv.Atoi(id)
	if e != nil {
		return errors.New("ptz_invalid_preset")
	}
	code, e := PresetCode("goto", n)
	if e != nil {
		return e
	}
	return t.send(ctx, code, "")
}
func (t *gbPTZTarget) SavePreset(ctx context.Context, id, name string) error {
	n, e := strconv.Atoi(id)
	if e != nil {
		return errors.New("ptz_invalid_preset")
	}
	code, e := PresetCode("save", n)
	if e != nil {
		return e
	}
	return t.send(ctx, code, name)
}
func (t *gbPTZTarget) RemovePreset(ctx context.Context, id string) error {
	n, e := strconv.Atoi(id)
	if e != nil {
		return errors.New("ptz_invalid_preset")
	}
	code, e := PresetCode("remove", n)
	if e != nil {
		return e
	}
	return t.send(ctx, code, "")
}
func (t *gbPTZTarget) Presets(ctx context.Context) ([]PTZPreset, error) {
	s := t.server
	key := t.device + "/" + t.channel
	s.mu.Lock()
	st := s.states[t.device]
	if !s.online(st, time.Now()) || st.Generation != t.generation {
		s.mu.Unlock()
		return nil, errors.New("ptz_source_changed")
	}
	if s.presetQueries == nil {
		s.presetQueries = map[string]*presetQuery{}
	}
	if len(s.presetQueries) >= 8 || s.presetQueries[key] != nil {
		s.mu.Unlock()
		return nil, errors.New("ptz_query_busy")
	}
	sn := s.sequence.Add(1)
	if sn == 0 {
		sn = s.sequence.Add(1)
	}
	q := &presetQuery{sn: strconv.FormatUint(uint64(sn), 10), generation: t.generation, expires: time.Now().Add(5 * time.Second), items: map[string]PTZPreset{}, total: -1, done: make(chan []PTZPreset, 1)}
	s.presetQueries[key] = q
	source, transport, profile := st.source, st.transport, st.Version.Profile
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.presetQueries[key] == q {
			delete(s.presetQueries, key)
		}
		s.mu.Unlock()
	}()
	body, e := QueryXMLForProfile("PresetQuery", t.channel, sn, profile)
	if e != nil {
		return nil, e
	}
	req := s.request(sip.MESSAGE, t.device, source, transport, body, "Application/MANSCDP+xml")
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	response, e := s.client.Do(ctx, req)
	if e != nil || response.StatusCode != 200 {
		return nil, errors.New("ptz_query_failed")
	}
	select {
	case items := <-q.done:
		return items, nil
	case <-ctx.Done():
		return nil, errors.New("ptz_query_timeout")
	}
}

// Caller holds s.mu. Match registration generation, channel, SN, transport and
// bounded deadline before retaining any asynchronous preset response.
func (s *Server) acceptPresets(device string, st *DeviceState, m BusinessMessage) error {
	q := s.presetQueries[device+"/"+m.DeviceID]
	if m.XMLName.Local != "Response" || q == nil || q.sn != m.SN || q.generation != st.Generation || time.Now().After(q.expires) {
		return errors.New("ptz_unsolicited_response")
	}
	total := m.PresetList.Count
	if st.Version.Profile == "2022" {
		if !m.HasSumNum {
			return errors.New("ptz_preset_total_missing")
		}
		total = m.SumNum
	}
	if total < 0 || total > 255 || m.PresetList.Count != len(m.PresetList.Items) || len(m.PresetList.Items) > 255 {
		return errors.New("ptz_invalid_presets")
	}
	if q.total != -1 && q.total != total {
		return errors.New("ptz_preset_total_changed")
	}
	q.total = total
	for _, item := range m.PresetList.Items {
		n, e := strconv.Atoi(item.ID)
		if e != nil || n < 1 || n > 255 || len(item.Name) > 512 {
			return errors.New("ptz_invalid_presets")
		}
		item.ID = strconv.Itoa(n)
		if old, ok := q.items[item.ID]; ok && old != item {
			return errors.New("ptz_preset_conflict")
		}
		q.items[item.ID] = item
	}
	if len(q.items) > total {
		return errors.New("ptz_preset_overflow")
	}
	if len(q.items) == total {
		items := []PTZPreset{}
		for n := 1; n <= 255; n++ {
			if item, ok := q.items[strconv.Itoa(n)]; ok {
				items = append(items, item)
			}
		}
		select {
		case q.done <- items:
		default:
		}
	}
	return nil
}
