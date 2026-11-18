/**
 * How a live player recovers on its own after the network or a source drops.
 *
 * A browser page may hold only a limited number of WebRTC connections (about 500 in Chrome), and a closed
 * connection keeps its place until the browser frees it. Every retry builds a connection, so a page that
 * retries blindly through a long outage or a dead source can use up the whole allowance; after that no player
 * on the page can connect again until it reloads. So: retry only when the server can be reached, slow down
 * while a source keeps failing, and if the allowance is gone anyway, reload the page once.
 */

/** Wait before the n-th consecutive automatic retry: 5 s doubling, at most a minute. */
export function retryDelay(failures: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, failures - 1))
}

/**
 * One light request decides whether a retry can possibly work. An expired login still counts as reachable:
 * the play request renews it. No connection is built while this is false.
 */
export async function mediaServerReachable(timeoutMs = 3_000): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/media-check', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(timeoutMs) })
    return res.status < 500
  } catch {
    return false
  }
}

/** The browser refuses new connections for this page: only a reload frees them. */
export function connectionCapReached(error: unknown): boolean {
  return /Cannot create so many PeerConnections/i.test(error instanceof Error ? error.message : String(error))
}

const RELOAD_KEY = 'ainvr.player.capReloadAt'
const RELOAD_EVERY_MS = 10 * 60_000
/** Reload the page so a wall display gets its pictures back, at most once in ten minutes. */
export function recoverFromConnectionCap(reload: () => void = () => window.location.reload(), now = Date.now()): boolean {
  let last = 0
  try { last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0 } catch { /* storage blocked: still reload once */ }
  if (last && now - last < RELOAD_EVERY_MS) return false
  try { sessionStorage.setItem(RELOAD_KEY, String(now)) } catch { /* ignore */ }
  reload()
  return true
}
