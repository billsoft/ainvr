// AI reference analysis in smart search shares the large model with alarm review, which has priority.
// Paused: searches do not request it and the page does not show or poll it. Set to false to bring it back.
export const AI_REFERENCE_PAUSED = true
export const aiReferenceEnabled = () => !AI_REFERENCE_PAUSED
