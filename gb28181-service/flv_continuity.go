package gateway

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sync/atomic"
	"time"
)

// A GB media server passes the camera's 90 kHz, 32-bit RTP clock through to its
// FLV output, so the timestamps return to zero every 13.26 hours. A copying relay
// cannot repair that: it freezes every later frame at the last timestamp and
// RTMP readers (AI, recording) stop receiving pictures while the stream still
// looks published. The gateway therefore keeps the FLV clock continuous itself.

// TimestampJump is one discontinuity closed up on the way to the relay.
type TimestampJump struct {
	From, To uint32 // incoming timestamps (ms) either side of the jump
	Count    int64  // jumps closed so far on this stream
}

const (
	// Audio may trail video by a few hundred ms when interleaved; a GB camera
	// never legitimately goes back further or pauses longer than this.
	flvBackwardTolerance = 1000
	flvForwardTolerance  = 5000
	flvDefaultFrameMs    = 40
	flvMaxTagBody        = 16 << 20
)

type flvClock struct {
	started bool
	lastIn  uint32
	lastOut int64
	offset  int64
	step    int64
	jumps   int64
}

// configTag reports sequence headers and metadata, which carry timestamp 0
// whenever they are re-sent and so must not move the clock.
func configTag(kind byte, body []byte) bool {
	switch kind {
	case 18:
		return true
	case 9:
		if len(body) < 2 {
			return true
		}
		if body[0]&0x80 != 0 { // enhanced RTMP: packet type in the low nibble
			return body[0]&0x0f == 0 || body[0]&0x0f == 4
		}
		return body[1] == 0
	case 8:
		return len(body) >= 2 && body[0]>>4 == 10 && body[1] == 0
	}
	return true
}

func (c *flvClock) next(kind byte, body []byte, in uint32, report func(TimestampJump)) uint32 {
	if configTag(kind, body) {
		if !c.started {
			return in
		}
		return uint32(c.lastOut)
	}
	if !c.started {
		c.started, c.lastIn, c.lastOut, c.step = true, in, int64(in), flvDefaultFrameMs
		return in
	}
	d := int64(in) - int64(c.lastIn)
	if d < -flvBackwardTolerance || d > flvForwardTolerance {
		// Continue one frame after the last output; keep the source's own pace after it.
		c.offset = c.lastOut + c.step - int64(in)
		c.jumps++
		if report != nil {
			report(TimestampJump{From: c.lastIn, To: in, Count: c.jumps})
		}
	} else if kind == 9 && d > 0 && d < 1000 {
		c.step = d
	}
	c.lastIn = in
	out := int64(in) + c.offset
	if out > c.lastOut {
		c.lastOut = out
	}
	return uint32(out)
}

// CopyContinuousFLV copies an FLV stream, rewriting tag timestamps so that wraps
// and jumps become one frame step. Payloads, and with them B-frame composition
// offsets, are copied unchanged. It returns when the source ends, the context is
// cancelled, or no data arrives for idle.
func CopyContinuousFLV(ctx context.Context, src io.Reader, dst io.Writer, idle time.Duration, report func(TimestampJump)) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var stalled atomic.Bool
	activity := make(chan struct{}, 1)
	go func() {
		timer := time.NewTimer(idle)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-activity:
				if !timer.Stop() {
					<-timer.C
				}
				timer.Reset(idle)
			case <-timer.C:
				stalled.Store(true)
				cancel()
				if c, ok := src.(io.Closer); ok {
					_ = c.Close()
				}
				return
			}
		}
	}()
	result := make(chan error, 1)
	go func() { result <- copyFLV(bufio.NewReaderSize(&touchReader{src, activity}, 256<<10), dst, report) }()
	select {
	case err := <-result:
		if stalled.Load() {
			return fmt.Errorf("no media for %s", idle)
		}
		return err
	case <-ctx.Done():
		if stalled.Load() {
			return fmt.Errorf("no media for %s", idle)
		}
		return ctx.Err()
	}
}

type touchReader struct {
	r        io.Reader
	activity chan struct{}
}

func (t *touchReader) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	if n > 0 {
		select {
		case t.activity <- struct{}{}:
		default:
		}
	}
	return n, err
}

func copyFLV(r *bufio.Reader, w io.Writer, report func(TimestampJump)) error {
	header := make([]byte, 13)
	if _, err := io.ReadFull(r, header); err != nil {
		return err
	}
	if string(header[:3]) != "FLV" || binary.BigEndian.Uint32(header[5:9]) != 9 {
		return errors.New("source is not FLV")
	}
	if _, err := w.Write(header); err != nil {
		return err
	}
	var clock flvClock
	tagHead := make([]byte, 11)
	for {
		if _, err := io.ReadFull(r, tagHead); err != nil {
			return err
		}
		size := int(tagHead[1])<<16 | int(tagHead[2])<<8 | int(tagHead[3])
		if size > flvMaxTagBody {
			return errors.New("FLV tag too large")
		}
		rest := make([]byte, size+4)
		if _, err := io.ReadFull(r, rest); err != nil {
			return err
		}
		in := uint32(tagHead[4])<<16 | uint32(tagHead[5])<<8 | uint32(tagHead[6]) | uint32(tagHead[7])<<24
		out := in
		if tagHead[0] == 8 || tagHead[0] == 9 || tagHead[0] == 18 {
			out = clock.next(tagHead[0], rest[:size], in, report)
		}
		tagHead[4], tagHead[5], tagHead[6], tagHead[7] = byte(out>>16), byte(out>>8), byte(out), byte(out>>24)
		if _, err := w.Write(tagHead); err != nil {
			return err
		}
		if _, err := w.Write(rest); err != nil {
			return err
		}
	}
}
