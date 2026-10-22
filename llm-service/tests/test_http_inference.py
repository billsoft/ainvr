"""Compatibility entry point for the residency-safe hardware test.

Stops and restores model/AI services; never reads obsolete telemetry files.
"""
from test_residency_hardware import main

if __name__ == '__main__':
    main()
