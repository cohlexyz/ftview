from __future__ import annotations

import logging
import re
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from .api_client import FishtankClient
from .auth import AuthService

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("ftview")


class _HlsLogFilter(logging.Filter):
    """Suppress access-log lines for /hls/ proxy requests."""

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if ('"GET https://streams-' in msg or '"GET /hls/' in msg) and '" 200' in msg:
            return False
        return True


logging.getLogger("uvicorn.access").addFilter(_HlsLogFilter())
logging.getLogger("httpx").setLevel(logging.WARNING)

BASE_DIR = Path(__file__).resolve().parent

auth_service = AuthService()
ft_client = FishtankClient()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await auth_service.start_refresh_loop()
    yield
    auth_service.stop_refresh_loop()


app = FastAPI(title="Fishtank Stream Viewer", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")

# Regex for validating stream IDs (alphanumeric + hyphens)
STREAM_ID_RE = re.compile(r"^[a-zA-Z0-9\-]+$")
# Allowed HLS file extensions for proxy
HLS_PATH_RE = re.compile(r"^[a-zA-Z0-9_.\-+/]+$")


def _valid_stream_id(stream_id: str) -> str:
    if not STREAM_ID_RE.match(stream_id) or len(stream_id) > 30:
        raise HTTPException(400, "Invalid stream ID")
    return stream_id


# ------------------------------------------------------------------ Pages


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    if auth_service.is_authenticated:
        return RedirectResponse("/viewer", status_code=302)
    return RedirectResponse("/login", status_code=302)


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    return templates.TemplateResponse(request, "login.html")


@app.get("/viewer", response_class=HTMLResponse)
async def viewer_page(request: Request):
    if not auth_service.is_authenticated:
        return RedirectResponse("/login", status_code=302)
    return templates.TemplateResponse(request, "viewer.html")


# ------------------------------------------------------------------ API


class LoginRequest(BaseModel):
    email: str
    password: str


@app.post("/api/login")
async def api_login(body: LoginRequest):
    success = await auth_service.login(body.email, body.password)
    if not success:
        raise HTTPException(401, "Login failed — check your email and password")
    return {"ok": True}


@app.get("/api/streams")
async def api_streams():
    if not auth_service.is_authenticated:
        raise HTTPException(401, "Not authenticated")
    data = await ft_client.get_live_streams()
    # Attach thumbnail URLs to each stream using load balancer domain
    lb = data.get("loadBalancer", {})
    _lb_cache.update(lb)
    for stream in data.get("liveStreams", []):
        domain = lb.get(stream["id"], "streams-h.fishtank.live")
        stream["thumbnailUrl"] = ft_client.thumbnail_url(stream["id"], domain)
    return data


@app.get("/api/zones/{stream_id}")
async def api_zones(stream_id: str):
    if not auth_service.is_authenticated:
        raise HTTPException(401, "Not authenticated")
    _valid_stream_id(stream_id)
    return await ft_client.get_zones(stream_id)


@app.get("/api/stream-url/{stream_id}")
async def api_stream_url(stream_id: str):
    if not auth_service.is_authenticated or not auth_service.live_stream_token:
        raise HTTPException(401, "Not authenticated or missing stream token")
    _valid_stream_id(stream_id)
    # Return a local proxy URL so HLS.js fetches through us (avoids CORS)
    return {"url": f"/hls/{stream_id}/index.m3u8"}


# ------------------------------------------------------------------ HLS proxy
# Proxies HLS requests through the backend to avoid CORS issues with the CDN.


# Cache for load balancer domains (populated by /api/streams calls)
_lb_cache: dict[str, str] = {}


def _get_stream_domain(stream_id: str) -> str:
    """Domain from cached load balancer map, with sensible default."""
    return _lb_cache.get(stream_id, "streams-f.fishtank.live")


@app.get("/hls/{stream_id}/{path:path}")
async def hls_proxy(stream_id: str, path: str):
    if not auth_service.is_authenticated or not auth_service.live_stream_token:
        raise HTTPException(401, "Not authenticated")
    _valid_stream_id(stream_id)
    if not HLS_PATH_RE.match(path) or ".." in path:
        raise HTTPException(400, "Invalid path")

    domain = _get_stream_domain(stream_id)
    token = auth_service.live_stream_token
    upstream = f"https://{domain}/hls/live+{stream_id}/{path}?jwt={token}"

    # For .m3u8 playlists: fetch fully, rewrite any absolute URLs so they
    # also go through our proxy (otherwise HLS.js hits CORS on segments).
    if path.endswith(".m3u8"):
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(upstream)
            if resp.status_code != 200:
                raise HTTPException(resp.status_code, "Upstream error")
            body = resp.text
        # Rewrite absolute https://domain/hls/live+id/… URLs to local /hls/id/…
        body = re.sub(
            r"https?://[^/]+/hls/live\+([^/]+)/",
            lambda m: f"/hls/{m.group(1)}/",
            body,
        )
        # Strip any ?jwt=… from rewritten lines (our proxy adds its own)
        body = re.sub(r"\?jwt=[^\s]*", "", body)
        return StreamingResponse(
            iter([body.encode()]),
            media_type="application/vnd.apple.mpegurl",
        )

    # For .ts segments and other files: stream directly
    async def _stream():
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            async with client.stream("GET", upstream) as resp:
                if resp.status_code != 200:
                    return
                async for chunk in resp.aiter_bytes(chunk_size=64 * 1024):
                    yield chunk

    if path.endswith(".ts"):
        ct = "video/mp2t"
    else:
        ct = "application/octet-stream"

    return StreamingResponse(_stream(), media_type=ct)


@app.get("/api/auth-status")
async def api_auth_status():
    return {"authenticated": auth_service.is_authenticated}
