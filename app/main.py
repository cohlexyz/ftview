from __future__ import annotations

import logging
import re
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import httpx
import asyncio
import shutil

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from .api_client import FishtankClient
from .auth import AuthService
from .clip_buffer import ClipBufferManager, ensure_ffmpeg, get_ffmpeg_path

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

# When running as a PyInstaller frozen binary, assets are unpacked into
# sys._MEIPASS.  Fall back to the normal source-relative path otherwise.
if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    BASE_DIR = Path(sys._MEIPASS) / "app"  # type: ignore[attr-defined]
else:
    BASE_DIR = Path(__file__).resolve().parent

auth_service = AuthService()
ft_client = FishtankClient()
clip_manager = ClipBufferManager()


# Persistent HTTP client for HLS proxy (avoids TLS handshake per request)
_hls_client: httpx.AsyncClient | None = None


def _get_hls_client() -> httpx.AsyncClient:
    global _hls_client
    if _hls_client is None or _hls_client.is_closed:
        _hls_client = httpx.AsyncClient(timeout=30, follow_redirects=True)
    return _hls_client


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _hls_client
    _hls_client = httpx.AsyncClient(timeout=30, follow_redirects=True)
    await auth_service.start_refresh_loop()
    # Pre-check ffmpeg availability (non-blocking download if needed)
    asyncio.create_task(_init_ffmpeg())
    yield
    clip_manager.stop_all()
    auth_service.stop_refresh_loop()
    await ft_client.close()
    await _hls_client.aclose()
    _hls_client = None


async def _init_ffmpeg() -> None:
    try:
        await ensure_ffmpeg()
    except Exception:
        logger.warning("ffmpeg auto-setup failed; clip features may be unavailable")


