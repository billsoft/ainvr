import { buildApp, type BuildAppOptions } from '../app.js';
import { LicenseClient } from '../license/licenseClient.js';
import { LicenseGate } from '../license/licenseGate.js';

// Business API tests isolate licensing explicitly. License contract tests use
// the real enabled gate; production buildApp retains its fail-closed default.
export function buildTestApp(opts: BuildAppOptions = {}) {
  const client = opts.licenseClient ?? new LicenseClient({
    transport: { request: async () => { throw new Error('License service is not provided by this test'); } },
  });
  // No external DNS in business tests; proxy-security tests can override this explicitly.
  return buildApp({ trustedProxyLookup: async () => [], requireInitialPassword: false, ingestReady: async protocol => protocol !== 'rtsp', ...opts, licenseClient: client,
    licenseGate: opts.licenseGate ?? new LicenseGate(client, { enabled: false }),
  });
}
