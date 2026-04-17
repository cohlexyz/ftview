from __future__ import annotations

import asyncio
import logging
import os
import platform
import re
import shutil
import stat
import subprocess
import tempfile
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import httpx

logger = logging.getLogger("ftview.clip")

# Directory for cached ffmpeg binary if not found on PATH
FFMPEG_CACHE_DIR = Path.home() / ".ftview" / "bin"


# ------------------------------------------------------------------
# FFmpeg discovery / download
# ------------------------------------------------------------------

def _find_ffmpeg() -> str | None:
    """Return path to ffmpeg binary, or None if unavailable."""
    # Check PATH first
    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        return system_ffmpeg
    # Check cached download
    cached = FFMPEG_CACHE_DIR / "ffmpeg"
    if cached.is_file() and os.access(cached, os.X_OK):
        return str(cached)
    return None


async def _download_ffmpeg() -> str | None:
    """Download a static ffmpeg binary for Linux x86_64. Returns path or None."""
    system = platform.system().lower()
    machine = platform.machine().lower()
    if system != "linux" or machine not in ("x86_64", "amd64"):
        logger.warning("Auto-download only supports linux-x86_64, got %s-%s", system, machine)
        return None

    url = "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
    logger.info("Downloading static ffmpeg from %s …", url)

    try:
        FFMPEG_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp_tar = FFMPEG_CACHE_DIR / "ffmpeg.tar.xz"

        async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
            async with client.stream("GET", url) as resp:
                if resp.status_code != 200:
                    logger.error("ffmpeg download returned %s", resp.status_code)
                    return None
                with open(tmp_tar, "wb") as f:
                    async for chunk in resp.aiter_bytes(chunk_size=256 * 1024):
                        f.write(chunk)

        # Extract just the ffmpeg binary
        proc = await asyncio.create_subprocess_exec(
            "tar", "xf", str(tmp_tar), "--wildcards", "*/ffmpeg",
            "--strip-components=1", "-C", str(FFMPEG_CACHE_DIR),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        tmp_tar.unlink(missing_ok=True)

        ffmpeg_path = FFMPEG_CACHE_DIR / "ffmpeg"
        if ffmpeg_path.is_file():
            ffmpeg_path.chmod(ffmpeg_path.stat().st_mode | stat.S_IEXEC)
            logger.info("ffmpeg downloaded to %s", ffmpeg_path)
            return str(ffmpeg_path)

        logger.error("ffmpeg binary not found after extraction: %s", stderr.decode())
        return None
    except Exception:
        logger.exception("Failed to download ffmpeg")
        return None


_ffmpeg_path: str | None = None


async def ensure_ffmpeg() -> str | None:
    """Return the ffmpeg path, downloading if necessary."""
    global _ffmpeg_path
    if _ffmpeg_path and (Path(_ffmpeg_path).is_file() or shutil.which(_ffmpeg_path)):
        return _ffmpeg_path
    _ffmpeg_path = _find_ffmpeg()
    if _ffmpeg_path:
        return _ffmpeg_path
    _ffmpeg_path = await _download_ffmpeg()
    return _ffmpeg_path


def get_ffmpeg_path() -> str | None:
    """Synchronous check — returns cached path or does a quick lookup."""
    global _ffmpeg_path
    if _ffmpeg_path:
        return _ffmpeg_path
    _ffmpeg_path = _find_ffmpeg()
    return _ffmpeg_path


# ------------------------------------------------------------------
# Segment data
# ------------------------------------------------------------------

@dataclass
class SegmentInfo:
    stream_id: str
    sequence: int
    duration: float
    data: bytes
    url: str  # original upstream URL (for dedup)


# ------------------------------------------------------------------
# Single clip buffer  (one per view: main / pip)
# ------------------------------------------------------------------

class ClipBuffer:
    """Rolling buffer of HLS .ts segments for one view."""

    def __init__(self, max_duration: int = 120) -> None:
        self.segments: deque[SegmentInfo] = deque()
        self.max_duration = max_duration
        self.stream_id: str | None = None
        self.is_recording = False
        self._task: asyncio.Task | None = None
        self._seen_sequences: set[int] = set()
        self._stop_event = asyncio.Event()
        self._first_poll = True  # skip pre-existing segments on first poll

    @property
    def buffered_seconds(self) -> float:
        return sum(s.duration for s in self.segments)

    @property
    def segment_count(self) -> int:
        return len(self.segments)

    def start(self, stream_id: str, hls_client: httpx.AsyncClient,
              token_getter, domain_getter, max_duration: int | None = None) -> None:
        """Start buffering segments for *stream_id*."""
        if self.is_recording:
            self.stop()
        if max_duration is not None:
            self.max_duration = max_duration
        self.stream_id = stream_id
        self.is_recording = True
        self.segments.clear()
        self._seen_sequences.clear()
        self._first_poll = True
        self._stop_event.clear()
        self._task = asyncio.create_task(
            self._poll_loop(hls_client, token_getter, domain_getter)
        )

    def stop(self) -> None:
        """Stop buffering and clear data."""
        self.is_recording = False
        self._stop_event.set()
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = None
        self.segments.clear()
        self._seen_sequences.clear()
        self.stream_id = None

    def switch_camera(self, new_stream_id: str, hls_client: httpx.AsyncClient,
                      token_getter, domain_getter) -> None:
        """Switch to a new camera while keeping existing buffered segments."""
        if not self.is_recording:
            return
        # Cancel existing poll task
        self._stop_event.set()
        if self._task and not self._task.done():
            self._task.cancel()
        # Update stream and restart polling (keep segments + seen)
        self.stream_id = new_stream_id
        self._seen_sequences.clear()  # new stream has different sequence numbers
        self._first_poll = True  # skip pre-existing segments of new stream
        self._stop_event.clear()
        self._task = asyncio.create_task(
            self._poll_loop(hls_client, token_getter, domain_getter)
        )

    def _evict(self) -> None:
        """Remove oldest segments until total duration ≤ max_duration."""
        while self.buffered_seconds > self.max_duration and self.segments:
            removed = self.segments.popleft()
            self._seen_sequences.discard(removed.sequence)

    # ---- internal polling loop ----

    async def _poll_loop(self, hls_client: httpx.AsyncClient,
                         token_getter, domain_getter) -> None:
        """Periodically fetch the live playlist and download new segments."""
        while not self._stop_event.is_set():
            try:
                await self._fetch_new_segments(hls_client, token_getter, domain_getter)
            except asyncio.CancelledError:
                return
            except Exception:
                logger.exception("Segment poll error for %s", self.stream_id)
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=2.0)
                return  # stop event set
            except asyncio.TimeoutError:
                pass  # continue polling

    async def _fetch_new_segments(self, hls_client: httpx.AsyncClient,
                                  token_getter, domain_getter) -> None:
        stream_id = self.stream_id
        if not stream_id:
            return
        token = token_getter()
        if not token:
            return
        domain = domain_getter(stream_id)

        # Fetch the live sub-playlist (not the master).
        # The master playlist (index.m3u8) returns a list of quality variants.
        # We need to resolve the actual media playlist first.
        master_url = f"https://{domain}/hls/live+{stream_id}/index.m3u8?jwt={token}&video=maxbps"
        resp = await hls_client.get(master_url)
        if resp.status_code != 200:
            return
        master_body = resp.text

        # Parse the master playlist to find the media playlist URL
        media_path = None
        for line in master_body.splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                media_path = line
                break  # take the first (or only) variant
        if not media_path:
            return

        # Resolve the media playlist URL relative to master
        if media_path.startswith("http"):
            media_url = media_path
            # Ensure JWT token is present
            if "jwt=" not in media_url:
                sep = "&" if "?" in media_url else "?"
                media_url += f"{sep}jwt={token}"
        else:
            base = f"https://{domain}/hls/live+{stream_id}/"
            media_url = base + media_path
            if "jwt=" not in media_url:
                sep = "&" if "?" in media_url else "?"
                media_url += f"{sep}jwt={token}"

        resp2 = await hls_client.get(media_url)
        if resp2.status_code != 200:
            return
        playlist_body = resp2.text

        # Parse the media playlist for segments
        segments_to_fetch: list[tuple[int, float, str]] = []
        duration = 0.0
        seq_match = re.search(r"#EXT-X-MEDIA-SEQUENCE:(\d+)", playlist_body)
        media_sequence = int(seq_match.group(1)) if seq_match else 0

        current_seq = media_sequence
        for line in playlist_body.splitlines():
            line = line.strip()
            if line.startswith("#EXTINF:"):
                try:
                    duration = float(line.split(":")[1].split(",")[0])
                except (ValueError, IndexError):
                    duration = 2.0
            elif line and not line.startswith("#"):
                if current_seq not in self._seen_sequences:
                    # Resolve segment URL
                    if line.startswith("http"):
                        seg_url = line
                    else:
                        seg_base = media_url.rsplit("/", 1)[0] + "/"
                        seg_url = seg_base + line
                    if "jwt=" not in seg_url:
                        sep = "&" if "?" in seg_url else "?"
                        seg_url += f"{sep}jwt={token}"
                    segments_to_fetch.append((current_seq, duration, seg_url))
                current_seq += 1
                duration = 0.0

        # On first poll, just mark existing segments as seen without
        # downloading them so the buffer only contains segments that
        # arrived *after* the user pressed record.
        if self._first_poll:
            self._first_poll = False
            for seq, _dur, _url in segments_to_fetch:
                self._seen_sequences.add(seq)
            return

        # Download new segments
        for seq, dur, url in segments_to_fetch:
            if self._stop_event.is_set():
                return
            try:
                seg_resp = await hls_client.get(url)
                if seg_resp.status_code == 200:
                    self.segments.append(SegmentInfo(
                        stream_id=stream_id,
                        sequence=seq,
                        duration=dur,
                        data=seg_resp.content,
                        url=url,
                    ))
                    self._seen_sequences.add(seq)
                    self._evict()
            except Exception:
                logger.debug("Failed to download segment %d", seq)


