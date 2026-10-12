/** Keep recovery and diagnostics available even when business APIs are gated. */
const recoveryRoutes = new Set([
  '/license', '/config-center', '/dashboard', '/system-resources', '/about',
])

export function isLicenseRecoveryRoute(pathname: string): boolean {
  return recoveryRoutes.has(pathname.replace(/\/+$/, '') || '/')
}
