from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

logger = logging.getLogger("ftview.auth")

API_BASE = "https://api.fishtank.live"
REFRESH_INTERVAL = 25 * 60  # 25 minutes, matching auth.cs
EXPIRY_BUFFER = 3600  # consider expired if <1 hour remains

CREDENTIALS_FILE = Path(__file__).resolve().parent.parent / "credentials.json"


class AuthService:
    """Manages Fishtank authentication: login, token refresh, credential persistence."""

    def __init__(self) -> None:
        self.access_token: str | None = None
        self.refresh_token: str | None = None
        self.live_stream_token: str | None = None
        self.expiry: datetime | None = None
        self._refresh_task: asyncio.Task | None = None

    # ------------------------------------------------------------------
    # Credential persistence
    # ------------------------------------------------------------------

    def _load_credentials(self) -> tuple[str, str] | None:
        """Load email/password from env vars or credentials.json."""
        email = os.environ.get("FISHTANK_EMAIL", "")
        password = os.environ.get("FISHTANK_PASSWORD", "")
        if email and password:
            return email, password
        if CREDENTIALS_FILE.is_file():
            data = json.loads(CREDENTIALS_FILE.read_text())
            return data.get("email", ""), data.get("password", "")
        return None

    def _save_credentials(self, email: str, password: str) -> None:
        CREDENTIALS_FILE.write_text(json.dumps({"email": email, "password": password}))
        CREDENTIALS_FILE.chmod(0o600)

    # ------------------------------------------------------------------
    # Login
    # ------------------------------------------------------------------

    async def login(self, email: str, password: str, *, save: bool = True) -> bool:
        """Login via email/password. Returns True on success."""
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{API_BASE}/v1/auth/log-in",
                json={"email": email, "password": password},
            )
        if resp.status_code != 200:
            logger.error("Login failed: %s %s", resp.status_code, resp.text)
            return False

        data = resp.json()
        session = data.get("session")
        if not session:
            logger.error("Login response missing 'session'")
            return False

        self.access_token = session.get("access_token")
        self.refresh_token = session.get("refresh_token")
        expires_in = session.get("expires_in", 0)
        self.expiry = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
        self.live_stream_token = session.get("live_stream_token")

        if not self.access_token or not self.refresh_token:
            logger.error("Login response missing tokens")
            return False

        if save:
            self._save_credentials(email, password)

        logger.info("Login successful, tokens expire at %s", self.expiry)
        return True

    # ------------------------------------------------------------------
    # Token refresh via Supabase cookie auth
    # ------------------------------------------------------------------

    async def refresh(self) -> bool:
        """Refresh tokens via GET /v1/auth with Supabase cookie. Returns True on success."""
        if not self.access_token or not self.refresh_token:
            return False

        cookie_value = f'["{self.access_token}", "{self.refresh_token}"]'
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{API_BASE}/v1/auth",
                headers={
                    "Cookie": f"sb-wcsaaupukpdmqdjcgaoo-auth-token={cookie_value}",
                    "User-Agent": "Mozilla/5.0",
                    "Accept": "application/json",
                    "Referer": "https://classic.fishtank.live/",
                    "Origin": "https://classic.fishtank.live",
                },
            )

        if resp.status_code != 200:
            logger.warning("Token refresh returned %s, will re-login next cycle", resp.status_code)
            self.expiry = None  # force re-login
            return False

        data = resp.json()
        session = data.get("session")
        if not session:
            logger.warning("Refresh response missing 'session'")
            return False

        self.live_stream_token = session.get("live_stream_token", self.live_stream_token)

        new_access = session.get("access_token")
        new_refresh = session.get("refresh_token")
        if new_access and new_refresh:
            self.access_token = new_access
            self.refresh_token = new_refresh
            expires_in = session.get("expires_in", 0)
            if expires_in:
                self.expiry = datetime.now(timezone.utc) + timedelta(seconds=expires_in)

        logger.info("Token refresh successful")
        return True

    # ------------------------------------------------------------------
    # Ensure authenticated (login or refresh as needed)
    # ------------------------------------------------------------------

    def _is_expired(self) -> bool:
        if not self.expiry:
            return True
        return datetime.now(timezone.utc) >= self.expiry - timedelta(seconds=EXPIRY_BUFFER)

    async def ensure_authenticated(self) -> bool:
        """Ensure we have valid tokens. Re-login or refresh as needed."""
        needs_login = (
            not self.access_token
            or not self.refresh_token
            or self._is_expired()
        )

        if needs_login:
            creds = self._load_credentials()
            if creds and creds[0] and creds[1]:
                logger.info("Tokens missing/expired, attempting login")
                if await self.login(creds[0], creds[1], save=False):
                    return True
            # Fall back to refresh if we still have tokens
            if self.access_token and self.refresh_token:
                return await self.refresh()
            return False

        return await self.refresh()

    # ------------------------------------------------------------------
    # Background refresh loop
    # ------------------------------------------------------------------

    async def start_refresh_loop(self) -> None:
        """Start the background token refresh task."""
        # Try to authenticate immediately on startup
        await self.ensure_authenticated()
        self._refresh_task = asyncio.create_task(self._refresh_loop())

    async def _refresh_loop(self) -> None:
        while True:
            await asyncio.sleep(REFRESH_INTERVAL)
            try:
                await self.ensure_authenticated()
            except Exception:
                logger.exception("Background token refresh failed")

    def stop_refresh_loop(self) -> None:
        if self._refresh_task:
            self._refresh_task.cancel()
            self._refresh_task = None

    @property
    def is_authenticated(self) -> bool:
        return bool(self.live_stream_token)
