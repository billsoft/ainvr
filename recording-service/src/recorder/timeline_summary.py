"""Opt-in timeline coverage. Raw timestamps and frame metadata are never changed."""
import hashlib
import json
from collections import OrderedDict


class TimelineSummaryCache:
    def __init__(self, max_bytes=8 * 1024 * 1024, max_entries=2048):
        self.max_bytes = max_bytes
        self.max_entries = max_entries
        self.bytes = 0
        self.rows = OrderedDict()

    def get(self, raw, bucket_ms, duration_ms):
        if not raw:
            return []
        key = (hashlib.sha256(raw.encode()).digest(), bucket_ms, duration_ms)
        cached = self.rows.get(key)
        if cached is not None:
            self.rows.move_to_end(key)
            return cached[0]
        # Merge only for display at the explicitly requested time resolution.
        ranges = []
        for pair in json.loads(raw):
            start, end = pair
            start = max(0, int(start // bucket_ms) * bucket_ms)
            end = min(duration_ms, int(-(-end // bucket_ms)) * bucket_ms)
            if end > start:
                ranges.append((start, end))
        ranges.sort()
        merged = []
        for start, end in ranges:
            if merged and start <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end])
        # Conservative Python object overhead; do not retain raw JSON or frames.
        weight = 256 + len(merged) * 160
        if weight <= self.max_bytes:
            while self.rows and (self.bytes + weight > self.max_bytes or len(self.rows) >= self.max_entries):
                _, (_, removed) = self.rows.popitem(last=False)
                self.bytes -= removed
            self.rows[key] = (merged, weight)
            self.bytes += weight
        return merged
