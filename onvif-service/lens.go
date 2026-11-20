package onvif

import (
	"context"
	"strconv"
	"time"
)

func standardAux(value string) bool {
	switch value {
	case "tt:Wiper|On", "tt:Wiper|Off", "tt:WashingProcedure|On", "tt:IRLamp|On", "tt:IRLamp|Off", "tt:Lamp|On", "tt:Lamp|Off":
		return true
	}
	return false
}

func (t *PTZTarget) lens(ctx context.Context, action, args string) (*node, error) {
	return t.client.soap(ctx, t.imaging, imagingNS, action, "<m:VideoSourceToken>"+escape(t.source)+"</m:VideoSourceToken>"+args, false)
}
func (t *PTZTarget) readFocusOptions(ctx context.Context) {
	options, err := t.lens(ctx, "GetMoveOptions", "")
	if err == nil {
		limits := options.path("MoveOptions", "Continuous", "Speed")
		lo, a := ptzNumber(limits.text("Min"))
		hi, b := ptzNumber(limits.text("Max"))
		if a && b && lo < 0 && hi > 0 {
			t.focusMin, t.focusMax = lo, hi
			t.caps.Focus = true
		}
	}
	options, err = t.lens(ctx, "GetOptions", "")
	if err != nil {
		return
	}
	focus := options.path("ImagingOptions", "Focus")
	if focus != nil {
		for _, mode := range focus.Children {
			if mode.Name.Space == schemaNS && mode.Name.Local == "AutoFocusModes" && mode.Text == "AUTO" {
				t.caps.AutoFocus = true
			}
		}
	}
}
func (t *PTZTarget) LensAction(ctx context.Context, action string) error {
	if standardAux(action) {
		for _, supported := range t.caps.Auxiliary {
			if supported == action {
				_, err := t.action(ctx, "SendAuxiliaryCommand", "<m:AuxiliaryData>"+escape(action)+"</m:AuxiliaryData>")
				return err
			}
		}
		return failure("ptz_operation_unsupported")
	}
	if action == "auto" && t.caps.AutoFocus {
		_, err := t.lens(ctx, "SetImagingSettings", "<m:ImagingSettings><tt:Focus><tt:AutoFocusMode>AUTO</tt:AutoFocusMode></tt:Focus></m:ImagingSettings>")
		return err
	}
	if !t.caps.Focus || (action != "near" && action != "far") {
		return failure("ptz_operation_unsupported")
	}
	speed := t.focusMax
	if action == "near" {
		speed = t.focusMin
	}
	// One small step. Stop independently even on a lost response or client disconnect.
	moveCtx, cancel := context.WithTimeout(ctx, 120*time.Millisecond)
	_, moveErr := t.lens(moveCtx, "Move", "<m:Focus><tt:Continuous><tt:Speed>"+strconv.FormatFloat(speed, 'f', -1, 64)+"</tt:Speed></tt:Continuous></m:Focus>")
	if moveErr == nil {
		<-moveCtx.Done()
	}
	cancel()
	for attempt := 0; attempt < 2; attempt++ {
		stopCtx, end := context.WithTimeout(context.Background(), 1500*time.Millisecond)
		_, err := t.lens(stopCtx, "Stop", "")
		end()
		if err == nil {
			return moveErr
		}
	}
	return failure("ptz_stop_unconfirmed")
}
