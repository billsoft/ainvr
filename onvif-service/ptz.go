package onvif

import (
	"ainvr/ptzcontrol"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const panVelocity = "http://www.onvif.org/ver10/tptz/PanTiltSpaces/VelocityGenericSpace"
const zoomVelocity = "http://www.onvif.org/ver10/tptz/ZoomSpaces/VelocityGenericSpace"
const panTranslation = "http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationGenericSpace"
const zoomTranslation = "http://www.onvif.org/ver10/tptz/ZoomSpaces/TranslationGenericSpace"

type PTZCapabilities struct {
	Resource          string   `json:"resource"`
	VideoSources      []string `json:"videoSources,omitempty"`
	PanTilt           bool     `json:"panTilt"`
	Zoom              bool     `json:"zoom"`
	ContinuousPanTilt bool     `json:"continuousPanTilt"`
	ContinuousZoom    bool     `json:"continuousZoom"`
	RelativePanTilt   bool     `json:"relativePanTilt"`
	RelativeZoom      bool     `json:"relativeZoom"`
	Presets           bool     `json:"presets"`
	PresetWrite       bool     `json:"presetWrite"`
	Position          bool     `json:"position"`
	MoveStatus        bool     `json:"moveStatus"`
	Reason            string   `json:"reason,omitempty"`
}
type ptzSpace struct {
	URI                    string
	XMin, XMax, YMin, YMax float64
}
type PTZTarget struct {
	client                                                   *Client
	endpoint, token, node                                    string
	caps                                                     PTZCapabilities
	continuousPan, continuousZoom, relativePan, relativeZoom *ptzSpace
	timeoutMin, timeoutMax                                   time.Duration
}
type PTZPreset struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type PTZPosition struct {
	Pan, Tilt, Zoom         *float64
	PanTiltSpace, ZoomSpace string
}
type PTZStatus struct {
	Position *PTZPosition `json:"position,omitempty"`
	PanTilt  string       `json:"panTilt,omitempty"`
	Zoom     string       `json:"zoom,omitempty"`
}

func ptzNumber(s string) (float64, bool) {
	v, e := strconv.ParseFloat(s, 64)
	return v, e == nil && !math.IsNaN(v) && !math.IsInf(v, 0)
}

// Calendar months and years cannot be converted to a fixed movement timeout.
var ptzDurationPattern = regexp.MustCompile(`^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$`)

func ptzDuration(s string) (time.Duration, bool) {
	m := ptzDurationPattern.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil || (m[1] == "" && m[2] == "" && m[3] == "" && m[4] == "") || strings.HasSuffix(strings.TrimSpace(s), "T") {
		return 0, false
	}
	total := float64(0)
	units := []float64{86400, 3600, 60, 1}
	for i, unit := range units {
		if m[i+1] == "" {
			continue
		}
		v, ok := ptzNumber(m[i+1])
		if !ok {
			return 0, false
		}
		total += v * unit
	}
	// Bound conversion before casting: oversized device input must not overflow.
	if math.IsInf(total, 0) || total >= float64(math.MaxInt64)/float64(time.Second) {
		return 0, false
	}
	return time.Duration(total * float64(time.Second)), true
}
func selectSpace(spaces *node, name, uri string, xy bool) *ptzSpace {
	if spaces == nil {
		return nil
	}
	for _, n := range spaces.Children {
		if n.Name.Space != schemaNS || n.Name.Local != name || n.text("URI") != uri {
			continue
		}
		xmin, a := ptzNumber(n.path("XRange").text("Min"))
		xmax, b := ptzNumber(n.path("XRange").text("Max"))
		if !a || !b || xmin >= 0 || xmax <= 0 {
			continue
		}
		s := &ptzSpace{URI: uri, XMin: xmin, XMax: xmax}
		if xy {
			var c, d bool
			s.YMin, c = ptzNumber(n.path("YRange").text("Min"))
			s.YMax, d = ptzNumber(n.path("YRange").text("Max"))
			if !c || !d || s.YMin >= 0 || s.YMax <= 0 {
				continue
			}
		}
		return s
	}
	return nil
}
func (c *Client) PreparePTZ(ctx context.Context, service, token, source string) (*PTZTarget, error) {
	if e := c.endpoints(ctx); e != nil {
		return nil, e
	}
	profiles, e := c.profiles(ctx)
	if e != nil {
		return nil, e
	}
	var profile *Profile
	for i := range profiles {
		p := &profiles[i]
		if p.Service == service && p.Token == token && p.VideoSource == source {
			profile = p
			break
		}
	}
	if profile == nil {
		return nil, failure("profile_not_found")
	}
	t := &PTZTarget{client: c, token: token}
	if profile.PTZConfig == "" {
		t.caps.Reason = "ptz_not_supported"
		return t, nil
	}
	if c.services[ptzNS] == "" {
		n, err := c.soap(ctx, c.device.URL, deviceNS, "GetCapabilities", "<m:Category>PTZ</m:Category>", false)
		if err != nil {
			return nil, err
		}
		c.services[ptzNS] = n.path("Capabilities", "PTZ").text("XAddr")
	}
	t.endpoint = c.services[ptzNS]
	if t.endpoint == "" {
		return nil, failure("ptz_service_unavailable")
	}
	conf, e := c.soap(ctx, t.endpoint, ptzNS, "GetConfiguration", "<m:PTZConfigurationToken>"+escape(profile.PTZConfig)+"</m:PTZConfigurationToken>", false)
	if e != nil {
		return nil, e
	}
	config := conf.child("PTZConfiguration")
	if config.attr("token") != profile.PTZConfig {
		return nil, failure("ptz_configuration_mismatch")
	}
	t.node = config.text("NodeToken")
	if t.node == "" || len(t.node) > 256 {
		return nil, failure("ptz_node_unavailable")
	}
	// Profiles may use distinct PTZ configurations for the same physical node.
	// Discover the complete node mapping before allowing movement, so every
	// dependent video source can suspend its pixel-coordinate analytics.
	mapping := map[string]string{profile.PTZConfig: t.node}
	needsMapping := false
	for _, p := range profiles {
		if p.PTZConfig != "" && p.PTZConfig != profile.PTZConfig {
			needsMapping = true
		}
	}
	if needsMapping {
		all, err := c.soap(ctx, t.endpoint, ptzNS, "GetConfigurations", "", false)
		if err != nil {
			return nil, failure("ptz_node_mapping_unavailable")
		}
		for _, config := range all.Children {
			if config.Name.Local != "PTZConfiguration" || config.Name.Space != ptzNS {
				continue
			}
			key, node := config.attr("token"), config.text("NodeToken")
			if key == "" || node == "" || len(key) > 256 || len(node) > 256 || len(mapping) > 256 {
				return nil, failure("ptz_node_mapping_invalid")
			}
			if previous, ok := mapping[key]; ok && previous != node {
				return nil, failure("ptz_node_mapping_invalid")
			}
			mapping[key] = node
		}
	}
	seenSources := map[string]bool{}
	for _, p := range profiles {
		if p.PTZConfig == "" {
			continue
		}
		mapped, ok := mapping[p.PTZConfig]
		if !ok {
			return nil, failure("ptz_node_mapping_unavailable")
		}
		if mapped == t.node && p.VideoSource != "" && !seenSources[p.VideoSource] {
			seenSources[p.VideoSource] = true
			t.caps.VideoSources = append(t.caps.VideoSources, p.VideoSource)
		}
	}
	n, e := c.soap(ctx, t.endpoint, ptzNS, "GetNode", "<m:NodeToken>"+escape(t.node)+"</m:NodeToken>", false)
	if e != nil {
		return nil, e
	}
	node := n.child("PTZNode")
	if node.attr("token") != t.node {
		return nil, failure("ptz_node_mismatch")
	}
	opts, e := c.soap(ctx, t.endpoint, ptzNS, "GetConfigurationOptions", "<m:ConfigurationToken>"+escape(profile.PTZConfig)+"</m:ConfigurationToken>", false)
	if e != nil {
		return nil, e
	}
	options := opts.child("PTZConfigurationOptions")
	spaces := options.child("Spaces")
	t.continuousPan = selectSpace(spaces, "ContinuousPanTiltVelocitySpace", panVelocity, true)
	t.continuousZoom = selectSpace(spaces, "ContinuousZoomVelocitySpace", zoomVelocity, false)
	t.relativePan = selectSpace(spaces, "RelativePanTiltTranslationSpace", panTranslation, true)
	t.relativeZoom = selectSpace(spaces, "RelativeZoomTranslationSpace", zoomTranslation, false)
	var minOK, maxOK bool
	t.timeoutMin, minOK = ptzDuration(options.path("PTZTimeout").text("Min"))
	t.timeoutMax, maxOK = ptzDuration(options.path("PTZTimeout").text("Max"))
	// Continuous motion requires a short, device-enforced timeout in addition to
	// the service watchdog. Relative-only devices use bounded translation steps.
	if !minOK || !maxOK || t.timeoutMax <= 0 || t.timeoutMax < t.timeoutMin || t.timeoutMin > 1500*time.Millisecond {
		if t.continuousPan != nil || t.continuousZoom != nil {
			t.caps.Reason = "ptz_timeout_unverified"
		}
		t.continuousPan = nil
		t.continuousZoom = nil
	}
	u, _ := url.Parse(c.device.URL)
	identity := strings.ToLower(u.Scheme+"://"+u.Host) + "/" + t.node
	hash := sha256.Sum256([]byte(identity))
	t.caps.Resource = hex.EncodeToString(hash[:])
	t.caps.ContinuousPanTilt = t.continuousPan != nil
	t.caps.ContinuousZoom = t.continuousZoom != nil
	t.caps.RelativePanTilt = t.relativePan != nil
	t.caps.RelativeZoom = t.relativeZoom != nil
	t.caps.PanTilt = t.caps.ContinuousPanTilt || t.caps.RelativePanTilt
	t.caps.Zoom = t.caps.ContinuousZoom || t.caps.RelativeZoom
	t.caps.Presets = number(node, "MaximumNumberOfPresets") > 0
	t.caps.PresetWrite = t.caps.Presets
	serviceCaps, err := c.soap(ctx, t.endpoint, ptzNS, "GetServiceCapabilities", "", false)
	if err == nil {
		caps := serviceCaps.child("Capabilities")
		t.caps.Position = caps.attr("StatusPosition") == "true"
		t.caps.MoveStatus = caps.attr("MoveStatus") == "true"
	}
	if !t.caps.PanTilt && !t.caps.Zoom && !t.caps.Presets {
		if t.caps.Reason == "" {
			t.caps.Reason = "ptz_spaces_unsupported"
		}
	}
	return t, nil
}
func (t *PTZTarget) Caps() PTZCapabilities { return t.caps }
func (t *PTZTarget) prefix() string {
	return "<m:ProfileToken>" + escape(t.token) + "</m:ProfileToken>"
}
func (t *PTZTarget) action(ctx context.Context, action, inner string) (*node, error) {
	return t.client.soap(ctx, t.endpoint, ptzNS, action, t.prefix()+inner, false)
}
func scalePTZ(v, min, max float64) float64 {
	if v < 0 {
		return -v * min
	}
	return v * max
}
func xyTag(s *ptzSpace, x, y float64) string {
	return fmt.Sprintf(`<tt:PanTilt x="%.8f" y="%.8f" space="%s"/>`, scalePTZ(x, s.XMin, s.XMax), scalePTZ(y, s.YMin, s.YMax), escape(s.URI))
}
func zTag(s *ptzSpace, z float64) string {
	return fmt.Sprintf(`<tt:Zoom x="%.8f" space="%s"/>`, scalePTZ(z, s.XMin, s.XMax), escape(s.URI))
}
func (t *PTZTarget) Move(ctx context.Context, v ptzcontrol.Vector, ttl time.Duration) error {
	if !v.Valid() || v.Zero() {
		return failure("ptz_invalid_vector")
	}
	if (v.Pan != 0 || v.Tilt != 0) && !t.caps.PanTilt || v.Zoom != 0 && !t.caps.Zoom {
		return failure("ptz_operation_unsupported")
	}
	continuous := ""
	relative := ""
	if v.Pan != 0 || v.Tilt != 0 {
		if t.continuousPan != nil {
			continuous += xyTag(t.continuousPan, v.Pan, v.Tilt)
		} else {
			relative += xyTag(t.relativePan, v.Pan*.02, v.Tilt*.02)
		}
	}
	if v.Zoom != 0 {
		if t.continuousZoom != nil {
			continuous += zTag(t.continuousZoom, v.Zoom)
		} else {
			relative += zTag(t.relativeZoom, v.Zoom*.02)
		}
	}
	if relative != "" {
		if _, e := t.action(ctx, "RelativeMove", "<m:Translation>"+relative+"</m:Translation>"); e != nil {
			return e
		}
	}
	if continuous != "" {
		if ttl <= 0 {
			return failure("ptz_command_expired")
		}
		if ttl < t.timeoutMin {
			ttl = t.timeoutMin
		}
		if ttl > t.timeoutMax {
			ttl = t.timeoutMax
		}
		_, e := t.action(ctx, "ContinuousMove", fmt.Sprintf("<m:Velocity>%s</m:Velocity><m:Timeout>PT%.3fS</m:Timeout>", continuous, ttl.Seconds()))
		return e
	}
	return nil
}
func (t *PTZTarget) Stop(ctx context.Context) error {
	// ONVIF Stop: omitted optional axes stop all supported movements, including
	// presets and zoom-only devices. Do not invent an unsupported PanTilt axis.
	_, e := t.action(ctx, "Stop", "")
	return e
}
func (t *PTZTarget) Presets(ctx context.Context) ([]PTZPreset, error) {
	if !t.caps.Presets {
		return nil, failure("ptz_presets_unsupported")
	}
	n, e := t.action(ctx, "GetPresets", "")
	if e != nil {
		return nil, e
	}
	out := []PTZPreset{}
	for _, p := range n.Children {
		if p.Name.Local != "Preset" || p.Name.Space != ptzNS {
			continue
		}
		id := p.attr("token")
		if id == "" || len(id) > 256 {
			return nil, failure("ptz_invalid_preset")
		}
		if len(out) >= 256 {
			return nil, failure("ptz_preset_limit")
		}
		out = append(out, PTZPreset{ID: id, Name: p.text("Name")})
	}
	return out, nil
}
func (t *PTZTarget) Preset(ctx context.Context, id string) error {
	items, e := t.Presets(ctx)
	if e != nil {
		return e
	}
	found := false
	for _, p := range items {
		if p.ID == id {
			found = true
		}
	}
	if !found {
		return failure("ptz_preset_not_found")
	}
	_, e = t.action(ctx, "GotoPreset", "<m:PresetToken>"+escape(id)+"</m:PresetToken>")
	return e
}
func (t *PTZTarget) SetPreset(ctx context.Context, id, name string) (string, error) {
	if !t.caps.PresetWrite || len(id) > 256 || len(name) > 100 || strings.TrimSpace(name) == "" {
		return "", failure("ptz_invalid_preset")
	}
	inner := "<m:PresetName>" + escape(name) + "</m:PresetName>"
	if id != "" {
		inner += "<m:PresetToken>" + escape(id) + "</m:PresetToken>"
	}
	n, e := t.action(ctx, "SetPreset", inner)
	if e != nil {
		return "", e
	}
	token := n.text("PresetToken")
	if token == "" || len(token) > 256 {
		return "", failure("ptz_invalid_preset")
	}
	return token, nil
}
func (t *PTZTarget) RemovePreset(ctx context.Context, id string) error {
	if !t.caps.PresetWrite || id == "" || len(id) > 256 {
		return failure("ptz_invalid_preset")
	}
	_, e := t.action(ctx, "RemovePreset", "<m:PresetToken>"+escape(id)+"</m:PresetToken>")
	return e
}
func (t *PTZTarget) Status(ctx context.Context) (PTZStatus, error) {
	n, e := t.action(ctx, "GetStatus", "")
	if e != nil {
		return PTZStatus{}, e
	}
	st := n.child("PTZStatus")
	if st == nil {
		return PTZStatus{}, failure("ptz_status_unavailable")
	}
	out := PTZStatus{PanTilt: st.path("MoveStatus").text("PanTilt"), Zoom: st.path("MoveStatus").text("Zoom")}
	p := st.child("Position")
	if p != nil {
		pos := &PTZPosition{}
		if v, ok := ptzNumber(p.child("PanTilt").attr("x")); ok {
			pos.Pan = &v
		}
		if v, ok := ptzNumber(p.child("PanTilt").attr("y")); ok {
			pos.Tilt = &v
		}
		if v, ok := ptzNumber(p.child("Zoom").attr("x")); ok {
			pos.Zoom = &v
		}
		pos.PanTiltSpace = p.child("PanTilt").attr("space")
		pos.ZoomSpace = p.child("Zoom").attr("space")
		out.Position = pos
	}
	return out, nil
}
