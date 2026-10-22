import {useLayoutEffect, type RefObject} from 'react'

/** An open tool contributes to the one arming transaction, never saves remotely.
 * flush must validate before changing the draft, and return false on failure. */
export interface WorkspaceDraft {
  flush: () => boolean
  dirty: () => boolean
}
export type WorkspaceDraftRef = RefObject<WorkspaceDraft | null>

export function useWorkspaceDraft(ref: WorkspaceDraftRef | undefined, value: WorkspaceDraft) {
  useLayoutEffect(() => {
    if (!ref) return
    ref.current = value
    return () => { if (ref.current === value) ref.current = null }
  })
}
