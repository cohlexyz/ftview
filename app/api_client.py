from __future__ import annotations

import logging

import httpx

logger = logging.getLogger("ftview.api")

API_BASE = "https://api.fishtank.live"


class FishtankClient:
    """Thin async wrapper around the Fishtank public API."""

    async def get_live_streams(self) -> dict:
        """Fetch /v1/live-streams. Returns the full JSON response
        containing liveStreams, liveStreamStatus, and loadBalancer."""
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(f"{API_BASE}/v1/live-streams")
            resp.raise_for_status()
            return resp.json()

    async def get_zones(self, stream_id: str) -> dict:
        """Fetch clickable zones for a stream."""
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(f"{API_BASE}/v1/live-streams/zones/{stream_id}")
            resp.raise_for_status()
            return resp.json()

    @staticmethod
    def thumbnail_url(stream_id: str, domain: str = "streams-h.fishtank.live") -> str:
        """Build the thumbnail JPEG URL for a stream."""
        return f"https://{domain}/live%2B{stream_id}.jpeg"

    @staticmethod
    def hls_url(stream_id: str, token: str, domain: str = "streams-f.fishtank.live") -> str:
        """Build the HLS playlist URL with JWT token."""
        return f"https://{domain}/hls/live+{stream_id}/index.m3u8?jwt={token}"