# ------------------------------------------------------------------
# Buffer manager (holds main + pip buffers)
# ------------------------------------------------------------------

class ClipBufferManager:
    """Manages two clip buffers — one for main, one for pip."""

    def __init__(self) -> None:
        self.main = ClipBuffer()
        self.pip = ClipBuffer()

    def get(self, target: Literal["main", "pip"]) -> ClipBuffer:
        if target == "pip":
            return self.pip
        return self.main

    def status(self) -> dict:
        def _buf_status(buf: ClipBuffer) -> dict:
            return {
                "recording": buf.is_recording,
                "stream_id": buf.stream_id,
                "buffered_seconds": round(buf.buffered_seconds, 1),
                "segment_count": buf.segment_count,
                "max_duration": buf.max_duration,
            }
        return {"main": _buf_status(self.main), "pip": _buf_status(self.pip)}

    def stop_all(self) -> None:
        self.main.stop()
        self.pip.stop()

    # ---- FFmpeg operations ----

    @staticmethod
    def _write_segments_to_dir(segments, tmpdir: Path) -> Path:
        """Write segments as individual files and create an ffmpeg concat list.

        Returns the path to the concat list file.
        """
        concat_list = tmpdir / "concat.txt"
        with open(concat_list, "w") as cl:
            for i, seg in enumerate(segments):
                seg_path = tmpdir / f"seg_{i:05d}.ts"
                seg_path.write_bytes(seg.data)
                # ffmpeg concat demuxer format — escape single quotes
                safe = str(seg_path).replace("'", "'\\''")
                cl.write(f"file '{safe}'\n")
        return concat_list

    async def generate_thumbnail(self, target: Literal["main", "pip"],
                                 time_sec: float) -> bytes | None:
        """Extract a single JPEG frame at the given time offset from the buffer."""
        ffmpeg = get_ffmpeg_path()
        if not ffmpeg:
            return None
        buf = self.get(target)
        if not buf.segments:
            return None

        # Snapshot segments so the buffer can keep growing
        segments = list(buf.segments)
        total = sum(s.duration for s in segments)
        time_sec = max(0.0, min(time_sec, total - 0.1))

        with tempfile.TemporaryDirectory(prefix="ftview_thumb_") as tmpdir:
            tmpdir = Path(tmpdir)
            concat_list = self._write_segments_to_dir(segments, tmpdir)

            out_path = tmpdir / "thumb.jpg"
            # -ss after -i = output-seeking (decodes from start, accurate)
            # -f concat -safe 0 handles cross-camera discontinuities
            proc = await asyncio.create_subprocess_exec(
                ffmpeg, "-y",
                "-f", "concat", "-safe", "0",
                "-i", str(concat_list),
                "-ss", f"{time_sec:.3f}",
                "-vframes", "1",
                "-q:v", "4",
                "-f", "image2",
                str(out_path),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _, stderr = await proc.communicate()
            if proc.returncode != 0:
                logger.warning("ffmpeg thumbnail failed: %s", stderr.decode()[-500:])
                return None
            if out_path.is_file():
                return out_path.read_bytes()
        return None

    async def export_clip(self, target: Literal["main", "pip"],
                          start_time: float, end_time: float) -> Path | None:
        """Remux buffered segments into a trimmed MP4 file. Returns path to temp file."""
        ffmpeg = get_ffmpeg_path()
        if not ffmpeg:
            return None
        buf = self.get(target)
        if not buf.segments:
            return None

        # Snapshot segments
        segments = list(buf.segments)
        total = sum(s.duration for s in segments)
        start_time = max(0.0, start_time)
        end_time = min(end_time, total)
        if end_time <= start_time:
            return None

        tmpdir = Path(tempfile.mkdtemp(prefix="ftview_clip_"))
        concat_list = self._write_segments_to_dir(segments, tmpdir)

        out_path = tmpdir / "clip.mp4"
        proc = await asyncio.create_subprocess_exec(
            ffmpeg, "-y",
            "-f", "concat", "-safe", "0",
            "-i", str(concat_list),
            "-ss", f"{start_time:.3f}",
            "-to", f"{end_time:.3f}",
            "-c", "copy",
            "-movflags", "+faststart",
            str(out_path),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0:
            logger.warning("ffmpeg export failed: %s", stderr.decode()[-500:])
            # Cleanup on failure
            shutil.rmtree(tmpdir, ignore_errors=True)
            return None
        if out_path.is_file():
            return out_path
        shutil.rmtree(tmpdir, ignore_errors=True)
        return None
