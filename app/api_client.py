from __future__ import annotations

import logging

import httpx

logger = logging.getLogger("ftview.api")

API_BASE = "https://api.fishtank.live"


class FishtankClient:
    """Thin async wrapper around the Fishtank public API."""

    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=15)
        return self._client

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    async def get_live_streams(self) -> dict:
        """Fetch /v1/live-streams. Returns the full JSON response
        containing liveStreams, liveStreamStatus, and loadBalancer."""
        resp = await self._get_client().get(f"{API_BASE}/v1/live-streams")
        resp.raise_for_status()
        return resp.json()

    async def get_zones(self, stream_id: str) -> dict:
        """Fetch clickable zones for a stream."""
        resp = await self._get_client().get(f"{API_BASE}/v1/live-streams/zones/{stream_id}")
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