app = FastAPI(title="Fishtank Stream Viewer", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")

# Regex for validating stream IDs (alphanumeric + hyphens)
STREAM_ID_RE = re.compile(r"^[a-zA-Z0-9\-]+$")
# Allowed HLS file extensions for proxy
HLS_PATH_RE = re.compile(r"^[a-zA-Z0-9_.\-+/]+$")

# Quality presets: map user-facing name → upstream video= parameter value
QUALITY_MAP = {"low": "minbps", "medium": "2.5mbps", "high": "maxbps"}


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


class ThirdPartyLoginRequest(BaseModel):
    url: str
    username: str
    password: str


@app.post("/api/login")
async def api_login(body: LoginRequest):
    success = await auth_service.login(body.email, body.password)
    if not success:
        raise HTTPException(401, "Login failed — check your email and password")
    return {"ok": True}


@app.post("/api/login/thirdparty")
async def api_login_thirdparty(body: ThirdPartyLoginRequest):
    if not body.url.startswith("https://"):
        raise HTTPException(400, "URL must use HTTPS")
    success = await auth_service.login_thirdparty(body.url, body.username, body.password)
    if not success:
        raise HTTPException(401, "Login failed — check the endpoint URL and credentials")
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
async def hls_proxy(stream_id: str, path: str, request: Request):
    if not auth_service.is_authenticated or not auth_service.live_stream_token:
        raise HTTPException(401, "Not authenticated")
    _valid_stream_id(stream_id)
    if not HLS_PATH_RE.match(path) or ".." in path:
        raise HTTPException(400, "Invalid path")

    domain = _get_stream_domain(stream_id)
    token = auth_service.live_stream_token
    upstream = f"https://{domain}/hls/live+{stream_id}/{path}?jwt={token}"

    # Append quality (video bitrate) for master playlist requests
    quality = request.query_params.get("quality", "high")
    video_param = QUALITY_MAP.get(quality, QUALITY_MAP["high"])
    if path == "index.m3u8":
        upstream += f"&video={video_param}"

    # For .m3u8 playlists: fetch fully, rewrite any absolute URLs so they
    # also go through our proxy (otherwise HLS.js hits CORS on segments).
    if path.endswith(".m3u8"):
        resp = await _get_hls_client().get(upstream)
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
        async with _get_hls_client().stream("GET", upstream) as resp:
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


# ------------------------------------------------------------------ Clip API


class ClipStartRequest(BaseModel):
    target: str  # "main" | "pip"
    stream_id: str
    max_duration: int | None = None


class ClipStopRequest(BaseModel):
    target: str


class ClipSwitchRequest(BaseModel):
    target: str
    stream_id: str


class ClipExportRequest(BaseModel):
    target: str
    start_time: float
    end_time: float


def _clip_target(target: str) -> Literal["main", "pip"]:
    if target not in ("main", "pip"):
        raise HTTPException(400, "target must be 'main' or 'pip'")
    return target  # type: ignore[return-value]


def _token_getter():
    return auth_service.live_stream_token


@app.post("/api/clip/start")
async def clip_start(body: ClipStartRequest):
    if not auth_service.is_authenticated:
        raise HTTPException(401, "Not authenticated")
    target = _clip_target(body.target)
    _valid_stream_id(body.stream_id)
    buf = clip_manager.get(target)
    buf.start(
        stream_id=body.stream_id,
        hls_client=_get_hls_client(),
        token_getter=_token_getter,
        domain_getter=_get_stream_domain,
        max_duration=body.max_duration,
    )
    return {"ok": True}


@app.post("/api/clip/stop")
async def clip_stop(body: ClipStopRequest):
    if not auth_service.is_authenticated:
        raise HTTPException(401, "Not authenticated")
    target = _clip_target(body.target)
    clip_manager.get(target).stop()
    return {"ok": True}


@app.post("/api/clip/switch")
async def clip_switch(body: ClipSwitchRequest):
    if not auth_service.is_authenticated:
        raise HTTPException(401, "Not authenticated")
    target = _clip_target(body.target)
    _valid_stream_id(body.stream_id)
    buf = clip_manager.get(target)
    if not buf.is_recording:
        raise HTTPException(400, "Buffer is not recording")
    buf.switch_camera(
        new_stream_id=body.stream_id,
        hls_client=_get_hls_client(),
        token_getter=_token_getter,
        domain_getter=_get_stream_domain,
    )
    return {"ok": True}


@app.get("/api/clip/status")
async def clip_status():
    if not auth_service.is_authenticated:
        raise HTTPException(401, "Not authenticated")
    return clip_manager.status()


@app.get("/api/clip/thumbnail")
async def clip_thumbnail(target: str, time: float):
    if not auth_service.is_authenticated:
        raise HTTPException(401, "Not authenticated")
    target = _clip_target(target)
    if not get_ffmpeg_path():
        raise HTTPException(503, "ffmpeg not available")
    data = await clip_manager.generate_thumbnail(target, time)
    if data is None:
        raise HTTPException(404, "Could not generate thumbnail")
    return StreamingResponse(iter([data]), media_type="image/jpeg")


@app.post("/api/clip/export")
async def clip_export(body: ClipExportRequest):
    if not auth_service.is_authenticated:
        raise HTTPException(401, "Not authenticated")
    target = _clip_target(body.target)
    if not get_ffmpeg_path():
        raise HTTPException(503, "ffmpeg not available")
    out_path = await clip_manager.export_clip(target, body.start_time, body.end_time)
    if out_path is None:
        raise HTTPException(400, "Export failed — no segments or invalid range")

    # Return the MP4 and schedule cleanup of the temp directory
    tmp_dir = out_path.parent

    async def _cleanup():
        await asyncio.sleep(5)
        shutil.rmtree(tmp_dir, ignore_errors=True)

    asyncio.create_task(_cleanup())

    return FileResponse(
        path=str(out_path),
        media_type="video/mp4",
        filename=f"clip_{target}.mp4",
        headers={"Content-Disposition": f'attachment; filename="clip_{target}.mp4"'},
    )


@app.get("/api/clip/ffmpeg-status")
async def clip_ffmpeg_status():
    path = get_ffmpeg_path()
    return {"available": path is not None, "path": path}
