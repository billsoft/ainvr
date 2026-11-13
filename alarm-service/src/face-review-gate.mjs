export const faceReviewExclusion={event_kind:{$ne:'face_watchlist'},'rule.snapshot.event_kind':{$ne:'face_watchlist'},
  'analysis_evidence.face':{$exists:false}};
export const isFaceReview=event=>event?.event_kind==='face_watchlist'||event?.rule?.snapshot?.event_kind==='face_watchlist'||event?.analysis_evidence?.face!=null;
