#!/usr/bin/env python3
"""Compatibility entry point for the current alarm release audit.

Use --web-candidate, --alarm-candidate, --frontend-log and --backend-log.
The historical fixed test totals are obsolete; the shared audit verifies the
selected test evidence and exact source/artifact hashes without staging Git.
"""
from check_alarm_erp_release import main

if __name__ == '__main__':
    main()
