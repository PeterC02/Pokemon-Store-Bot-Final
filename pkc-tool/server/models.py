"""Pydantic models — shared schemas for signals, users, events."""

from __future__ import annotations

import enum
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class SiteState(str, enum.Enum):
    NORMAL = "normal"
    CHALLENGE = "challenge"
    QUEUE = "queue"
    MAINTENANCE = "maintenance"
    UNKNOWN = "unknown"


class SignalType(str, enum.Enum):
    HOMEPAGE = "homepage"
    SITEMAP = "sitemap"
    SEARCH_API = "search_api"
    MULTI_ENDPOINT = "multi_endpoint"
    BUILD_ID = "build_id"
    RETAILER_SKU = "retailer_sku"
    SOCIAL = "social"
    PATTERN = "pattern"


class AlertLevel(str, enum.Enum):
    INFO = "info"           # Routine status update
    WARNING = "warning"     # Drop likely soon
    CRITICAL = "critical"   # Queue is live — auto-launch


class UserRole(str, enum.Enum):
    ADMIN = "admin"
    USER = "user"


# ---------------------------------------------------------------------------
# Signal / Event models
# ---------------------------------------------------------------------------

class Signal(BaseModel):
    """A single detection signal emitted by the server."""
    id: Optional[int] = None
    signal_type: SignalType
    alert_level: AlertLevel
    site_state: SiteState
    title: str
    detail: str = ""
    detected_urls: list[str] = Field(default_factory=list)
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class SiteStatus(BaseModel):
    """Current state of the PKC site as determined by detection engine."""
    state: SiteState = SiteState.UNKNOWN
    last_checked: Optional[datetime] = None
    last_changed: Optional[datetime] = None
    current_build_id: Optional[str] = None
    detail: str = ""


# ---------------------------------------------------------------------------
# User / Auth models
# ---------------------------------------------------------------------------

class UserCreate(BaseModel):
    username: str
    password: str
    invite_code: str


class UserLogin(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    id: int
    username: str
    role: UserRole
    created_at: datetime


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class InviteCode(BaseModel):
    code: str
    created_by: int
    used_by: Optional[int] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


# ---------------------------------------------------------------------------
# WebSocket messages (server → client)
# ---------------------------------------------------------------------------

class WSMessage(BaseModel):
    """Envelope for all WebSocket messages from server to client."""
    type: str  # "signal", "status", "ping"
    data: dict
