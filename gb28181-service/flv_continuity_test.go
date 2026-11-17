package gateway

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

// flvTag builds one FLV tag with its trailing previous-tag-size field.
func flvTag(kind byte, ts uint32, body []byte) []byte {
	head := []byte{kind, byte(len(body) >> 16), byte(len(body) >> 8), byte(len(body)), byte(ts >> 16), byte(ts >> 8), byte(ts), byte(ts >> 24), 0, 0, 0}
	out := append(head, body...)
	size := make([]byte, 4)
	binary.BigEndian.PutUint32(size, uint32(len(head)+len(body)))
	return append(out, size...)
}

func flvHeader() []byte { return []byte{'F', 'L', 'V', 1, 5, 0, 0, 0, 9, 0, 0, 0, 0} }

// AVC NALU tag: frame type, packet type 1, composition time (pts-dts) in ms, payload.
func avcFrame(key bool, cts int32, n byte) []byte {
	first := byte(0x27)
	if key {
		first = 0x17
	}
	return []byte{first, 1, byte(cts >> 16), byte(cts >> 8), byte(cts), 0, 0, 0, 1, n}
}

var avcHeader = []byte{0x17, 0, 0, 0, 0, 1, 0x64, 0, 0x1f}
var aacHeader = []byte{0xaf, 0, 0x12, 0x10}

func aacFrame(n byte) []byte { return []byte{0xaf, 1, n} }

type parsedTag struct {
	kind byte
	ts   uint32
	body []byte
}

func parseTags(t *testing.T, data []byte) []parsedTag {
	t.Helper()
	if len(data) < 13 || string(data[:3]) != "FLV" {
		t.Fatal("output lost the FLV header")
	}
	var tags []parsedTag
	pos := 13
	for pos < len(data) {
		size := int(data[pos+1])<<16 | int(data[pos+2])<<8 | int(data[pos+3])
		ts := uint32(data[pos+4])<<16 | uint32(data[pos+5])<<8 | uint32(data[pos+6]) | uint32(data[pos+7])<<24
		tags = append(tags, parsedTag{data[pos], ts, append([]byte(nil), data[pos+11:pos+11+size]...)})
		if binary.BigEndian.Uint32(data[pos+11+size:]) != uint32(11+size) {
			t.Fatal("previous tag size not preserved")
		}
		pos += 15 + size
	}
	return tags
}

func run(t *testing.T, in []byte) ([]parsedTag, []TimestampJump) {
	t.Helper()
	var out bytes.Buffer
	var jumps []TimestampJump
	err := CopyContinuousFLV(context.Background(), bytes.NewReader(in), &out, time.Second, func(j TimestampJump) { jumps = append(jumps, j) })
	if err != nil && !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
	return parseTags(t, out.Bytes()), jumps
}

// A GB media server passes the camera's 32-bit 90 kHz RTP clock through, which
// returns to zero every 13.26 h. Downstream timestamps must keep going forward.
func TestRTPClockWrapKeepsTimestampsContinuous(t *testing.T) {
	in := flvHeader()
	in = append(in, flvTag(18, 0, []byte{2, 0, 10})...)
	in = append(in, flvTag(9, 0, avcHeader)...)
	const near = 47721858 - 200 // ms just before a 2^32/90 kHz wrap
	var ts []uint32
	for i := 0; i < 5; i++ {
		ts = append(ts, near+uint32(i*40))
	}
	for i := 0; i <= 50; i++ { // first wrap, then 2 s of media
		ts = append(ts, uint32(i*40))
	}
	for i := 0; i < 5; i++ { // a later wrap (any jump back beyond interleaving)
		ts = append(ts, uint32(i*40))
	}
	for i, v := range ts {
		in = append(in, flvTag(9, v, avcFrame(i%5 == 0, 80, byte(i)))...)
	}
	tags, jumps := run(t, in)
	var video []parsedTag
	for _, tag := range tags {
		if tag.kind == 9 && tag.body[1] == 1 {
			video = append(video, tag)
		}
	}
	if len(video) != len(ts) {
		t.Fatalf("frames lost: %d of %d", len(video), len(ts))
	}
	for i := 1; i < len(video); i++ {
		if d := int64(video[i].ts) - int64(video[i-1].ts); d != 40 {
			t.Fatalf("frame %d: step %d ms, want 40 (ts %d -> %d)", i, d, video[i-1].ts, video[i].ts)
		}
	}
	if video[0].ts != near {
		t.Fatalf("timestamps before the first wrap were changed: %d", video[0].ts)
	}
	for i, tag := range video {
		if !bytes.Equal(tag.body, avcFrame(i%5 == 0, 80, byte(i))) {
			t.Fatal("frame payload or B-frame composition offset changed")
		}
	}
	if len(jumps) != 2 || jumps[0].From != near+160 || jumps[0].To != 0 {
		t.Fatalf("each wrap must be reported once: %+v", jumps)
	}
}

