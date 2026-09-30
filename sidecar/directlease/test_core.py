import asyncio
import logging
import tempfile
import unittest

from core import BlockDetector, QuoteService, RawFuelCapture, fuels_from_raw, fuels_of

LOGGER = logging.getLogger("pyfuelprices.test")


class Fuel:
    def __init__(self, fuel_type, cost, props=None):
        self.fuel_type, self.cost, self.props = fuel_type, cost, props or {}


class Site:
    def __init__(self, lat, lon, fuels, logger=None, block=False, raise_exc=None):
        self.lat, self.long = lat, lon
        self._name, self._brand = "Test", "Brand"
        self.available_fuels = []
        self.next_update = 0
        self._fuels, self.calls = fuels, 0
        self.logger, self.block, self.raise_exc = logger, block, raise_exc

    async def dynamic_build_fuels(self):
        self.calls += 1
        if self.raise_exc:
            raise self.raise_exc
        if self.block == "status-only":
            self.logger.debug("Got status code %s for dynamic parse of site %s", 403, "x")
        elif self.block:
            self.logger.error("This service has blocked your IP due to breaching license conditions.")
        else:
            for k, v in self._fuels.items():
                LOGGER.debug("Parsing fuel %s", {"key": k, "name": k.upper(), "price": round(v * 1000)})
            self.available_fuels = [Fuel(k.upper(), v) for k, v in self._fuels.items()]
        self.next_update += 1


class Source:
    def __init__(self, sites, exc=None):
        self.location_cache, self._sites, self.exc, self.calls = {}, sites, exc, 0

    async def update(self):
        self.calls += 1
        if self.exc:
            raise self.exc
        self.location_cache.update(self._sites)


class Blocked(Exception):
    status = 403


class Clock:
    def __init__(self):
        self.t = 1_800_000_000.0

    def __call__(self):
        return self.t

    async def sleep(self, s):
        self.t += s


def run(coro):
    return asyncio.run(coro)


class QuoteServiceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.logger = LOGGER
        self.logger.setLevel(logging.DEBUG)
        self.detector = BlockDetector()
        self.capture = RawFuelCapture()
        self.logger.addHandler(self.detector)
        self.logger.addHandler(self.capture)
        self.clock = Clock()

    def tearDown(self):
        self.logger.removeHandler(self.detector)
        self.logger.removeHandler(self.capture)

    def svc(self, source, **kw):
        return QuoteService(source, self.detector, data_dir=self.tmp, capture=self.capture, clock=self.clock, sleep=self.clock.sleep, **kw)

    def test_fuel_mapping_skips_unavailable_and_zero(self):
        site = Site(0, 0, {})
        site.available_fuels = [Fuel("e10", 1.999), Fuel("B7", 0), Fuel("LPG", 0.9, {"unavailable": True})]
        self.assertEqual(fuels_of(site), {"E10": 1.999})

    def test_raw_mapping_keeps_premium_separate(self):
        # real DirectLease entries: the library would map both diesels to "B7" (last one wins)
        raw = [{"key": "e10", "name": "Euro 95 (E10)", "price": 2539},
               {"key": "diesel", "name": "Diesel (B7)", "price": 2589},
               {"key": "euro98", "name": "Euro 98 (E5)", "price": 2869},
               {"key": "diesel_special", "name": "Premium Diesel (B7)", "price": 2809},
               {"key": "lpg", "name": "LPG", "price": None}]
        out = fuels_from_raw(raw)
        self.assertEqual(out["diesel"]["price"], 2.589)
        self.assertEqual(out["diesel_special"]["price"], 2.809)
        self.assertEqual(out["euro98"]["price"], 2.869)
        self.assertNotIn("lpg", out)

    def test_old_schema_quotes_are_discarded(self):
        import json, os
        with open(os.path.join(self.tmp, "state.json"), "w") as fh:
            json.dump({"quotes": {"s": {"fuels": {"B7": 2.8}, "fetchedTs": self.clock.t}}}, fh)
        site = Site(51.44, 4.93, {"diesel": 2.589})
        out = run(self.svc(Source({"s": site})).lookup([{"id": "a", "lat": 51.44, "lon": 4.93}]))
        self.assertEqual(site.calls, 1)
        self.assertEqual(out["results"]["a"]["fuels"]["diesel"]["price"], 2.589)

    def test_match_fetch_and_cache(self):
        site = Site(51.44, 4.93, {"E10": 1.899, "B7": 1.759})
        svc = self.svc(Source({"directlease_1": site}))
        out = run(svc.lookup([{"id": "a", "lat": 51.4405, "lon": 4.9301}, {"id": "far", "lat": 51.6, "lon": 4.9}]))
        a = out["results"]["a"]
        self.assertEqual(a["match"]["siteId"], "directlease_1")
        self.assertEqual(a["fuels"], {"E10": {"price": 1.899, "name": "E10"}, "B7": {"price": 1.759, "name": "B7"}})
        self.assertEqual(a["parsed"], "raw")
        self.assertTrue(a["fresh"])
        self.assertIsNone(out["results"]["far"]["match"])
        # second lookup within TTL: no new station request
        self.clock.t += 3600
        run(svc.lookup([{"id": "a", "lat": 51.44, "lon": 4.93}]))
        self.assertEqual(site.calls, 1)
        # after TTL: refreshed once
        self.clock.t += 24 * 3600
        run(svc.lookup([{"id": "a", "lat": 51.44, "lon": 4.93}]))
        self.assertEqual(site.calls, 2)

    def test_cache_persists_across_restart(self):
        site = Site(51.44, 4.93, {"E10": 1.9})
        run(self.svc(Source({"s": site})).lookup([{"id": "a", "lat": 51.44, "lon": 4.93}]))
        site2 = Site(51.44, 4.93, {"E10": 1.9})
        out = run(self.svc(Source({"s": site2})).lookup([{"id": "a", "lat": 51.44, "lon": 4.93}]))
        self.assertEqual(site2.calls, 0)
        self.assertEqual(out["results"]["a"]["fuels"]["E10"]["price"], 1.9)

    def test_station_block_stops_everything_and_persists(self):
        s1 = Site(51.0, 5.0, {}, logger=self.logger, block=True)
        s2 = Site(51.1, 5.0, {"E10": 2.0})
        src = Source({"s1": s1, "s2": s2})
        out = run(self.svc(src).lookup([{"id": "1", "lat": 51.0, "lon": 5.0}, {"id": "2", "lat": 51.1, "lon": 5.0}]))
        self.assertTrue(out["status"]["blocked"])
        self.assertEqual(s2.calls, 0)
        self.assertEqual(out["results"]["2"]["reason"], "blocked")
        # a restarted service stays blocked and makes no requests at all
        src2 = Source({"s2": Site(51.1, 5.0, {"E10": 2.0})})
        out2 = run(self.svc(src2).lookup([{"id": "2", "lat": 51.1, "lon": 5.0}]))
        self.assertEqual(src2.calls, 0)
        self.assertTrue(out2["status"]["blocked"])

    def test_station_403_detected_from_status_log(self):
        s1 = Site(51.0, 5.0, {}, logger=self.logger, block="status-only")
        s2 = Site(51.1, 5.0, {"E10": 2.0})
        out = run(self.svc(Source({"s1": s1, "s2": s2})).lookup(
            [{"id": "1", "lat": 51.0, "lon": 5.0}, {"id": "2", "lat": 51.1, "lon": 5.0}]))
        self.assertEqual(out["status"]["blocked"]["httpStatus"], 403)
        self.assertEqual(s2.calls, 0)

    def test_unrelated_debug_status_does_not_block(self):
        self.logger.debug("Got status code %s for dynamic parse of site %s", 200, "x")
        self.logger.error("Some other error")
        self.assertFalse(self.detector.tripped)

    def test_paused_makes_no_requests_and_is_not_persisted(self):
        site = Site(51.0, 5.0, {"E10": 2.0})
        src = Source({"s": site})
        out = run(self.svc(src, paused_reason="operator").lookup([{"id": "1", "lat": 51.0, "lon": 5.0}]))
        self.assertTrue(out["status"]["blocked"]["paused"])
        self.assertEqual((src.calls, site.calls), (0, 0))
        out2 = run(self.svc(src).lookup([{"id": "1", "lat": 51.0, "lon": 5.0}]))
        self.assertFalse(out2["status"]["blocked"])
        self.assertEqual(site.calls, 1)

    def test_places_403_blocks(self):
        src = Source({}, exc=Blocked("forbidden"))
        svc = self.svc(src)
        out = run(svc.lookup([{"id": "x", "lat": 51, "lon": 5}]))
        self.assertTrue(out["status"]["blocked"])
        self.assertEqual(out["results"]["x"]["reason"], "station-list-unavailable")
        run(svc.lookup([{"id": "x", "lat": 51, "lon": 5}]))
        self.assertEqual(src.calls, 1)

    def test_other_errors_back_off(self):
        src = Source({}, exc=TimeoutError("slow"))
        svc = self.svc(src, error_backoff_s=600)
        run(svc.lookup([{"id": "x", "lat": 51, "lon": 5}]))
        run(svc.lookup([{"id": "x", "lat": 51, "lon": 5}]))
        self.assertEqual(src.calls, 1)
        self.assertFalse(svc.status()["blocked"])
        self.clock.t += 601
        run(svc.lookup([{"id": "x", "lat": 51, "lon": 5}]))
        self.assertEqual(src.calls, 2)

    def test_station_exception_keeps_stale_and_backs_off(self):
        site = Site(51.0, 5.0, {"E10": 2.0})
        svc = self.svc(Source({"s": site}))
        run(svc.lookup([{"id": "1", "lat": 51.0, "lon": 5.0}]))
        self.clock.t += 25 * 3600
        site.raise_exc = RuntimeError("Session is closed")
        out = run(svc.lookup([{"id": "1", "lat": 51.0, "lon": 5.0}]))
        r = out["results"]["1"]
        self.assertFalse(r["fresh"])
        self.assertEqual(r["fuels"]["E10"]["price"], 2.0)  # stale value returned with its real timestamp
        self.assertIsNotNone(out["status"]["backoffUntil"])

    def test_request_limit_and_pacing(self):
        sites = {f"s{i}": Site(51 + i * 0.01, 5.0, {"E10": 2.0}) for i in range(5)}
        svc = self.svc(Source(sites), max_fetch_per_request=2, min_interval_s=2)
        t0 = self.clock.t
        out = run(svc.lookup([{"id": str(i), "lat": 51 + i * 0.01, "lon": 5.0} for i in range(5)]))
        reasons = [out["results"][str(i)]["reason"] for i in range(5)]
        self.assertEqual(reasons, [None, None, "request-limit", "request-limit", "request-limit"])
        self.assertGreaterEqual(self.clock.t - t0, 4)  # places + 2 stations, >= 2 s apart

    def test_places_refresh_does_not_trigger_library_cascade(self):
        calls = []

        class CascadeSource(Source):
            async def update(inner):
                inner.calls += 1
                for sid in ("a", "b"):
                    if sid not in inner.location_cache:
                        s = Site(51.0 if sid == "a" else 51.1, 5.0, {"E10": 2.0})
                        orig = s.dynamic_build_fuels

                        async def counted(orig=orig):
                            calls.append(1)
                            await orig()
                        s.dynamic_build_fuels = counted
                        inner.location_cache[sid] = s
                # like pyfuelprices: re-request every site that already has fuels
                for s in list(inner.location_cache.values()):
                    if s.available_fuels:
                        await s.dynamic_build_fuels()

        src = CascadeSource({})
        svc = self.svc(src)
        run(svc.lookup([{"id": "1", "lat": 51.0, "lon": 5.0}, {"id": "2", "lat": 51.1, "lon": 5.0}]))
        self.assertEqual(len(calls), 2)
        self.clock.t += 2 * 86400
        out = run(svc.lookup([{"id": "1", "lat": 51.0, "lon": 5.0}]))
        self.assertEqual(src.calls, 2)
        self.assertEqual(len(calls), 3)  # only the requested stale station, not the whole cache
        self.assertTrue(out["results"]["1"]["fresh"])

    def test_daily_budget(self):
        sites = {f"s{i}": Site(51 + i * 0.01, 5.0, {"E10": 2.0}) for i in range(3)}
        svc = self.svc(Source(sites), daily_budget=2)
        out = run(svc.lookup([{"id": str(i), "lat": 51 + i * 0.01, "lon": 5.0} for i in range(3)]))
        self.assertEqual(out["results"]["1"]["reason"], "daily-budget")
        self.assertEqual(out["status"]["requestsToday"], 2)


if __name__ == "__main__":
    unittest.main()
