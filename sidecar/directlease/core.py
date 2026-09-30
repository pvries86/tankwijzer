"""Conservative quote service around the pyfuelprices DirectLease source.

Only normal library calls are used (source.update() for the station list and
site.dynamic_build_fuels() for one station's prices). This module adds, on top of the
library's own ~24 h per-station interval:
  * an on-demand model: only stations the app actually compares are requested,
  * a persistent 24 h quote cache, a per-request cap, a daily budget and a minimum interval,
  * a hard stop when DirectLease signals a block (HTTP 403): no further requests are made
    until the operator removes blocked.json after resolving it with App It Up.
No IP/VPN/proxy changes, header changes or retries are ever attempted.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import time
from datetime import datetime, timezone

LOG = logging.getLogger("directlease-sidecar")

BLOCK_MARKERS = ("blocked your ip", "breaching license")
# format string of pyfuelprices' DirectLease debug log line for each station request
STATUS_LOG_FORMAT = "Got status code %s for dynamic parse of site %s"


def iso(ts: float | None) -> str | None:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat().replace("+00:00", "Z") if ts else None


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


class BlockDetector(logging.Handler):
    """The library only *logs* a per-station 403; trip a flag when that message appears."""

    def __init__(self):
        # DEBUG: the library logs the raw status code of every station request at debug level,
        # which detects a 403 even if the wording of its error message changes.
        super().__init__(logging.DEBUG)
        self.tripped = False
        self.message = None

    def emit(self, record):
        if record.msg == STATUS_LOG_FORMAT and record.args and record.args[0] == 403:
            self.tripped = True
            self.message = self.message or "HTTP 403 on a station request"
            return
        if record.levelno < logging.WARNING:
            return
        msg = record.getMessage()
        if any(m in msg.lower() for m in BLOCK_MARKERS):
            self.tripped = True
            self.message = "HTTP 403: " + msg


def fuels_of(site) -> dict:
    """Library-parsed fuels keyed by the code in parentheses. Only used as a fallback: the library
    lets e.g. 'Premium Diesel (B7)' overwrite 'Diesel (B7)', so these codes can be ambiguous."""
    out = {}
    for f in getattr(site, "available_fuels", None) or []:
        cost = getattr(f, "cost", None)
        props = getattr(f, "props", None) or {}
        if isinstance(cost, (int, float)) and cost > 0 and not props.get("unavailable"):
            out[str(f.fuel_type).upper()] = round(float(cost), 4)
    return out


class RawFuelCapture(logging.Handler):
    """Collects the raw fuel entries the library itself logs ("Parsing fuel %s") while it parses a
    station response. This observes normal library operation; it does not alter any request."""

    def __init__(self):
        super().__init__(logging.DEBUG)
        self.entries = []

    def emit(self, record):
        if record.msg == "Parsing fuel %s" and record.args:
            arg = record.args[0] if isinstance(record.args, tuple) else record.args
            if isinstance(arg, dict):
                self.entries.append(arg)


def fuels_from_raw(entries) -> dict:
    """{directlease_key: {"price": EUR/L, "name": label}} from raw entries (price is in 1/1000 EUR)."""
    out = {}
    for e in entries:
        key, price = e.get("key"), e.get("price")
        if isinstance(key, str) and isinstance(price, (int, float)) and price > 0:
            out[key] = {"price": round(price / 1000, 4), "name": str(e.get("name") or key)[:60]}
    return out


QUOTE_SCHEMA = 2


class QuoteService:
    def __init__(self, source, detector: BlockDetector, *, data_dir: str, capture=None,
                 ttl_s=86400, places_ttl_s=86400, match_m=150.0, min_interval_s=1.5,
                 max_fetch_per_request=15, daily_budget=200, error_backoff_s=3600,
                 max_points=60, clock=time.time, sleep=asyncio.sleep, paused_reason=None):
        self.source = source
        # Operator switch: behave exactly like a block (no requests at all) without a 403 having been seen
        # here, e.g. when App It Up has blocked the connection. Not persisted: unset it to resume.
        self.paused = {"at": iso(clock()), "paused": True, "reason": str(paused_reason)} if paused_reason else None
        self.detector = detector
        self.capture = capture
        self.data_dir = data_dir
        self.ttl_s = max(ttl_s, 3600)
        self.places_ttl_s = max(places_ttl_s, 86400)
        self.match_m = match_m
        self.min_interval_s = max(min_interval_s, 0.5)
        self.max_fetch = max_fetch_per_request
        self.daily_budget = daily_budget
        self.error_backoff_s = error_backoff_s
        self.max_points = max_points
        self.clock = clock
        self.sleep = sleep
        self.lock = asyncio.Lock()
        self.places_at = None
        self.backoff_until = 0.0
        self.last_error = None
        self.last_request_at = 0.0
        os.makedirs(data_dir, exist_ok=True)
        self.blocked = self._read("blocked.json")
        state = self._read("state.json") or {}
        self.quotes = {k: v for k, v in state.get("quotes", {}).items() if v.get("schema") == QUOTE_SCHEMA}
        self.budget = state.get("budget", {"day": None, "count": 0})

    # ------------------------------------------------------------------ persistence
    def _path(self, name):
        return os.path.join(self.data_dir, name)

    def _read(self, name):
        try:
            with open(self._path(name), encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return None

    def _write(self, name, data):
        tmp = self._path(name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        os.replace(tmp, self._path(name))

    def _save(self):
        self._write("state.json", {"quotes": self.quotes, "budget": self.budget})

    def _set_blocked(self, reason):
        self.blocked = {"at": iso(self.clock()), "httpStatus": 403, "reason": str(reason)[:300]}
        self._write("blocked.json", self.blocked)
        LOG.error("DirectLease access blocked (%s). All requests stopped. Contact "
                  "tankservice-block@app-it-up.com; remove blocked.json only after it is resolved.", reason)

    def _reload_block(self):
        # the operator clears a block by deleting blocked.json (after resolving it with App It Up)
        self.blocked = self._read("blocked.json") or self.paused
        if not self.blocked:
            self.detector.tripped = False

    # ------------------------------------------------------------------ status
    def status(self):
        self._reload_block()
        day = time.strftime("%Y-%m-%d", time.gmtime(self.clock()))
        return {
            "ok": not self.blocked,
            "blocked": self.blocked,
            "placesFetchedAt": iso(self.places_at),
            "sites": len(self._sites()),
            "cachedQuotes": len(self.quotes),
            "requestsToday": self.budget["count"] if self.budget.get("day") == day else 0,
            "dailyBudget": self.daily_budget,
            "backoffUntil": iso(self.backoff_until) if self.backoff_until > self.clock() else None,
            "lastError": self.last_error,
            "cacheTtlHours": self.ttl_s / 3600,
        }

    def _sites(self):
        return getattr(self.source, "location_cache", None) or {}

    # ------------------------------------------------------------------ request accounting
    def _budget_left(self):
        day = time.strftime("%Y-%m-%d", time.gmtime(self.clock()))
        if self.budget.get("day") != day:
            self.budget = {"day": day, "count": 0}
        return self.daily_budget - self.budget["count"]

    def _count_request(self):
        self._budget_left()
        self.budget["count"] += 1

    async def _pace(self):
        wait = self.last_request_at + self.min_interval_s - self.clock()
        if wait > 0:
            await self.sleep(wait)
        self.last_request_at = self.clock()

    def _why_not(self, fetched_now):
        if self.blocked:
            return "blocked"
        if self.backoff_until > self.clock():
            return "error-backoff"
        if self._budget_left() <= 0:
            return "daily-budget"
        if fetched_now >= self.max_fetch:
            return "request-limit"
        return None

    def _fail(self, msg):
        self.last_error = {"at": iso(self.clock()), "message": msg[:300]}
        self.backoff_until = self.clock() + self.error_backoff_s
        LOG.warning("%s; pausing DirectLease requests for %ss", msg, self.error_backoff_s)

    # ------------------------------------------------------------------ station list
    async def _ensure_places(self):
        now = self.clock()
        if self.places_at and now - self.places_at < self.places_ttl_s and self._sites():
            return
        if self.blocked or self.backoff_until > now or self._budget_left() <= 0:
            return
        await self._pace()
        self._count_request()
        # pyfuelprices' parse_response re-requests *every* cached site that already has fuels
        # (unpaced, outside our budget). Refresh against an empty cache so the list refresh is one
        # request; our own quote cache (self.quotes) is unaffected. Restore the old list on failure.
        cache = getattr(self.source, "location_cache", None)
        previous = dict(cache) if cache else {}
        if cache is not None:
            cache.clear()
        try:
            await self.source.update()
        except Exception as err:  # noqa: BLE001 - classified below
            if cache is not None and not cache:
                cache.update(previous)
            status = getattr(err, "status", None)
            if status == 403 or type(err).__name__ == "ServiceBlocked":
                self._set_blocked(f"station list request returned HTTP {status or 403}")
            else:
                self._fail(f"station list update failed: {type(err).__name__}: {err}")
            self._save()
            return
        if self.detector.tripped:
            self._set_blocked(self.detector.message)
        elif not self._sites():
            # the library swallows non-403 HTTP errors and leaves the list empty
            if cache is not None:
                cache.update(previous)
            self._fail("station list update returned no stations")
        else:
            self.places_at = self.clock()
            self.last_error = None
        self._save()

    def _nearest(self, lat, lon):
        best, best_d = None, None
        for sid, site in self._sites().items():
            try:
                d = haversine_m(lat, lon, float(site.lat), float(site.long))
            except (TypeError, ValueError):
                continue
            if best_d is None or d < best_d:
                best, best_d = (sid, site), d
        return best, best_d

    # ------------------------------------------------------------------ main entry
    async def lookup(self, points):
        async with self.lock:
            self._reload_block()
            await self._ensure_places()
            results = {}
            fetched_now = 0
            for pt in (points or [])[: self.max_points]:
                pid = str(pt.get("id"))
                try:
                    lat, lon = float(pt["lat"]), float(pt["lon"])
                except (KeyError, TypeError, ValueError):
                    results[pid] = {"match": None, "reason": "invalid-point"}
                    continue
                if not self._sites():
                    results[pid] = {"match": None, "reason": "station-list-unavailable"}
                    continue
                found, dist = self._nearest(lat, lon)
                if not found or dist > self.match_m:
                    results[pid] = {"match": None, "reason": "no-directlease-station-nearby",
                                    "nearestM": round(dist) if dist is not None else None}
                    continue
                sid, site = found
                q = self.quotes.get(sid)
                fresh = bool(q) and self.clock() - q["fetchedTs"] < self.ttl_s
                reason = None
                if not fresh:
                    reason = self._why_not(fetched_now)
                    if reason is None:
                        fetched_now += 1
                        q = await self._fetch_site(sid, site, q)
                        fresh = bool(q) and self.clock() - q["fetchedTs"] < self.ttl_s
                        if not fresh:
                            reason = "blocked" if self.blocked else "fetch-failed"
                results[pid] = {
                    "match": {
                        "siteId": sid,
                        "name": getattr(site, "_name", None) or (q or {}).get("name"),
                        "brand": getattr(site, "_brand", None) or (q or {}).get("brand"),
                        "distanceM": round(dist),
                    },
                    "fuels": (q or {}).get("fuels", {}),
                    "codes": (q or {}).get("codes", {}),
                    "parsed": (q or {}).get("parsed"),
                    "fetchedAt": iso((q or {}).get("fetchedTs")),
                    "fresh": fresh,
                    "reason": reason,
                }
            self._save()
            return {"status": self.status(), "results": results}

    async def _fetch_site(self, sid, site, previous):
        before = getattr(site, "next_update", None)
        await self._pace()
        self._count_request()
        if self.capture is not None:
            self.capture.entries = []
        try:
            await site.dynamic_build_fuels()
        except Exception as err:  # noqa: BLE001
            self._fail(f"station {sid} request failed: {type(err).__name__}: {err}")
            return previous
        if self.detector.tripped:
            self._set_blocked(self.detector.message)
            return previous
        if getattr(site, "next_update", None) == before and previous:
            # the library skipped the request (its own interval not yet elapsed): keep the real timestamp
            return previous
        raw = fuels_from_raw(self.capture.entries) if self.capture is not None else {}
        q = {"schema": QUOTE_SCHEMA, "fetchedTs": self.clock(),
             "fuels": raw, "codes": fuels_of(site), "parsed": "raw" if raw else "library-codes",
             "name": getattr(site, "_name", None), "brand": getattr(site, "_brand", None)}
        self.quotes[sid] = q
        return q