// Audio and video interleave slightly out of order; that is not a discontinuity.
func TestInterleavedAudioIsNotAJump(t *testing.T) {
	in := flvHeader()
	in = append(in, flvTag(9, 0, avcHeader)...)
	in = append(in, flvTag(8, 0, aacHeader)...)
	for i := 0; i < 20; i++ {
		v := uint32(1000 + i*40)
		in = append(in, flvTag(9, v, avcFrame(i == 0, 0, byte(i)))...)
		in = append(in, flvTag(8, v-300, aacFrame(byte(i)))...) // audio 300 ms behind
	}
	tags, jumps := run(t, in)
	if len(jumps) != 0 {
		t.Fatalf("interleaving reported as discontinuity: %+v", jumps)
	}
	for _, tag := range tags {
		if tag.body[1] == 1 && tag.kind == 8 && tag.ts%40 != 700%40 {
			t.Fatal("audio timestamps altered without a discontinuity")
		}
	}
}

// Sequence headers re-sent mid-stream carry timestamp 0; they must not move the clock.
func TestMidStreamSequenceHeaderDoesNotMoveClock(t *testing.T) {
	in := flvHeader()
	in = append(in, flvTag(9, 0, avcHeader)...)
	for i := 0; i < 10; i++ {
		if i == 5 {
			in = append(in, flvTag(9, 0, avcHeader)...)
		}
		in = append(in, flvTag(9, uint32(5000+i*40), avcFrame(i%5 == 0, 0, byte(i)))...)
	}
	tags, jumps := run(t, in)
	if len(jumps) != 0 {
		t.Fatalf("sequence header treated as a jump: %+v", jumps)
	}
	last := uint32(0)
	for _, tag := range tags[1:] {
		if tag.ts < last {
			t.Fatalf("timestamps went backwards: %d after %d", tag.ts, last)
		}
		last = tag.ts
	}
	if last != 5000+9*40 {
		t.Fatalf("media timestamps changed: %d", last)
	}
}

// A large forward jump (source restart, clock step) is also closed up.
func TestForwardJumpIsClosed(t *testing.T) {
	in := flvHeader()
	for i, v := range []uint32{1000, 1040, 1080, 900000, 900040} {
		in = append(in, flvTag(9, v, avcFrame(i == 0, 0, byte(i)))...)
	}
	tags, jumps := run(t, in)
	if tags[3].ts != 1120 || tags[4].ts != 1160 || len(jumps) != 1 {
		t.Fatalf("forward jump not closed: %d %d %+v", tags[3].ts, tags[4].ts, jumps)
	}
}

// A source that stops sending must end the copy so the supervisor reconnects.
func TestStalledSourceEndsTheCopy(t *testing.T) {
	r, w := io.Pipe()
	defer w.Close()
	go func() { _, _ = w.Write(flvHeader()) }()
	start := time.Now()
	err := CopyContinuousFLV(context.Background(), r, io.Discard, 200*time.Millisecond, nil)
	if err == nil || !strings.Contains(err.Error(), "no media") || time.Since(start) > 2*time.Second {
		t.Fatalf("stall not detected: %v after %s", err, time.Since(start))
	}
}

func TestMalformedInputIsRejected(t *testing.T) {
	err := CopyContinuousFLV(context.Background(), bytes.NewReader([]byte("not flv at all")), io.Discard, time.Second, nil)
	if err == nil {
		t.Fatal("malformed input accepted")
	}
}
