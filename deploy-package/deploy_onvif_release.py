#!/usr/bin/env python3
"""Compatibility entrypoint for the retired pre-PTZ ONVIF publisher.

The old publisher cannot safely restore persistent PTZ view guards. Production
updates now use the coordinated publisher and mounted SSD backup policy.
"""
if __name__ == '__main__':
 raise SystemExit('This legacy publisher is retired. Use build-onvif-release.py, prepare-ptz-components.py, then deploy_ptz_release.py --check/--apply. Roll back using its SSD deployment.json. No services changed.')
