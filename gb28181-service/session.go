package gateway

import (
	"context"
	"errors"
	"fmt"
	"net"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
)

type LiveSession struct {
	Dialog           *sipgo.DialogClientSession
	Answer           MediaAnswer
	DeviceGeneration uint64
}

func (s *LiveSession) Close(ctx context.Context) error {
	defer s.Dialog.Close()
	return s.Dialog.Bye(ctx)
}
func (s *Server) InviteLive(ctx context.Context, deviceID, channelID, mediaIP string, lease MediaLease) (*LiveSession, error) {
	s.mu.Lock()
	st := s.states[deviceID]
	if !s.online(st, time.Now()) {
		s.mu.Unlock()
		return nil, errors.New("device not registered")
	}
	found := false
	for _, ch := range st.Catalog {
		if ch.ID == channelID && ch.Status == "ON" {
			found = true
			break
		}
	}
	if !found {
		s.mu.Unlock()
		return nil, errors.New("channel unavailable in current directory")
	}
	source, transport, generation := st.source, st.transport, st.Generation
	s.mu.Unlock()
	body, e := LiveSDP(s.config.ServerID, channelID, mediaIP, lease)
	if e != nil {
		return nil, e
	}
	req := s.request(sip.INVITE, channelID, source, transport, body, "application/sdp")
	req.AppendHeader(sip.NewHeader("Subject", liveSubject(channelID, s.config.ServerID, lease.SSRC)))
	cache := s.dialogs[transport]
	if cache == nil {
		return nil, errors.New("unsupported signaling transport")
	}
	inviteCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	dialog, e := cache.WriteInvite(inviteCtx, req)
	if e != nil {
		return nil, errors.New("invite transport failed")
	}
	if e = s.waitLiveAnswer(ctx, dialog, 8*time.Second); e != nil {
		dialog.Close()
		return nil, errors.New("invite rejected or timed out")
	}
	// ACK every final 2xx before validation cleanup, as required by SIP.
	ackCtx, ackCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer ackCancel()
	if e = dialog.Ack(ackCtx); e != nil {
		dialog.Close()
		return nil, errors.New("invite ACK failed")
	}
	closeDialog := func() {
		cleanup, c := context.WithTimeout(context.Background(), 3*time.Second)
		defer c()
		_ = dialog.Bye(cleanup)
		dialog.Close()
	}
	ip, _, e := net.SplitHostPort(source)
	if e != nil {
		closeDialog()
		return nil, errors.New("invalid registered peer")
	}
	answer, e := ParseMediaAnswer(dialog.InviteResponse.Body(), lease, ip, s.devices[deviceID].MediaIPs...)
	if e != nil {
		closeDialog()
		return nil, e
	}
	s.mu.Lock()
	current := s.states[deviceID]
	valid := s.online(current, time.Now()) && current.Generation == generation && current.source == source
	s.mu.Unlock()
	if !valid || ctx.Err() != nil {
		closeDialog()
		return nil, errors.New("obsolete invite generation")
	}
	return &LiveSession{Dialog: dialog, Answer: answer, DeviceGeneration: generation}, nil
}

// sipgo's default timeout path can wait a full SIP timer using an unbounded
// background CANCEL. Own the bounded cancellation policy while retaining its
// transaction/dialog machinery. A racing successful answer is ACKed and BYEd.
func (s *Server) waitLiveAnswer(ctx context.Context, dialog *sipgo.DialogClientSession, timeout time.Duration) error {
	answerCtx, stop := context.WithCancelCause(context.Background())
	defer stop(sipgo.WaitAnswerForceCancelErr)
	provisional := make(chan struct{}, 1)
	result := make(chan error, 1)
	cancelReq := dialog.InviteRequest.Clone()
	cancelReq.Method = sip.CANCEL
	cancelReq.CSeq().MethodName = sip.CANCEL
	cancelReq.RemoveHeader("Content-Type")
	cancelReq.SetBody(nil)
	go func() {
		result <- dialog.WaitAnswer(answerCtx, sipgo.AnswerOptions{OnResponse: func(response *sip.Response) error {
			if response.IsProvisional() {
				select {
				case provisional <- struct{}{}:
				default:
				}
			}
			return nil
		}})
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
	case <-timer.C:
	}
	cleanup, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	sent := false
	finish := func(err error) error {
		if err == nil {
			late, closeLate := context.WithTimeout(context.Background(), 3*time.Second)
			defer closeLate()
			if dialog.Ack(late) == nil {
				_ = dialog.Bye(late)
			}
		}
		return errors.New("invite cancelled or timed out")
	}
	for {
		select {
		case err := <-result:
			return finish(err)
		case <-provisional:
			if !sent {
				sent = true
				// Preserve INVITE branch and CSeq; normal client defaults may
				// increment the sequence and break CANCEL transaction matching.
				_, _ = s.client.Do(cleanup, cancelReq, func(*sipgo.Client, *sip.Request) error { return nil })
			}
		case <-cleanup.Done():
			stop(sipgo.WaitAnswerForceCancelErr)
			return finish(<-result)
		}
	}
}

// Annex L: the source sequence identifies a video, not a random RTP session.
// This gateway requests one default live stream per channel. "0" is stable
// across retries; the receiver sequence distinguishes concurrent media leases.
func liveSubject(channelID, serverID string, ssrc uint32) string {
	return fmt.Sprintf("%s:0,%s:%010d", channelID, serverID, ssrc)
}
