"""HTTP sidecar exposing DirectLease station quotes (via pyfuelprices) to Fuel Detour.

Internal service: it binds to the Docker network only (no published port in docker-compose.yml).
Endpoints:
  GET  /health  -> status (blocked?, cache, budget)
  POST /quotes  -> {"points": [{"id": "...", "lat": 51.4, "lon": 4.9}, ...]}
"""

import asyncio
import logging
import os
from datetime import timedelta

import aiohttp
from aiohttp import web

from core import BlockDetector, QuoteService, RawFuelCapture

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
LOG = logging.getLogger("directlease-sidecar")


def env_flag(name):
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def paused_reason():
    """No DirectLease requests unless the operator enabled it (and did not pause it)."""
    if not env_flag("DIRECTLEASE_PRIVATE_USE_ACK"):
        return "DIRECTLEASE_PRIVATE_USE_ACK is not set"
    if env_flag("DIRECTLEASE_PAUSED"):
        return "DIRECTLEASE_PAUSED is set"
    return None

def env_num(name, default):
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


async def make_service():
    # Imported lazily so the unit tests can run without the library's network setup.
    from pyfuelprices.sources.mapping import SOURCE_MAP

    if "directlease" not in SOURCE_MAP:
        raise RuntimeError("pyfuelprices no longer ships the 'directlease' source")
    source_cls = SOURCE_MAP["directlease"][0]
    session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=env_num("DIRECTLEASE_HTTP_TIMEOUT_S", 20)))
    source = source_cls(update_interval=timedelta(days=1), client_session=session)

    detector = BlockDetector()
    capture = RawFuelCapture()
    # The DirectLease module logs each raw fuel entry at DEBUG; capture those (for correct
    # key-based mapping) without flooding the console: this logger gets its own handlers.
    dl_logger = logging.getLogger("pyfuelprices.sources.netherlands.directlease")
    dl_logger.setLevel(logging.DEBUG)
    dl_logger.propagate = False
    console = logging.StreamHandler()
    console.setLevel(logging.getLevelName(os.environ.get("LOG_LEVEL", "INFO").upper()))
    console.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    for h in (detector, capture, console):
        dl_logger.addHandler(h)
    logging.getLogger("pyfuelprices").addHandler(detector)

    service = QuoteService(
        source, detector, capture=capture,
        data_dir=os.environ.get("DIRECTLEASE_DATA_DIR", "/data"),
        ttl_s=max(env_num("DIRECTLEASE_CACHE_TTL_H", 24), 24) * 3600,  # never below 24 h
        match_m=env_num("DIRECTLEASE_MATCH_M", 150),
        min_interval_s=env_num("DIRECTLEASE_MIN_INTERVAL_S", 1.5),
        max_fetch_per_request=int(env_num("DIRECTLEASE_MAX_FETCH_PER_REQUEST", 15)),
        daily_budget=int(env_num("DIRECTLEASE_DAILY_BUDGET", 200)),
        error_backoff_s=env_num("DIRECTLEASE_ERROR_BACKOFF_S", 3600),
        paused_reason=paused_reason(),
    )
    return service, session


async def health(request):
    return web.json_response(request.app["service"].status())


async def quotes(request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"error": "invalid JSON"}, status=400)
    points = body.get("points") if isinstance(body, dict) else None
    if not isinstance(points, list):
        return web.json_response({"error": "points must be a list"}, status=400)
    return web.json_response(await request.app["service"].lookup(points))


async def on_startup(app):
    app["service"], app["session"] = await make_service()
    st = app["service"].status()
    if st["blocked"]:
        LOG.error("Starting in BLOCKED state (%s); no DirectLease requests will be made.", st["blocked"])


async def on_cleanup(app):
    await app["session"].close()


def main():
    app = web.Application(client_max_size=64 * 1024)
    app.router.add_get("/health", health)
    app.router.add_post("/quotes", quotes)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    web.run_app(app, host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "8090")),
                access_log=None)


if __name__ == "__main__":
    main()
