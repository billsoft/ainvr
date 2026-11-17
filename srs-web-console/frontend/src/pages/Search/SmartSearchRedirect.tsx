import { Navigate, useSearchParams } from 'react-router-dom'
import { searchEntryScope, searchInPlaybackHref } from '@/features/searchNavigation'

/** The old stand-alone address keeps working: it opens the same search beside the recording player. */
export function SmartSearchRedirect() {
  const [params] = useSearchParams()
  const scope = searchEntryScope(params)
  const href = scope && searchInPlaybackHref(scope.channel_ids[0], Date.parse(scope.from), Date.parse(scope.to))
  return <Navigate to={href || '/playback?search=1'} replace />
}
