#!/usr/bin/env python3
"""
Teams + meeting-bot end-to-end orchestration script.

Flow:
1) Create a Teams meeting via Microsoft Graph at ceil_5m(now + 10m).
2) Join as host in Teams web.
3) Wait for meeting-bot to request join, admit, and start playback via share.
4) End meeting after playback.
5) Wait for processing.
6) Pull AKS logs.
7) Scan recent errors.
8) Validate Firestore + GCS outputs.

Notes:
- This script defaults to Advisewell development resources.
- It relies on Microsoft calendar tokens already stored for the target user.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import quote

import requests
from google.cloud import firestore, storage
from google.cloud.firestore_v1.base_query import FieldFilter

try:
    from playwright.sync_api import TimeoutError as PWTimeoutError
    from playwright.sync_api import sync_playwright
except Exception:  # pragma: no cover - handled at runtime
    PWTimeoutError = Exception
    sync_playwright = None


DEFAULT_USER_EMAIL = "matt@advisewell.co"
DEFAULT_USER_ID_FALLBACK = "Mw6Awnh1WtN7631PrSYyGXlpozz1"
DEFAULT_ORG_FALLBACK = "advisewell"
DEFAULT_BOT_NAME = "AdviseWell"

DEFAULT_GCP_PROJECT = "aw-development-7226"
DEFAULT_BUCKET = "advisewell-firebase-development"
DEFAULT_KUBE_CONTEXT = "aks-development"
DEFAULT_KUBE_NAMESPACE = "default"

LOG_ERROR_PATTERNS = [
    r"\berror\b",
    r"\bexception\b",
    r"\btraceback\b",
    r"\bfailed\b",
    r"waitingatlobbyretryerror",
    r"not admitted",
]

LOG_BENIGN_PATTERNS = [
    # Teams web client-side GraphQL noise that does not indicate bot/job failure.
    r"resolveruncaughterrorboundary__donotassigntographqlteam",
    r"filesvaliddomainsservice",
    r"usegetvalidfiledomains",
    r"componentstypingindicatortypingusers",
    r"componentscomposemessagemobileattachupdatessubscription",
    r"_xservtransmkdir",
    r"ggml_cuda_init:\s*failed to initialize cuda",
    r"azure transcription unavailable \(non-fatal\); fallback path engaged",
]

CORRELATION_ID_REGEX = re.compile(
    r"correlationid[^a-f0-9-]*([a-f0-9]{8,}-[a-f0-9-]{8,})",
    re.IGNORECASE,
)

SESSION_SUCCESS_STATUSES = {"complete", "completed", "success", "succeeded"}
SESSION_FAILURE_STATUSES = {"failed", "error", "cancelled", "canceled"}
RECORDING_TERMINAL_STATUSES = {"complete", "completed", "failed", "error"}


def _strip_wrapped_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def load_selected_env_vars(env_file: Path, keys: Iterable[str]) -> bool:
    """Load selected KEY=VALUE entries from a dotenv-style file into process env."""
    if not env_file.exists() or not env_file.is_file():
        return False

    keyset = set(keys)
    loaded = False
    for raw_line in env_file.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.lower().startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key not in keyset or os.getenv(key):
            continue
        os.environ[key] = _strip_wrapped_quotes(value)
        loaded = True
    return loaded


def ensure_ms_graph_refresh_env(ms_env_file: Optional[str]) -> Optional[str]:
    """Ensure MS_* client env vars are present, trying known dotenv files if needed."""
    if os.getenv("MS_CLIENT_ID") and os.getenv("MS_CLIENT_SECRET"):
        return None

    script_dir = Path(__file__).resolve().parent
    repo_root = script_dir.parent
    workspace_root = repo_root.parent
    candidates: List[Path] = []

    if ms_env_file:
        candidates.append(Path(ms_env_file).expanduser())
    override = os.getenv("TEAMS_E2E_MS_ENV_FILE")
    if override:
        candidates.append(Path(override).expanduser())

    candidates.extend(
        [
            repo_root / ".env",
            repo_root / ".env.local",
            repo_root / ".env.development",
            workspace_root / "advisewell" / "backend" / "functions" / ".env.production",
            workspace_root / "advisewell" / "backend" / "functions" / ".env.staging",
            workspace_root / "advisewell" / "backend" / "functions" / ".env.default",
        ]
    )

    required = ("MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_TENANT_ID")
    for candidate in candidates:
        if os.getenv("MS_CLIENT_ID") and os.getenv("MS_CLIENT_SECRET"):
            break
        try:
            if load_selected_env_vars(candidate, required):
                if os.getenv("MS_CLIENT_ID") and os.getenv("MS_CLIENT_SECRET"):
                    return str(candidate)
        except Exception:
            continue

    return None


@dataclass
class ResolvedIdentity:
    user_id: str
    user_email: str
    organization_id: str
    auto_join_meetings: bool
    bot_display_name: str


class LocalVideoServer:
    """Serves an HTML page + local video over localhost for predictable playback."""

    def __init__(self, video_file: Path) -> None:
        self.video_file = video_file
        self.tmp_dir: Optional[tempfile.TemporaryDirectory[str]] = None
        self.httpd: Optional[ThreadingHTTPServer] = None
        self.thread: Optional[threading.Thread] = None
        self.base_url: Optional[str] = None
        self.playback_page_title = "Meeting Bot Video Playback"

    def __enter__(self) -> "LocalVideoServer":
        self.tmp_dir = tempfile.TemporaryDirectory(prefix="teams-e2e-video-")
        tmp_path = Path(self.tmp_dir.name)
        src_video = tmp_path / f"source{self.video_file.suffix.lower()}"
        src_video.write_bytes(self.video_file.read_bytes())

        html = f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>{self.playback_page_title}</title>
  <style>
    html, body {{
      margin: 0;
      background: #000;
      width: 100%;
      height: 100%;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }}
    video {{
      width: 100vw;
      height: 100vh;
      object-fit: contain;
      background: #000;
    }}
  </style>
</head>
<body>
  <video id="vid" controls preload="auto">
    <source src="/{src_video.name}">
  </video>
  <script>
    window.startPlayback = async function() {{
      const v = document.getElementById('vid');
      v.currentTime = 0;
      try {{
        await v.play();
      }} catch (e) {{
        return {{started: false, error: String(e), duration: Number(v.duration || 0)}};
      }}
      return {{started: true, duration: Number(v.duration || 0)}};
    }};
    window.playbackState = function() {{
      const v = document.getElementById('vid');
      return {{
        currentTime: Number(v.currentTime || 0),
        duration: Number(v.duration || 0),
        ended: Boolean(v.ended)
      }};
    }};
  </script>
</body>
</html>"""
        (tmp_path / "index.html").write_text(html, encoding="utf-8")

        handler = self._handler_for_directory(tmp_path)
        port = self._find_open_port()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{port}"
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.httpd is not None:
            self.httpd.shutdown()
            self.httpd.server_close()
        if self.thread is not None:
            self.thread.join(timeout=2)
        if self.tmp_dir is not None:
            self.tmp_dir.cleanup()

    @staticmethod
    def _handler_for_directory(directory: Path):
        class Handler(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(directory), **kwargs)

            def log_message(self, fmt, *args):
                return

        return Handler

    @staticmethod
    def _find_open_port() -> int:
        import socket

        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def log(msg: str) -> None:
    ts = now_utc().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts} UTC] {msg}", flush=True)


def coerce_datetime(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed
        except ValueError:
            return None
    return None


def next_slot_at_least_10_minutes(reference: datetime) -> datetime:
    candidate = reference + timedelta(minutes=10)
    candidate = candidate.replace(second=0, microsecond=0)
    mod = candidate.minute % 5
    if mod != 0:
        candidate = candidate + timedelta(minutes=(5 - mod))
    return candidate


def find_latest_video(downloads_dir: Path) -> Optional[Path]:
    exts = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}
    files = [p for p in downloads_dir.iterdir() if p.is_file() and p.suffix.lower() in exts]
    if not files:
        return None
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0]


def compute_session_id(org_id: str, meeting_url: str) -> str:
    combined = f"{org_id}:{meeting_url}"
    return hashlib.sha256(combined.encode("utf-8")).hexdigest()


def run_cmd(cmd: List[str], timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def _required_collection_group_index_signatures() -> List[Tuple[str, str]]:
    return [
        ("COLLECTION_GROUP", "ASCENDING"),
        ("COLLECTION_GROUP", "DESCENDING"),
        ("COLLECTION_GROUP", "CONTAINS"),
    ]


def _index_signature(index: Dict[str, Any]) -> Optional[Tuple[str, str]]:
    query_scope = str(index.get("queryScope") or "").strip()
    fields = index.get("fields") or []
    if not fields:
        return None
    field0 = fields[0] or {}
    mode = field0.get("order") or field0.get("arrayConfig")
    if not query_scope or not mode:
        return None
    return (query_scope, str(mode).strip().upper())


def _has_required_collection_group_indexes_ready(indexes: List[Dict[str, Any]]) -> bool:
    required = set(_required_collection_group_index_signatures())
    ready = {
        sig
        for idx in indexes
        for sig in [_index_signature(idx)]
        if sig and str(idx.get("state") or "").strip().upper() == "READY"
    }
    return required.issubset(ready)


def _missing_collection_group_index_signatures(indexes: List[Dict[str, Any]]) -> List[Tuple[str, str]]:
    required = set(_required_collection_group_index_signatures())
    present = {sig for idx in indexes for sig in [_index_signature(idx)] if sig}
    return sorted(required - present)


def _build_required_collection_group_indexes(field: str) -> List[Dict[str, Any]]:
    return [
        {"queryScope": "COLLECTION_GROUP", "fields": [{"fieldPath": field, "order": "ASCENDING"}]},
        {"queryScope": "COLLECTION_GROUP", "fields": [{"fieldPath": field, "order": "DESCENDING"}]},
        {"queryScope": "COLLECTION_GROUP", "fields": [{"fieldPath": field, "arrayConfig": "CONTAINS"}]},
    ]


def _merge_indexes_with_required_collection_group(
    *, field: str, existing_indexes: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    by_sig: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for idx in existing_indexes:
        sig = _index_signature(idx)
        if not sig:
            continue
        by_sig[sig] = idx
    for idx in _build_required_collection_group_indexes(field):
        sig = _index_signature(idx)
        if sig and sig not in by_sig:
            by_sig[sig] = idx
    return list(by_sig.values())


def describe_firestore_field_indexes(
    *,
    project: str,
    database: str,
    collection_group: str,
    field: str,
) -> Dict[str, Any]:
    cp = run_cmd(
        [
            "gcloud",
            "firestore",
            "indexes",
            "fields",
            "describe",
            field,
            "--project",
            project,
            "--database",
            database,
            "--collection-group",
            collection_group,
            "--format=json",
        ],
        timeout=60,
    )
    if cp.returncode != 0:
        raise RuntimeError(
            f"Failed to describe Firestore indexes for {collection_group}.{field}: "
            f"{(cp.stderr or cp.stdout or '').strip()[:500]}"
        )
    try:
        return json.loads(cp.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Failed to parse Firestore index describe output for {collection_group}.{field}"
        ) from exc


def get_gcloud_access_token() -> str:
    cp = run_cmd(["gcloud", "auth", "print-access-token"], timeout=30)
    token = (cp.stdout or "").strip()
    if cp.returncode != 0 or not token:
        raise RuntimeError(
            f"Unable to obtain gcloud access token: {(cp.stderr or cp.stdout or '').strip()[:500]}"
        )
    return token


def patch_firestore_field_indexes(
    *,
    project: str,
    database: str,
    collection_group: str,
    field: str,
    indexes: List[Dict[str, Any]],
) -> Dict[str, Any]:
    token = get_gcloud_access_token()
    resource = f"projects/{project}/databases/{database}/collectionGroups/{collection_group}/fields/{field}"
    url = f"https://firestore.googleapis.com/v1/{resource}?updateMask=indexConfig"
    resp = requests.patch(
        url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"indexConfig": {"indexes": indexes}},
        timeout=60,
    )
    if resp.status_code not in (200, 201):
        raise RuntimeError(
            f"Failed to patch Firestore indexes for {collection_group}.{field}: "
            f"{resp.status_code} {resp.text[:500]}"
        )
    return resp.json()


def ensure_collection_group_field_indexes(
    *,
    project: str,
    database: str,
    collection_group: str,
    field: str,
    wait_timeout_seconds: int,
) -> Dict[str, Any]:
    deadline = time.time() + max(60, int(wait_timeout_seconds))
    last_progress_log = 0.0
    last_indexes: List[Dict[str, Any]] = []

    while True:
        desc = describe_firestore_field_indexes(
            project=project,
            database=database,
            collection_group=collection_group,
            field=field,
        )
        indexes = (desc.get("indexConfig") or {}).get("indexes") or []
        last_indexes = indexes

        if _has_required_collection_group_indexes_ready(indexes):
            return {
                "collection_group": collection_group,
                "field": field,
                "ready": True,
                "required_signatures": _required_collection_group_index_signatures(),
            }

        missing = _missing_collection_group_index_signatures(indexes)
        if missing:
            merged = _merge_indexes_with_required_collection_group(field=field, existing_indexes=indexes)
            patch_firestore_field_indexes(
                project=project,
                database=database,
                collection_group=collection_group,
                field=field,
                indexes=merged,
            )
            log(
                "Requested Firestore COLLECTION_GROUP indexes for "
                f"{collection_group}.{field}; waiting for READY."
            )

        now_ts = time.time()
        if now_ts - last_progress_log >= 20:
            state_summary = []
            for idx in indexes:
                sig = _index_signature(idx)
                if sig and sig[0] == "COLLECTION_GROUP":
                    state_summary.append(f"{sig[1]}:{str(idx.get('state') or '').upper()}")
            log(
                "Firestore index readiness "
                f"{collection_group}.{field}: "
                + (", ".join(sorted(state_summary)) if state_summary else "no COLLECTION_GROUP entries yet")
            )
            last_progress_log = now_ts

        if now_ts >= deadline:
            raise RuntimeError(
                "Timed out waiting for Firestore COLLECTION_GROUP indexes for "
                f"{collection_group}.{field}. Last index states: "
                f"{[(_index_signature(i), i.get('state')) for i in last_indexes if _index_signature(i)]}"
            )

        time.sleep(8)


def ensure_required_firestore_indexes(
    *,
    project: str,
    database: str,
    wait_timeout_seconds: int,
) -> Dict[str, Any]:
    required_fields = [("meetings", "start"), ("meeting_sessions", "status")]
    checks: List[Dict[str, Any]] = []
    for collection_group, field in required_fields:
        checks.append(
            ensure_collection_group_field_indexes(
                project=project,
                database=database,
                collection_group=collection_group,
                field=field,
                wait_timeout_seconds=wait_timeout_seconds,
            )
        )
    return {"ready": True, "checks": checks}


def sleep_with_progress(seconds: int, prefix: str) -> None:
    remaining = int(seconds)
    while remaining > 0:
        chunk = min(60, remaining)
        log(f"{prefix}: sleeping {chunk}s ({remaining}s remaining)")
        time.sleep(chunk)
        remaining -= chunk


def wait_until(target: datetime, label: str) -> None:
    now = now_utc()
    if target <= now:
        return
    total = int((target - now).total_seconds())
    log(f"Waiting until {target.isoformat()} for {label} ({total}s)")
    sleep_with_progress(total, f"Waiting for {label}")


def resolve_identity(
    db: firestore.Client,
    *,
    user_email: str,
    user_id_override: Optional[str],
    org_override: Optional[str],
    bot_display_name_override: Optional[str],
    user_id_fallback: str,
    org_fallback: str,
) -> ResolvedIdentity:
    resolved_user_id: str
    resolved_org_id: str
    auto_join = False
    resolved_email = user_email

    if user_id_override:
        user_doc = db.collection("users").document(user_id_override).get()
        if not user_doc.exists:
            raise RuntimeError(f"User document not found for --user-id={user_id_override}")
        user_data = user_doc.to_dict() or {}
        resolved_user_id = user_id_override
        resolved_email = user_data.get("email") or user_email
        resolved_org_id = org_override or user_data.get("organization_id") or org_fallback
        auto_join = bool(user_data.get("auto_join_meetings", False))
    else:
        matches = list(
            db.collection("users")
            .where(filter=FieldFilter("email", "==", user_email))
            .limit(3)
            .stream()
        )
        if len(matches) == 1:
            user_data = matches[0].to_dict() or {}
            resolved_user_id = matches[0].id
            resolved_org_id = org_override or user_data.get("organization_id") or org_fallback
            auto_join = bool(user_data.get("auto_join_meetings", False))
        elif len(matches) == 0:
            log(
                "No user matched by email; using fallback IDs "
                f"user_id={user_id_fallback} org_id={org_override or org_fallback}"
            )
            resolved_user_id = user_id_fallback
            resolved_org_id = org_override or org_fallback
        else:
            ids = ", ".join([m.id for m in matches])
            raise RuntimeError(
                f"Multiple users matched email {user_email}. Use --user-id. Matches: {ids}"
            )

    org_doc = db.collection("organizations").document(resolved_org_id).get()
    org_data = org_doc.to_dict() if org_doc.exists else {}
    org_bot_name = (org_data or {}).get("meeting_bot_name")
    bot_name = bot_display_name_override or org_bot_name or DEFAULT_BOT_NAME

    return ResolvedIdentity(
        user_id=resolved_user_id,
        user_email=resolved_email,
        organization_id=resolved_org_id,
        auto_join_meetings=auto_join,
        bot_display_name=bot_name,
    )


def get_user_doc(db: firestore.Client, user_id: str) -> Dict[str, Any]:
    doc = db.collection("users").document(user_id).get()
    if not doc.exists:
        raise RuntimeError(f"User document not found: {user_id}")
    return doc.to_dict() or {}


def maybe_refresh_graph_token(
    *,
    user_doc_ref: firestore.DocumentReference,
    user_data: Dict[str, Any],
) -> Tuple[str, Dict[str, Any]]:
    access_token = user_data.get("ms_calendar_access_token")
    refresh_token = user_data.get("ms_calendar_refresh_token")
    expiry_ts = int(user_data.get("ms_calendar_token_expiry") or 0)
    now_ts = int(time.time())

    if not access_token:
        raise RuntimeError("User has no ms_calendar_access_token in Firestore.")

    # Reuse if still valid for >5m.
    if expiry_ts > now_ts + 300:
        return access_token, user_data

    if not refresh_token:
        raise RuntimeError("Access token expired/near expiry and no refresh token is available.")

    client_id = os.getenv("MS_CLIENT_ID")
    client_secret = os.getenv("MS_CLIENT_SECRET")
    tenant_id = os.getenv("MS_TENANT_ID", "common")
    if not client_id or not client_secret:
        raise RuntimeError(
            "MS_CLIENT_ID/MS_CLIENT_SECRET required to refresh Microsoft token."
        )

    token_url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
    data = {
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }
    resp = requests.post(token_url, data=data, timeout=30)
    if resp.status_code != 200:
        raise RuntimeError(
            f"Failed to refresh Microsoft token: {resp.status_code} {resp.text[:250]}"
        )
    token_json = resp.json()
    new_access = token_json.get("access_token")
    if not new_access:
        raise RuntimeError("Token refresh response missing access_token.")
    new_refresh = token_json.get("refresh_token", refresh_token)
    expires_in = int(token_json.get("expires_in", 3600))
    new_expiry = int(time.time()) + expires_in

    user_doc_ref.update(
        {
            "ms_calendar_access_token": new_access,
            "ms_calendar_refresh_token": new_refresh,
            "ms_calendar_token_expiry": new_expiry,
            "ms_calendar_tokens_updated_at": firestore.SERVER_TIMESTAMP,
        }
    )

    refreshed = dict(user_data)
    refreshed["ms_calendar_access_token"] = new_access
    refreshed["ms_calendar_refresh_token"] = new_refresh
    refreshed["ms_calendar_token_expiry"] = new_expiry
    return new_access, refreshed


def create_teams_meeting(
    *,
    access_token: str,
    start_utc: datetime,
    duration_minutes: int,
    organizer_email: str,
    title_prefix: str,
) -> Dict[str, Any]:
    # Requested behavior: create meetings with identical start/end timestamps.
    # Keep duration_minutes in signature for compatibility with existing CLI/reporting.
    _ = duration_minutes
    end_utc = start_utc
    subject = f"{title_prefix} {start_utc.strftime('%Y-%m-%d %H:%M UTC')}"
    payload = {
        "subject": subject,
        "start": {
            "dateTime": start_utc.strftime("%Y-%m-%dT%H:%M:%S"),
            "timeZone": "UTC",
        },
        "end": {
            "dateTime": end_utc.strftime("%Y-%m-%dT%H:%M:%S"),
            "timeZone": "UTC",
        },
        "isOnlineMeeting": True,
        "onlineMeetingProvider": "teamsForBusiness",
        "body": {
            "contentType": "HTML",
            "content": "Automated meeting-bot validation run.",
        },
        "attendees": [
            {
                "emailAddress": {"address": organizer_email},
                "type": "required",
            }
        ],
    }
    resp = requests.post(
        "https://graph.microsoft.com/v1.0/me/events",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=30,
    )
    if resp.status_code not in (200, 201):
        raise RuntimeError(
            f"Failed to create Teams meeting: {resp.status_code} {resp.text[:500]}"
        )
    data = resp.json()
    join_url = (
        (data.get("onlineMeeting") or {}).get("joinUrl")
        or data.get("onlineMeetingUrl")
        or data.get("webLink")
    )
    if not join_url:
        raise RuntimeError("Graph create event response did not include join URL.")
    return {
        "graph_event_id": data.get("id"),
        "subject": data.get("subject"),
        "join_url": join_url,
        "start_utc": start_utc.isoformat(),
        "end_utc": end_utc.isoformat(),
        "raw_event": data,
    }


def find_meeting_doc_for_event(
    db: firestore.Client,
    *,
    org_id: str,
    user_id: str,
    graph_event_id: Optional[str],
    meeting_url: str,
    scheduled_start_utc: datetime,
) -> Optional[Tuple[str, Dict[str, Any]]]:
    meetings_ref = db.collection("organizations").document(org_id).collection("meetings")
    candidates: List[Tuple[str, Dict[str, Any]]] = []

    if graph_event_id:
        for doc in meetings_ref.where(
            filter=FieldFilter("calendar_event_id", "==", graph_event_id)
        ).limit(30).stream():
            d = doc.to_dict() or {}
            if (d.get("user_id") or d.get("synced_by_user_id")) == user_id:
                candidates.append((doc.id, d))

    if not candidates:
        for doc in meetings_ref.where(
            filter=FieldFilter("join_url", "==", meeting_url)
        ).limit(60).stream():
            d = doc.to_dict() or {}
            if (d.get("user_id") or d.get("synced_by_user_id")) == user_id:
                candidates.append((doc.id, d))

    if not candidates:
        return None

    def score(item: Tuple[str, Dict[str, Any]]) -> float:
        start = coerce_datetime(item[1].get("start"))
        if not start:
            return float("inf")
        return abs((start - scheduled_start_utc).total_seconds())

    candidates.sort(key=score)
    return candidates[0]


def wait_for_meeting_doc(
    db: firestore.Client,
    *,
    org_id: str,
    user_id: str,
    graph_event_id: Optional[str],
    meeting_url: str,
    scheduled_start_utc: datetime,
    timeout_seconds: int,
) -> Optional[Tuple[str, Dict[str, Any]]]:
    start = time.time()
    while (time.time() - start) < timeout_seconds:
        found = find_meeting_doc_for_event(
            db,
            org_id=org_id,
            user_id=user_id,
            graph_event_id=graph_event_id,
            meeting_url=meeting_url,
            scheduled_start_utc=scheduled_start_utc,
        )
        if found:
            return found
        time.sleep(15)
    return None


def set_ai_assistant_enabled(
    db: firestore.Client,
    *,
    org_id: str,
    meeting_id: str,
    enabled: bool = True,
) -> None:
    doc_ref = db.collection("organizations").document(org_id).collection("meetings").document(meeting_id)
    doc_ref.set(
        {
            "ai_assistant_enabled": enabled,
            "updated_at": firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )


def queue_meeting_for_recording(
    db: firestore.Client,
    *,
    org_id: str,
    meeting_id: str,
    start_offset_minutes: int = 2,
    enable_ai_assistant: bool = True,
) -> datetime:
    start_time = now_utc() + timedelta(minutes=start_offset_minutes)
    payload: Dict[str, Any] = {
        "status": "scheduled",
        "start": start_time,
        "queued_at": firestore.SERVER_TIMESTAMP,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }
    if enable_ai_assistant:
        payload["ai_assistant_enabled"] = True

    doc_ref = db.collection("organizations").document(org_id).collection("meetings").document(meeting_id)
    doc_ref.set(payload, merge=True)
    return start_time


def _safe_click(locator, timeout_ms: int = 1200) -> bool:
    try:
        if locator.count() <= 0:
            return False
        if not locator.is_visible(timeout=min(timeout_ms, 400)):
            return False
        locator.click(timeout=timeout_ms)
        return True
    except Exception:
        return False


def _click_any_role_button(
    page,
    patterns: Iterable[re.Pattern],
    roles: Tuple[str, ...] = (
        "button",
        "togglebutton",
        "tab",
        "menuitem",
        "menuitemcheckbox",
        "link",
    ),
    timeout_ms: int = 1200,
) -> bool:
    for patt in patterns:
        for role in roles:
            try:
                locator = page.get_by_role(role, name=patt).first
                if _safe_click(locator, timeout_ms=timeout_ms):
                    return True
            except Exception:
                continue
    return False


def assert_playwright_available() -> None:
    if sync_playwright is None:
        raise RuntimeError(
            "Python Playwright is not installed. Install with:\n"
            "  /home/mattkellock/git/.venv/bin/python -m pip install playwright\n"
            "  /home/mattkellock/git/.venv/bin/python -m playwright install chromium"
        )


def capture_browser_debug_artifacts(page, prefix: str) -> Dict[str, Optional[str]]:
    ts = int(time.time())
    out: Dict[str, Optional[str]] = {"screenshot": None, "body_dump": None, "url": None}
    try:
        out["url"] = page.url
    except Exception:
        out["url"] = None

    screenshot_path = Path.cwd() / f"{prefix}_{ts}.png"
    try:
        page.screenshot(path=str(screenshot_path), full_page=True)
        out["screenshot"] = str(screenshot_path)
    except Exception:
        pass

    body_dump_path = Path.cwd() / f"{prefix}_{ts}.txt"
    try:
        body_text = page.locator("body").inner_text(timeout=5000)
        body_dump_path.write_text(
            f"url={out['url'] or ''}\n\n{body_text[:12000]}",
            encoding="utf-8",
        )
        out["body_dump"] = str(body_dump_path)
    except Exception:
        pass
    return out


def prejoin_requires_signin(teams_page) -> bool:
    try:
        sign_in_btn = teams_page.get_by_role("button", name=re.compile(r"Sign in", re.I)).count() > 0
        join_now_btn = teams_page.get_by_role("button", name=re.compile(r"Join now", re.I)).count() > 0
        return sign_in_btn and join_now_btn
    except Exception:
        return False


def wait_for_signin_completion(teams_page, timeout_seconds: int) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if not prejoin_requires_signin(teams_page):
            return True
        time.sleep(3)
    return False


def join_meeting_as_host(
    *,
    join_url: str,
    host_display_name: str,
    profile_dir: Path,
    headless: bool,
    bot_display_name: str,
    video_file: Path,
    meeting_start_utc: datetime,
    bot_join_deadline_minutes_after_start: int,
    bot_wait_minutes: int,
    manual_signin_wait_minutes: int,
) -> Dict[str, Any]:
    assert_playwright_available()

    bot_admit_deadline_utc = meeting_start_utc + timedelta(
        minutes=bot_join_deadline_minutes_after_start
    )
    results: Dict[str, Any] = {
        "joined_host": False,
        "admitted_bot": False,
        "share_started": False,
        "video_finished": False,
        "meeting_ended": False,
        "meeting_start_utc": meeting_start_utc.isoformat(),
        "bot_admit_deadline_utc": bot_admit_deadline_utc.isoformat(),
        "host_joined_at_utc": None,
    }

    profile_dir.mkdir(parents=True, exist_ok=True)

    def _clear_profile_singleton_files() -> List[str]:
        removed: List[str] = []
        for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
            path = profile_dir / name
            if not path.exists():
                continue
            try:
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink()
                removed.append(path.name)
            except Exception:
                continue
        return removed

    def _launch_context_with_lock_recovery():
        launch_kwargs = {
            "user_data_dir": str(profile_dir),
            "headless": headless,
            "args": [
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--autoplay-policy=no-user-gesture-required",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--use-fake-ui-for-media-stream",
            ],
        }
        try:
            return pw.chromium.launch_persistent_context(**launch_kwargs)
        except Exception as first_exc:
            msg = str(first_exc)
            if "ProcessSingleton" not in msg and "SingletonLock" not in msg:
                raise

            removed = _clear_profile_singleton_files()
            if removed:
                log(
                    "Detected stale Chromium profile lock files; removed "
                    f"{', '.join(sorted(removed))} and retrying launch once."
                )
            else:
                log("Detected Chromium profile lock contention; retrying launch once.")
            try:
                return pw.chromium.launch_persistent_context(**launch_kwargs)
            except Exception as retry_exc:
                raise RuntimeError(
                    "Playwright profile directory is locked by another Chromium instance. "
                    "Close any active browser using this profile or pass a different --profile-dir."
                ) from retry_exc

    with sync_playwright() as pw:
        context = _launch_context_with_lock_recovery()
        context.set_default_timeout(15000)
        teams_page = context.new_page()
        log(
            "Opening Teams join URL "
            f"(meeting_start={meeting_start_utc.isoformat()} "
            f"admit_deadline={bot_admit_deadline_utc.isoformat()})."
        )
        teams_page.goto(join_url, wait_until="domcontentloaded", timeout=120000)
        time.sleep(2)

        # Try web-join pathways.
        _click_any_role_button(
            teams_page,
            [
                re.compile(r"Join meeting from this browser", re.I),
                re.compile(r"Join on the web", re.I),
                re.compile(r"Continue on this browser", re.I),
            ],
        )
        time.sleep(2)

        if prejoin_requires_signin(teams_page):
            _click_any_role_button(
                teams_page,
                [re.compile(r"Sign in", re.I)],
            )
            if manual_signin_wait_minutes <= 0:
                artifacts = capture_browser_debug_artifacts(teams_page, "teams_signin_required")
                raise RuntimeError(
                    "Teams web pre-join requires sign-in for the host session. "
                    "Sign in with the same Playwright profile and rerun. "
                    f"Debug artifacts: {artifacts}"
                )
            log(
                "Teams sign-in is required before host join. "
                f"Waiting up to {manual_signin_wait_minutes} minutes for manual sign-in."
            )
            if not wait_for_signin_completion(teams_page, manual_signin_wait_minutes * 60):
                artifacts = capture_browser_debug_artifacts(teams_page, "teams_signin_timeout")
                raise RuntimeError(
                    "Timed out waiting for Teams sign-in completion. "
                    f"Debug artifacts: {artifacts}"
                )

        # Mute microphone if visible.
        try:
            mic = teams_page.locator('input[data-tid="toggle-mute"]').first
            if mic.count() > 0:
                cid = mic.get_attribute("data-cid") or ""
                if cid.strip().lower() == "toggle-mute-true":
                    mic.click()
        except Exception:
            pass

        # Fill name and join.
        try:
            name_input = teams_page.locator('input[type="text"]').first
            if name_input.count() > 0:
                name_input.fill(host_display_name)
        except Exception:
            pass

        for _ in range(3):
            _click_any_role_button(
                teams_page,
                [
                    re.compile(r"Join now", re.I),
                    re.compile(r"Join meeting", re.I),
                    re.compile(r"Join", re.I),
                ],
            )
            time.sleep(1)
            _click_any_role_button(
                teams_page,
                [
                    re.compile(r"Continue without audio or video", re.I),
                    re.compile(r"Continue without", re.I),
                ],
            )
            time.sleep(1)

        # Wait until in meeting.
        leave_seen = False
        deadline = time.time() + 120
        last_join_status_log = 0.0
        while time.time() < deadline:
            if prejoin_requires_signin(teams_page):
                artifacts = capture_browser_debug_artifacts(teams_page, "teams_signin_still_required")
                raise RuntimeError(
                    "Teams pre-join still requires sign-in, so host could not fully join as organizer. "
                    f"Debug artifacts: {artifacts}"
                )
            leave_count = teams_page.get_by_role("button", name=re.compile(r"Leave|Hang up", re.I)).count()
            people_count = teams_page.get_by_role("button", name=re.compile(r"People|Participants", re.I)).count()
            if leave_count > 0 or people_count > 0:
                leave_seen = True
                break
            now_ts = time.time()
            if now_ts - last_join_status_log >= 15:
                log(
                    "Waiting for host to enter meeting UI: "
                    f"leave_buttons={leave_count} people_buttons={people_count}"
                )
                last_join_status_log = now_ts
            time.sleep(2)

        if not leave_seen:
            artifacts = capture_browser_debug_artifacts(teams_page, "teams_join_timeout")
            raise RuntimeError(
                "Host did not appear to join the Teams meeting. If Teams asks for sign-in, "
                f"sign in manually and rerun. Debug artifacts: {artifacts}"
            )
        host_joined_at_utc = now_utc()
        results["joined_host"] = True
        results["host_joined_at_utc"] = host_joined_at_utc.isoformat()
        log("Host joined meeting; waiting for meeting-bot admission.")

        seconds_until_deadline = int((bot_admit_deadline_utc - host_joined_at_utc).total_seconds())
        if seconds_until_deadline <= 0:
            raise RuntimeError(
                "Bot admission deadline already passed before host fully joined. "
                f"Host joined at {host_joined_at_utc.isoformat()}, "
                f"meeting start was {meeting_start_utc.isoformat()}, "
                f"required admit-by time was {bot_admit_deadline_utc.isoformat()}."
            )

        timeout_seconds = min(bot_wait_minutes * 60, seconds_until_deadline)
        log(
            "Admission deadline set to "
            f"{bot_admit_deadline_utc.isoformat()} "
            f"(timeout={timeout_seconds}s)."
        )
        admitted = wait_for_and_admit_bot(
            teams_page=teams_page,
            bot_display_name=bot_display_name,
            timeout_seconds=timeout_seconds,
        )
        if not admitted:
            raise RuntimeError(
                f"Bot '{bot_display_name}' was not admitted by "
                f"{bot_admit_deadline_utc.isoformat()} "
                f"({bot_join_deadline_minutes_after_start} minutes after meeting start)."
            )
        results["admitted_bot"] = True

        with LocalVideoServer(video_file) as video_server:
            playback_page = context.new_page()
            playback_url = f"{video_server.base_url}/index.html"
            playback_page.goto(playback_url, wait_until="domcontentloaded", timeout=60000)
            log(f"Playback page ready: {playback_url}")

            share_started = start_share_flow(
                teams_page=teams_page,
                playback_page_title=video_server.playback_page_title,
            )
            results["share_started"] = share_started
            if not share_started:
                log("Warning: share flow could not be fully confirmed; continuing to playback.")

            finished = play_video_until_end(playback_page)
            results["video_finished"] = finished
            if not finished:
                raise RuntimeError("Video did not finish playback.")

            ended = end_teams_meeting(teams_page)
            results["meeting_ended"] = ended
            if not ended:
                log("Warning: failed to end meeting from Teams UI; continuing.")

        context.close()

    return results


def wait_for_and_admit_bot(*, teams_page, bot_display_name: str, timeout_seconds: int) -> bool:
    deadline = time.time() + timeout_seconds

    def _normalize_name(v: str) -> str:
        return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", str(v or "").lower())).strip()

    normalized_bot = _normalize_name(bot_display_name)
    bot_aliases: List[str] = [normalized_bot] if normalized_bot else []
    if normalized_bot:
        # Common bot naming variants.
        reduced = re.sub(r"\b(bot|dev|development|staging|prod|production)\b", " ", normalized_bot)
        reduced = re.sub(r"\s+", " ", reduced).strip()
        if reduced and reduced not in bot_aliases:
            bot_aliases.append(reduced)
        if reduced:
            reduced_bot = f"{reduced} bot".strip()
            if reduced_bot not in bot_aliases:
                bot_aliases.append(reduced_bot)
    # Generic fallback aliases used in this environment.
    for extra in ("meeting bot", "advisewell bot", "advisewell bot dev"):
        if extra not in bot_aliases:
            bot_aliases.append(extra)
    # Keep only non-empty aliases.
    bot_aliases = [a for a in dict.fromkeys(bot_aliases) if a]

    # Open participants pane if possible.
    _click_any_role_button(
        teams_page,
        [
            re.compile(r"People|Participants|Roster", re.I),
            re.compile(r"Show participants|Open participants", re.I),
        ],
    )

    joined_confirmations = 0
    admit_clicks = 0
    last_status_log = 0.0
    while time.time() < deadline:
        _click_any_role_button(
            teams_page,
            [
                re.compile(r"People|Participants|Roster", re.I),
                re.compile(r"Show participants|Open participants", re.I),
            ],
        )

        try:
            state = teams_page.evaluate(
                """(aliases) => {
                const norm = (v) => String(v || '').toLowerCase().replace(/\\s+/g, ' ').trim();
                const aliasList = (Array.isArray(aliases) ? aliases : [])
                    .map((v) => norm(v))
                    .filter(Boolean);
                const firstAlias = aliasList[0] || '';
                const firstToken = firstAlias.split(' ').find((t) => t.length >= 3) || '';
                const rowSelectors = [
                  '[role="row"]',
                  '[role="treeitem"]',
                  'li',
                  '[data-tid]',
                  '[class*="participant"]',
                  '[class*="roster"]',
                  '[class*="lobby"]',
                ].join(',');
                const rows = [...document.querySelectorAll(rowSelectors)];
                let botInLobby = false;
                let botInMeeting = false;
                let admitClicked = false;
                let visibleAdmitButtons = 0;
                let matchedLobbyRows = 0;
                const matchedTexts = [];
                const lobbyTexts = [];

                const buttonText = (el) =>
                    norm((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''));
                const isVisible = (el) => {
                    if (!el) return false;
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                };
                const isAdmitButton = (el) => /\\badmit\\b/i.test(buttonText(el));
                const rowMatchesBot = (rowText) =>
                    aliasList.some((a) => rowText.includes(a)) ||
                    (!!firstToken && rowText.includes(firstToken) && rowText.includes('bot'));

                for (const row of rows) {
                    const rowText = norm(row.textContent || '');
                    if (!rowText) continue;

                    const rowButtons = [...row.querySelectorAll('button,[role="button"],[role="menuitem"]')];
                    const admitBtn = rowButtons.find((b) => isAdmitButton(b) && isVisible(b));
                    if (admitBtn) {
                        visibleAdmitButtons += 1;
                    }
                    const matchesBot = rowMatchesBot(rowText);
                    if (matchesBot) {
                        matchedTexts.push(rowText.slice(0, 200));
                    }
                    if (admitBtn && matchesBot) {
                        botInLobby = true;
                        matchedLobbyRows += 1;
                        lobbyTexts.push(rowText.slice(0, 200));
                        if (!admitClicked && !admitBtn.disabled) {
                            admitBtn.click();
                            admitClicked = true;
                        }
                        continue;
                    }

                    if (matchesBot) {
                        botInMeeting = true;
                    }
                }

                if (!admitClicked && !botInLobby && visibleAdmitButtons === 1) {
                    // Safe fallback for UI variants where row text is truncated/virtualized:
                    // if exactly one visible Admit button exists, assume it is the bot waiting in lobby.
                    const globalSingle = [...document.querySelectorAll('button,[role="button"],[role="menuitem"]')]
                        .find((b) => isAdmitButton(b) && isVisible(b) && !b.disabled);
                    if (globalSingle) {
                        globalSingle.click();
                        admitClicked = true;
                        botInLobby = true;
                    }
                }

                if (!admitClicked && botInLobby) {
                    const globalAdmit = [...document.querySelectorAll('button,[role="button"],[role="menuitem"]')]
                        .find((b) => isAdmitButton(b) && isVisible(b) && !b.disabled);
                    if (globalAdmit && !/\\badmit all\\b/i.test(buttonText(globalAdmit)) ) {
                        globalAdmit.click();
                        admitClicked = true;
                    }
                }

                return {
                  botInLobby,
                  botInMeeting,
                  admitClicked,
                  visibleAdmitButtons,
                  matchedLobbyRows,
                  matchedTexts,
                  lobbyTexts,
                };
            }""",
                bot_aliases,
            )
        except Exception as exc:
            if teams_page.is_closed():
                log("Teams page closed while waiting for bot admission.")
                return False
            log(f"Admission probe failed (retrying): {exc}")
            time.sleep(3)
            continue

        bot_in_lobby = bool((state or {}).get("botInLobby"))
        bot_in_meeting = bool((state or {}).get("botInMeeting"))
        admit_clicked = bool((state or {}).get("admitClicked"))
        visible_admit_buttons = int((state or {}).get("visibleAdmitButtons") or 0)
        matched_lobby_rows = int((state or {}).get("matchedLobbyRows") or 0)

        now_ts = time.time()
        if now_ts - last_status_log >= 15:
            log(
                "Admission status: "
                f"bot_in_lobby={bot_in_lobby} bot_in_meeting={bot_in_meeting} "
                f"visible_admit_buttons={visible_admit_buttons} matched_lobby_rows={matched_lobby_rows}"
            )
            last_status_log = now_ts

        if admit_clicked:
            admit_clicks += 1
            log(f"Admit action attempted for bot '{bot_display_name}' (attempt {admit_clicks}).")
            joined_confirmations = 0
            time.sleep(4)
            continue

        if bot_in_meeting:
            joined_confirmations += 1
            if joined_confirmations >= 2:
                log(f"Bot '{bot_display_name}' appears in participant list (confirmed).")
                return True
        elif bot_in_lobby:
            joined_confirmations = 0
        else:
            joined_confirmations = 0

        time.sleep(3)
    return False


def start_share_flow(*, teams_page, playback_page_title: str) -> bool:
    _click_any_role_button(
        teams_page,
        [
            re.compile(r"Share|Present", re.I),
            re.compile(r"Share content", re.I),
        ],
    )
    time.sleep(2)

    # Toggle include sound if available.
    _click_any_role_button(
        teams_page,
        [
            re.compile(r"Include.*sound", re.I),
            re.compile(r"Share system audio", re.I),
        ],
    )

    # Try selecting the playback tab card by title text.
    try:
        title_card = teams_page.get_by_text(re.compile(re.escape(playback_page_title), re.I)).first
        if _safe_click(title_card, timeout_ms=4000):
            time.sleep(2)
    except Exception:
        pass

    # Fallback source selection.
    _click_any_role_button(
        teams_page,
        [
            re.compile(r"Screen", re.I),
            re.compile(r"Window", re.I),
            re.compile(r"Tab", re.I),
        ],
    )
    time.sleep(3)

    # Confirm sharing by checking for active-presenting controls/text.
    try:
        if teams_page.get_by_role("button", name=re.compile(r"Stop.*present|Stop.*sharing", re.I)).count() > 0:
            return True
    except Exception:
        pass
    try:
        if teams_page.get_by_text(
            re.compile(r"you're presenting|you are presenting|stop presenting|stop sharing", re.I)
        ).count() > 0:
            return True
    except Exception:
        pass
    try:
        js_state = teams_page.evaluate(
            """() => {
                const controls = [...document.querySelectorAll('button,[role="button"],[role="menuitem"]')];
                return controls.some((el) => {
                    const text = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
                    return text.includes('stop presenting') || text.includes('stop sharing');
                });
            }"""
        )
        if bool(js_state):
            return True
    except Exception:
        pass
    return False


def play_video_until_end(playback_page) -> bool:
    start = playback_page.evaluate("() => window.startPlayback ? window.startPlayback() : {started:false,duration:0}")
    if not isinstance(start, dict):
        return False
    duration = float(start.get("duration") or 0)
    if duration <= 0:
        duration = 300.0
    timeout = max(int(duration + 90), 180)
    deadline = time.time() + timeout

    last_print = 0
    last_cur = 0.0
    stagnant_since = time.time()
    while time.time() < deadline:
        state = playback_page.evaluate(
            "() => window.playbackState ? window.playbackState() : {currentTime:0,duration:0,ended:false}"
        )
        if not isinstance(state, dict):
            time.sleep(1)
            continue
        cur = float(state.get("currentTime") or 0)
        dur = float(state.get("duration") or duration or 0)
        ended = bool(state.get("ended", False))
        now_ts = time.time()
        if cur > last_cur + 0.2:
            stagnant_since = now_ts
            last_cur = cur
        if now_ts - last_print > 10:
            log(f"Playback progress: {cur:.1f}s / {dur:.1f}s")
            last_print = now_ts
        if ended or (dur > 0 and cur >= dur - 0.3):
            return True
        if dur > 0:
            near_end_threshold = max(dur * 0.95, dur - 30.0)
            if cur >= near_end_threshold and (now_ts - stagnant_since) >= 20:
                log(
                    "Playback considered complete after near-end stall: "
                    f"{cur:.1f}s / {dur:.1f}s (stalled {(now_ts - stagnant_since):.0f}s)."
                )
                return True
        time.sleep(1)
    return False


def end_teams_meeting(teams_page) -> bool:
    def _meeting_controls_visible() -> bool:
        try:
            leave_count = teams_page.get_by_role("button", name=re.compile(r"Leave|Hang up", re.I)).count()
            people_count = teams_page.get_by_role("button", name=re.compile(r"People|Participants", re.I)).count()
            return leave_count > 0 or people_count > 0
        except Exception:
            return True

    def _meeting_end_visible_hint() -> bool:
        try:
            if teams_page.is_closed():
                return True
        except Exception:
            pass
        try:
            return (
                teams_page.get_by_text(
                    re.compile(
                        r"Meeting has ended|Call ended|You left the meeting|You've left the meeting|Rejoin",
                        re.I,
                    )
                ).count()
                > 0
            )
        except Exception:
            return False

    def _wait_for_end_state(timeout_seconds: int = 12) -> bool:
        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            if _meeting_end_visible_hint():
                return True
            if not _meeting_controls_visible():
                return True
            time.sleep(1)
        return False

    def _confirm_end_dialog() -> bool:
        clicked = _click_any_role_button(
            teams_page,
            [
                re.compile(r"End meeting", re.I),
                re.compile(r"End call for everyone", re.I),
                re.compile(r"End now", re.I),
                re.compile(r"^End$", re.I),
                re.compile(r"Confirm", re.I),
            ],
            roles=("button", "menuitem"),
            timeout_ms=1600,
        )
        if clicked:
            time.sleep(1)
        return clicked

    # Clear transient overlays.
    for _ in range(2):
        try:
            teams_page.keyboard.press("Escape")
        except Exception:
            pass
        time.sleep(0.3)

    # Preferred path: end meeting for everyone.
    if _click_any_role_button(
        teams_page,
        [
            re.compile(r"End meeting", re.I),
            re.compile(r"End call for everyone", re.I),
            re.compile(r"End for everyone", re.I),
        ],
        timeout_ms=1800,
    ):
        _confirm_end_dialog()
        if _wait_for_end_state():
            return True

    # Overflow menu path.
    if _click_any_role_button(
        teams_page,
        [
            re.compile(r"More", re.I),
            re.compile(r"More actions", re.I),
            re.compile(r"More options", re.I),
            re.compile(r"Actions", re.I),
        ],
        timeout_ms=1800,
    ):
        time.sleep(1)
        if _click_any_role_button(
            teams_page,
            [
                re.compile(r"End meeting", re.I),
                re.compile(r"End call for everyone", re.I),
                re.compile(r"End for everyone", re.I),
            ],
            timeout_ms=1800,
        ):
            _confirm_end_dialog()
            if _wait_for_end_state():
                return True

    # Fallback: leave call and verify departure.
    if _click_any_role_button(
        teams_page,
        [
            re.compile(r"Leave|Hang up", re.I),
            re.compile(r"End call", re.I),
            re.compile(r"Exit", re.I),
        ],
        timeout_ms=1800,
    ):
        _confirm_end_dialog()
        return _wait_for_end_state(timeout_seconds=8)

    return False


def _normalize_status(value: Any) -> str:
    return str(value or "").strip().lower()


def _to_iso_or_none(value: Any) -> Optional[str]:
    if isinstance(value, datetime):
        return value.isoformat()
    return None


def _extract_session_id_from_meeting_doc(meeting_data: Dict[str, Any]) -> str:
    return str(
        meeting_data.get("meeting_session_id")
        or meeting_data.get("session_id")
        or ""
    ).strip()


def collect_processing_state(
    *,
    db: firestore.Client,
    org_id: str,
    source_meeting_id: Optional[str],
    session_id: str,
) -> Dict[str, Any]:
    state: Dict[str, Any] = {
        "source_meeting_id": source_meeting_id,
        "meeting_exists": False,
        "meeting_status": "",
        "meeting_recording_status": "",
        "meeting_session_status": "",
        "meeting_session_id": "",
        "meeting_updated_at": None,
        "has_transcription": False,
        "has_recording_url": False,
        "has_artifacts": False,
        "requested_session_id": session_id,
        "effective_session_id": session_id,
        "session_exists": False,
        "session_status": "",
        "session_updated_at": None,
    }

    effective_session_id = session_id
    if source_meeting_id:
        src_ref = (
            db.collection("organizations")
            .document(org_id)
            .collection("meetings")
            .document(source_meeting_id)
        )
        src_doc = src_ref.get()
        if src_doc.exists:
            src_data = src_doc.to_dict() or {}
            state["meeting_exists"] = True
            state["meeting_status"] = _normalize_status(src_data.get("status"))
            state["meeting_recording_status"] = _normalize_status(src_data.get("recording_status"))
            state["meeting_session_status"] = _normalize_status(src_data.get("session_status"))
            state["meeting_updated_at"] = _to_iso_or_none(src_data.get("updated_at"))
            state["has_transcription"] = bool(src_data.get("transcription"))
            state["has_recording_url"] = bool(str(src_data.get("recording_url") or "").strip())
            artifacts = src_data.get("artifacts")
            state["has_artifacts"] = isinstance(artifacts, dict) and bool(artifacts)

            source_session_id = _extract_session_id_from_meeting_doc(src_data)
            if source_session_id:
                state["meeting_session_id"] = source_session_id
                effective_session_id = source_session_id

    state["effective_session_id"] = effective_session_id
    if effective_session_id:
        session_ref = (
            db.collection("organizations")
            .document(org_id)
            .collection("meeting_sessions")
            .document(effective_session_id)
        )
        session_doc = session_ref.get()
        if session_doc.exists:
            session_data = session_doc.to_dict() or {}
            state["session_exists"] = True
            state["session_status"] = _normalize_status(session_data.get("status"))
            state["session_updated_at"] = _to_iso_or_none(session_data.get("updated_at"))

    return state


def processing_is_complete(state: Dict[str, Any]) -> Tuple[bool, str]:
    session_status = _normalize_status(state.get("session_status"))
    if session_status in SESSION_SUCCESS_STATUSES:
        return True, f"meeting_session.status={session_status}"

    recording_status = _normalize_status(state.get("meeting_recording_status"))
    has_transcription = bool(state.get("has_transcription"))
    has_recording_url = bool(state.get("has_recording_url"))
    has_artifacts = bool(state.get("has_artifacts"))

    if has_transcription and has_recording_url:
        return True, "meeting doc has transcription + recording_url"
    if has_transcription and has_artifacts:
        return True, "meeting doc has transcription + artifacts"
    if recording_status in RECORDING_TERMINAL_STATUSES and (has_recording_url or has_transcription):
        return True, f"meeting.recording_status={recording_status}"

    if session_status in SESSION_FAILURE_STATUSES:
        # Some environments briefly report failed/error and then recover.
        # Keep polling until timeout unless durable artifacts appear.
        return False, f"meeting_session.status={session_status} (waiting for artifacts/retry)"

    return False, "still processing"


def wait_for_processing_completion(
    *,
    db: firestore.Client,
    org_id: str,
    source_meeting_id: Optional[str],
    session_id: str,
    max_wait_seconds: int,
    poll_seconds: int = 15,
) -> Dict[str, Any]:
    start_ts = time.time()
    max_wait_seconds = max(0, int(max_wait_seconds))
    poll_seconds = max(5, int(poll_seconds))
    deadline = start_ts + max_wait_seconds

    current_session_id = session_id
    last_log_ts = 0.0
    last_state: Dict[str, Any] = {}
    last_reason = ""

    while True:
        state = collect_processing_state(
            db=db,
            org_id=org_id,
            source_meeting_id=source_meeting_id,
            session_id=current_session_id,
        )
        effective_session_id = str(state.get("effective_session_id") or "").strip()
        if effective_session_id and effective_session_id != current_session_id:
            log(
                "Processing wait updated session_id from meeting state: "
                f"{effective_session_id[:24]}..."
            )
            current_session_id = effective_session_id

        done, reason = processing_is_complete(state)
        last_state = state
        last_reason = reason
        if done:
            waited = int(time.time() - start_ts)
            log(f"Processing completion detected after {waited}s ({reason}).")
            return {
                "completed": True,
                "timed_out": False,
                "waited_seconds": waited,
                "max_wait_seconds": max_wait_seconds,
                "effective_session_id": current_session_id,
                "completion_reason": reason,
                "state": state,
            }

        now_ts = time.time()
        remaining = int(deadline - now_ts)
        if remaining <= 0:
            waited = int(now_ts - start_ts)
            log(
                "Processing completion wait timed out after "
                f"{waited}s ({reason}); proceeding to validation."
            )
            return {
                "completed": False,
                "timed_out": True,
                "waited_seconds": waited,
                "max_wait_seconds": max_wait_seconds,
                "effective_session_id": current_session_id,
                "completion_reason": reason,
                "state": last_state,
            }

        if now_ts - last_log_ts >= 60:
            log(
                "Processing status: "
                f"session_id={current_session_id[:24]}... "
                f"session_status={state.get('session_status') or 'n/a'} "
                f"meeting_status={state.get('meeting_status') or 'n/a'} "
                f"recording_status={state.get('meeting_recording_status') or 'n/a'} "
                f"transcription={bool(state.get('has_transcription'))} "
                f"recording_url={bool(state.get('has_recording_url'))} "
                f"artifacts={bool(state.get('has_artifacts'))}"
            )
            last_log_ts = now_ts

        time.sleep(min(poll_seconds, max(1, remaining)))


def collect_k8s_logs(
    *,
    kube_context: str,
    namespace: str,
    since_hours: int,
) -> Dict[str, str]:
    since = f"{since_hours}h"
    logs: Dict[str, str] = {}

    controller_cmd = [
        "kubectl",
        "--context",
        kube_context,
        "-n",
        namespace,
        "logs",
        "deploy/meeting-bot-controller",
        f"--since={since}",
        "--all-containers=true",
    ]
    cp = run_cmd(controller_cmd, timeout=90)
    logs["controller"] = (cp.stdout or "") + ("\n" + cp.stderr if cp.stderr else "")

    pods_cmd = [
        "kubectl",
        "--context",
        kube_context,
        "-n",
        namespace,
        "get",
        "pods",
        "-o",
        "json",
    ]
    pods_cp = run_cmd(pods_cmd, timeout=60)
    if pods_cp.returncode == 0 and pods_cp.stdout.strip():
        try:
            pods_data = json.loads(pods_cp.stdout)
        except json.JSONDecodeError:
            pods_data = {}
    else:
        pods_data = {}

    candidates: List[str] = []
    for item in (pods_data.get("items") or []):
        meta = item.get("metadata", {})
        spec = item.get("spec", {})
        pod_name = meta.get("name", "")
        if "meeting-bot-controller" in pod_name:
            continue
        containers = spec.get("containers") or []
        names = " ".join((c.get("name", "") + " " + c.get("image", "")) for c in containers).lower()
        if (
            "meeting-bot" in pod_name.lower()
            or "manager" in pod_name.lower()
            or "manager" in names
            or "meeting-bot" in names
        ):
            candidates.append(pod_name)

    for pod in candidates[:8]:
        pcp = run_cmd(
            [
                "kubectl",
                "--context",
                kube_context,
                "-n",
                namespace,
                "logs",
                pod,
                f"--since={since}",
                "--all-containers=true",
            ],
            timeout=90,
        )
        logs[f"pod:{pod}"] = (pcp.stdout or "") + ("\n" + pcp.stderr if pcp.stderr else "")

    return logs


def _normalize_scope_tokens(scope_tokens: Optional[Iterable[str]]) -> List[str]:
    if not scope_tokens:
        return []
    out: List[str] = []
    seen: set[str] = set()
    for raw in scope_tokens:
        token = str(raw or "").strip().lower()
        if not token:
            continue
        for candidate in (token, token[:16], token[:24]):
            candidate = candidate.strip()
            if len(candidate) < 6 or candidate in seen:
                continue
            seen.add(candidate)
            out.append(candidate)
    return out


def extract_recent_errors(
    log_blobs: Dict[str, str],
    max_lines: int = 300,
    scope_tokens: Optional[Iterable[str]] = None,
) -> Dict[str, Any]:
    regexes = [re.compile(p, re.IGNORECASE) for p in LOG_ERROR_PATTERNS]
    ignored_regexes = [re.compile(p, re.IGNORECASE) for p in LOG_BENIGN_PATTERNS]
    normalized_scope_tokens = _normalize_scope_tokens(scope_tokens)
    source_order = sorted(log_blobs.keys(), key=lambda s: ("controller" in s.lower(), s))

    # Discover correlation IDs only from lines that are known to belong to this run.
    correlation_ids: set[str] = set()
    if normalized_scope_tokens:
        for source in source_order:
            text = log_blobs.get(source, "")
            for line in text.splitlines():
                lowered = line.lower()
                if not any(token in lowered for token in normalized_scope_tokens):
                    continue
                match = CORRELATION_ID_REGEX.search(line)
                if match:
                    correlation_ids.add(match.group(1).lower())

    scope_markers = list(dict.fromkeys(normalized_scope_tokens + sorted(correlation_ids)))
    in_scope_only = bool(scope_markers)

    out: List[Dict[str, str]] = []
    seen_signatures: set[str] = set()
    for source in source_order:
        text = log_blobs.get(source, "")
        for line in text.splitlines():
            lowered = line.lower()
            if in_scope_only and not any(marker in lowered for marker in scope_markers):
                continue
            if any(ignored.search(line) for ignored in ignored_regexes):
                continue
            if any(r.search(line) for r in regexes):
                signature = re.sub(r"\s+", " ", line.strip()).lower()
                # Prevent repeated noisy lines from crowding distinct issues.
                if signature in seen_signatures:
                    continue
                seen_signatures.add(signature)
                out.append({"source": source, "line": line[:2000]})
                if len(out) >= max_lines:
                    return {
                        "errors": out,
                        "scope_tokens": normalized_scope_tokens,
                        "correlation_ids": sorted(correlation_ids),
                        "scope_markers": scope_markers,
                        "ignored_patterns": LOG_BENIGN_PATTERNS,
                        "in_scope_only": in_scope_only,
                    }
    return {
        "errors": out,
        "scope_tokens": normalized_scope_tokens,
        "correlation_ids": sorted(correlation_ids),
        "scope_markers": scope_markers,
        "ignored_patterns": LOG_BENIGN_PATTERNS,
        "in_scope_only": in_scope_only,
    }


def gs_path_exists(storage_client: storage.Client, bucket: str, gs_path: str) -> bool:
    if not gs_path.startswith("gs://"):
        return False
    no_proto = gs_path[5:]
    if "/" not in no_proto:
        return False
    bucket_name, blob_path = no_proto.split("/", 1)
    if bucket_name != bucket:
        # Validate existence in the declared bucket only.
        return False
    return storage_client.bucket(bucket).blob(blob_path).exists()


def validate_firestore_and_gcs(
    *,
    db: firestore.Client,
    gcs_client: storage.Client,
    bucket: str,
    org_id: str,
    session_id: str,
    source_meeting_id: Optional[str],
    require_session_doc: bool = False,
) -> Dict[str, Any]:
    report: Dict[str, Any] = {
        "session_id": session_id,
        "session_exists": False,
        "source_meeting_id": source_meeting_id,
        "checks": [],
        "missing": [],
        "warnings": [],
    }

    session_ref = (
        db.collection("organizations")
        .document(org_id)
        .collection("meeting_sessions")
        .document(session_id)
    )
    session_doc = session_ref.get()
    if session_doc.exists:
        report["session_exists"] = True
    else:
        msg = "meeting_sessions/{session_id} document not found"
        if require_session_doc:
            report["missing"].append(msg)
        else:
            report["warnings"].append(msg)

    subscriber_records: List[Dict[str, str]] = []
    if session_doc.exists:
        for sub in session_ref.collection("subscribers").stream():
            d = sub.to_dict() or {}
            user_id = str(d.get("user_id") or sub.id)
            meeting_id = str(d.get("fs_meeting_id") or "")
            if user_id and meeting_id:
                subscriber_records.append({"user_id": user_id, "meeting_id": meeting_id})

    if not subscriber_records and source_meeting_id:
        report["checks"].append(
            {
                "scope": "fallback_source_only",
                "reason": "No subscribers found in session; validating source meeting only.",
            }
        )

    if not subscriber_records and source_meeting_id:
        src_ref = (
            db.collection("organizations")
            .document(org_id)
            .collection("meetings")
            .document(source_meeting_id)
        )
        src_doc = src_ref.get()
        if src_doc.exists:
            src_data = src_doc.to_dict() or {}
            user_id = str(src_data.get("user_id") or src_data.get("synced_by_user_id") or "")
            if user_id:
                subscriber_records.append({"user_id": user_id, "meeting_id": source_meeting_id})

    bucket_client = gcs_client.bucket(bucket)
    for rec in subscriber_records:
        user_id = rec["user_id"]
        meeting_id = rec["meeting_id"]
        meeting_ref = (
            db.collection("organizations")
            .document(org_id)
            .collection("meetings")
            .document(meeting_id)
        )
        meeting_doc = meeting_ref.get()
        if not meeting_doc.exists:
            report["missing"].append(f"Meeting doc missing: organizations/{org_id}/meetings/{meeting_id}")
            continue

        meeting_data = meeting_doc.to_dict() or {}
        meeting_doc_path = f"organizations/{org_id}/meetings/{meeting_id}"
        transcription_value = meeting_data.get("transcription")
        recording_url = str(meeting_data.get("recording_url") or "")
        artifacts = meeting_data.get("artifacts") or {}
        expected_gcs_prefix = f"gs://{bucket}/recordings/{user_id}/{meeting_id}/"
        check: Dict[str, Any] = {
            "user_id": user_id,
            "meeting_id": meeting_id,
            "firebase_meeting_doc_path": meeting_doc_path,
            "has_transcription": bool(transcription_value),
            "transcription": transcription_value,
            "has_recording_url": bool(recording_url),
            "recording_url": recording_url,
            "has_artifacts": bool(artifacts),
            "artifacts": artifacts if isinstance(artifacts, dict) else {},
            "gcs_prefix": f"recordings/{user_id}/{meeting_id}/",
            "expected_gcs_prefix": expected_gcs_prefix,
            "gcs_blob_count": 0,
            "gcs_recording_present": False,
            "gcs_transcript_present": False,
        }

        if not check["has_transcription"]:
            report["missing"].append(
                f"Missing transcription in {meeting_doc_path} "
                f"(expected transcript under {expected_gcs_prefix})"
            )
        if not check["has_recording_url"]:
            report["missing"].append(
                f"Missing recording_url in {meeting_doc_path} "
                f"(expected recording under {expected_gcs_prefix})"
            )
        if not check["has_artifacts"]:
            report["missing"].append(f"Missing artifacts map in {meeting_doc_path}")

        if recording_url:
            recording_exists = gs_path_exists(gcs_client, bucket, recording_url)
            check["recording_url_exists"] = recording_exists
            if not recording_exists:
                report["missing"].append(
                    f"recording_url target missing in bucket for {meeting_doc_path}: {recording_url}"
                )

        if isinstance(artifacts, dict):
            missing_artifacts: List[str] = []
            for k, v in artifacts.items():
                path = str(v)
                if path.startswith("gs://") and not gs_path_exists(gcs_client, bucket, path):
                    missing_artifacts.append(f"{k} -> {path}")
            check["missing_artifacts"] = missing_artifacts
            if missing_artifacts:
                report["missing"].append(
                    f"Missing artifact blobs for {meeting_doc_path}: {', '.join(missing_artifacts[:5])}"
                )

        blobs = list(bucket_client.list_blobs(prefix=check["gcs_prefix"], max_results=100))
        check["gcs_blob_count"] = len(blobs)
        names = [b.name.lower() for b in blobs]
        check["gcs_recording_present"] = any("recording." in n for n in names)
        check["gcs_transcript_present"] = any("transcript" in n for n in names)
        if not check["gcs_recording_present"]:
            report["missing"].append(f"No recording file under {expected_gcs_prefix}")
        if not check["gcs_transcript_present"]:
            report["missing"].append(f"No transcript file under {expected_gcs_prefix}")

        report["checks"].append(check)

    if not subscriber_records:
        report["missing"].append("No meeting records available for validation")

    report["ok"] = len(report["missing"]) == 0
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Automated Teams meeting-bot validation (calendar-driven)"
    )
    parser.add_argument(
        "--video-file",
        help="Path to local video file to play and share. If omitted, latest video from ~/Downloads is used.",
    )
    parser.add_argument("--user-email", default=DEFAULT_USER_EMAIL)
    parser.add_argument("--user-id", help="Optional direct Firestore user doc ID override.")
    parser.add_argument("--organization-id", help="Optional org override.")
    parser.add_argument("--bot-display-name", help="Optional bot name override.")
    parser.add_argument("--host-display-name", default="Matt (Host)")

    parser.add_argument("--gcp-project", default=DEFAULT_GCP_PROJECT)
    parser.add_argument("--bucket", default=DEFAULT_BUCKET)
    parser.add_argument("--firestore-database", default="(default)")
    parser.add_argument("--kube-context", default=DEFAULT_KUBE_CONTEXT)
    parser.add_argument("--namespace", default=DEFAULT_KUBE_NAMESPACE)
    parser.add_argument("--profile-dir", default=str(Path("~/.cache/teams-e2e-playwright").expanduser()))
    parser.add_argument(
        "--ms-env-file",
        help=(
            "Optional dotenv file to load MS_CLIENT_ID/MS_CLIENT_SECRET/MS_TENANT_ID "
            "before token refresh."
        ),
    )
    parser.add_argument("--log-window-hours", type=int, default=1)
    parser.add_argument(
        "--skip-index-ensure",
        action="store_true",
        help="Skip Firestore COLLECTION_GROUP index readiness check/repair.",
    )
    parser.add_argument(
        "--index-wait-seconds",
        type=int,
        default=420,
        help="Max seconds to wait for required Firestore indexes to reach READY.",
    )
    parser.add_argument(
        "--fail-on-recent-errors",
        action="store_true",
        help="Mark run as failed when recent AKS log errors are detected.",
    )
    parser.add_argument("--process-wait-minutes", type=int, default=10)
    parser.add_argument(
        "--process-poll-seconds",
        type=int,
        default=15,
        help="Polling interval used while waiting for session processing completion.",
    )
    parser.add_argument(
        "--meeting-duration-minutes",
        type=int,
        default=30,
        help="Retained for compatibility; meeting end is intentionally set equal to start.",
    )
    parser.add_argument("--join-lead-minutes", type=int, default=3)
    parser.add_argument("--bot-wait-minutes", type=int, default=20)
    parser.add_argument(
        "--bot-join-deadline-minutes-after-start",
        type=int,
        default=2,
        help="Fail if bot has not been admitted by this many minutes after meeting start.",
    )
    parser.add_argument("--calendar-sync-wait-minutes", type=int, default=8)
    parser.add_argument(
        "--skip-queue-after-sync",
        action="store_true",
        help="Do not force-queue the synced meeting doc after discovery.",
    )
    parser.add_argument(
        "--require-session-doc",
        action="store_true",
        help="Fail validation if meeting_sessions/{session_id} is missing.",
    )
    parser.add_argument(
        "--manual-signin-wait-minutes",
        type=int,
        default=0,
        help="If sign-in is required in Teams pre-join, wait this many minutes for manual completion.",
    )
    parser.add_argument("--title-prefix", default="Automated Meeting Bot E2E")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--dry-run", action="store_true")

    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report: Dict[str, Any] = {
        "started_at_utc": now_utc().isoformat(),
        "config": vars(args),
        "phases": {},
        "success": False,
    }

    loaded_ms_env_file = ensure_ms_graph_refresh_env(args.ms_env_file)
    if loaded_ms_env_file:
        report["resolved_ms_env_file"] = loaded_ms_env_file

    video_file = Path(args.video_file).expanduser() if args.video_file else None
    if video_file is None:
        discovered = find_latest_video(Path("~/Downloads").expanduser())
        if discovered is None:
            print(
                "No --video-file provided and no video found in ~/Downloads.",
                file=sys.stderr,
            )
            return 2
        video_file = discovered
        log(f"Using latest video from ~/Downloads: {video_file}")
    if not video_file.exists():
        print(f"Video file not found: {video_file}", file=sys.stderr)
        return 2

    db = firestore.Client(project=args.gcp_project, database=args.firestore_database)
    gcs_client = storage.Client(project=args.gcp_project)

    try:
        # Ensure required Firestore indexes for controller queries are ready.
        phase_start = now_utc()
        if args.dry_run or args.skip_index_ensure:
            index_result: Dict[str, Any] = {
                "ready": True,
                "skipped": True,
                "reason": "dry_run" if args.dry_run else "skip_index_ensure",
            }
        else:
            index_result = ensure_required_firestore_indexes(
                project=args.gcp_project,
                database=args.firestore_database,
                wait_timeout_seconds=args.index_wait_seconds,
            )
        report["phases"]["firestore_index_readiness"] = {
            "started_at": phase_start.isoformat(),
            "ended_at": now_utc().isoformat(),
            "result": index_result,
        }

        # Resolve user/org/bot defaults.
        phase_start = now_utc()
        identity = resolve_identity(
            db,
            user_email=args.user_email,
            user_id_override=args.user_id,
            org_override=args.organization_id,
            bot_display_name_override=args.bot_display_name,
            user_id_fallback=DEFAULT_USER_ID_FALLBACK,
            org_fallback=DEFAULT_ORG_FALLBACK,
        )
        report["phases"]["resolve_identity"] = {
            "started_at": phase_start.isoformat(),
            "ended_at": now_utc().isoformat(),
            "identity": {
                "user_id": identity.user_id,
                "user_email": identity.user_email,
                "organization_id": identity.organization_id,
                "auto_join_meetings": identity.auto_join_meetings,
                "bot_display_name": identity.bot_display_name,
            },
        }
        log(
            "Resolved identity "
            f"user={identity.user_email} user_id={identity.user_id} "
            f"org={identity.organization_id} bot_name={identity.bot_display_name} "
            f"auto_join={identity.auto_join_meetings}"
        )

        # Graph token + create meeting.
        phase_start = now_utc()
        scheduled_start_utc = next_slot_at_least_10_minutes(now_utc())
        if args.dry_run:
            created = {
                "graph_event_id": "dry-run-event",
                "subject": f"{args.title_prefix} DRY RUN",
                "join_url": f"https://teams.microsoft.com/l/meetup-join/dry-run-{int(time.time())}",
                "start_utc": scheduled_start_utc.isoformat(),
                "end_utc": scheduled_start_utc.isoformat(),
                "raw_event": {},
                "dry_run": True,
            }
        else:
            user_ref = db.collection("users").document(identity.user_id)
            user_data = get_user_doc(db, identity.user_id)
            graph_access_token, _ = maybe_refresh_graph_token(
                user_doc_ref=user_ref,
                user_data=user_data,
            )
            created = create_teams_meeting(
                access_token=graph_access_token,
                start_utc=scheduled_start_utc,
                duration_minutes=args.meeting_duration_minutes,
                organizer_email=identity.user_email,
                title_prefix=args.title_prefix,
            )
        join_url = created["join_url"]
        session_id = compute_session_id(identity.organization_id, join_url)
        initial_session_id = session_id
        report["phases"]["schedule_meeting"] = {
            "started_at": phase_start.isoformat(),
            "ended_at": now_utc().isoformat(),
            "meeting": created,
            "session_id": session_id,
        }
        log(
            "Created Teams meeting "
            f"event_id={created.get('graph_event_id')} start={created['start_utc']} "
            f"join_url={join_url[:90]}..."
        )

        # Wait for calendar sync + set ai_assistant if needed.
        phase_start = now_utc()
        source_meeting_id = None
        source_meeting_doc = None
        source_meeting_session_id = None
        if not args.dry_run:
            found = wait_for_meeting_doc(
                db,
                org_id=identity.organization_id,
                user_id=identity.user_id,
                graph_event_id=created.get("graph_event_id"),
                meeting_url=join_url,
                scheduled_start_utc=scheduled_start_utc,
                timeout_seconds=args.calendar_sync_wait_minutes * 60,
            )
            if found:
                source_meeting_id, source_meeting_doc = found
                log(f"Found synced Firestore meeting doc: {source_meeting_id}")
                source_meeting_session_id = str(
                    (source_meeting_doc or {}).get("meeting_session_id")
                    or (source_meeting_doc or {}).get("session_id")
                    or ""
                ).strip() or None
                if source_meeting_session_id:
                    session_id = source_meeting_session_id
                    log(
                        "Using session_id from meeting document: "
                        f"{session_id[:24]}..."
                    )
                if not identity.auto_join_meetings:
                    set_ai_assistant_enabled(
                        db,
                        org_id=identity.organization_id,
                        meeting_id=source_meeting_id,
                        enabled=True,
                    )
                    log(
                        "auto_join_meetings is disabled for user; set "
                        f"ai_assistant_enabled=true on meeting {source_meeting_id}"
                    )
                if not args.skip_queue_after_sync:
                    queued_start = queue_meeting_for_recording(
                        db,
                        org_id=identity.organization_id,
                        meeting_id=source_meeting_id,
                        start_offset_minutes=2,
                        enable_ai_assistant=True,
                    )
                    log(
                        f"Queued meeting {source_meeting_id} for recording; "
                        f"controller trigger start={queued_start.isoformat()}"
                    )
            else:
                log(
                    "Did not find synced Firestore meeting document before join window. "
                    "Continuing anyway."
                )
        report["phases"]["calendar_sync_observation"] = {
            "started_at": phase_start.isoformat(),
            "ended_at": now_utc().isoformat(),
            "source_meeting_id": source_meeting_id,
            "source_meeting_found": bool(source_meeting_id),
            "initial_session_id": initial_session_id,
            "source_meeting_session_id": source_meeting_session_id,
            "effective_session_id": session_id,
        }

        # Join and run playback flow.
        phase_start = now_utc()
        join_at = scheduled_start_utc - timedelta(minutes=args.join_lead_minutes)
        ui_result: Dict[str, Any]
        browser_error: Optional[str] = None
        if not args.dry_run:
            wait_until(join_at, "host join window")
            try:
                ui_result = join_meeting_as_host(
                    join_url=join_url,
                    host_display_name=args.host_display_name,
                    profile_dir=Path(args.profile_dir).expanduser(),
                    headless=args.headless,
                    bot_display_name=identity.bot_display_name,
                    video_file=video_file,
                    meeting_start_utc=scheduled_start_utc,
                    bot_join_deadline_minutes_after_start=args.bot_join_deadline_minutes_after_start,
                    bot_wait_minutes=args.bot_wait_minutes,
                    manual_signin_wait_minutes=args.manual_signin_wait_minutes,
                )
            except Exception as exc:  # noqa: BLE001
                ui_result = {}
                browser_error = str(exc)
        else:
            ui_result = {"dry_run": True}
        report["phases"]["browser_flow"] = {
            "started_at": phase_start.isoformat(),
            "ended_at": now_utc().isoformat(),
            "result": ui_result,
            "error": browser_error,
        }
        if browser_error:
            raise RuntimeError(browser_error)

        # Wait for processing.
        phase_start = now_utc()
        processing_result: Dict[str, Any]
        if not args.dry_run:
            processing_result = wait_for_processing_completion(
                db=db,
                org_id=identity.organization_id,
                source_meeting_id=source_meeting_id,
                session_id=session_id,
                max_wait_seconds=args.process_wait_minutes * 60,
                poll_seconds=args.process_poll_seconds,
            )
            processed_session_id = str(processing_result.get("effective_session_id") or "").strip()
            if processed_session_id and processed_session_id != session_id:
                log(
                    "Updated validation session_id from processing wait: "
                    f"{processed_session_id[:24]}..."
                )
                session_id = processed_session_id
        else:
            processing_result = {"dry_run": True, "completed": True, "waited_seconds": 0}
        report["phases"]["processing_wait"] = {
            "started_at": phase_start.isoformat(),
            "ended_at": now_utc().isoformat(),
            "wait_minutes": args.process_wait_minutes,
            "result": processing_result,
        }

        # Logs + errors.
        phase_start = now_utc()
        processing_state = (
            processing_result.get("state", {})
            if isinstance(processing_result, dict)
            else {}
        )
        log_scope_tokens: List[str] = [
            session_id,
            initial_session_id,
            source_meeting_id or "",
            source_meeting_session_id or "",
            str(processing_state.get("effective_session_id") or ""),
            str(processing_state.get("meeting_session_id") or ""),
            str(processing_state.get("requested_session_id") or ""),
        ]
        logs = (
            collect_k8s_logs(
                kube_context=args.kube_context,
                namespace=args.namespace,
                since_hours=args.log_window_hours,
            )
            if not args.dry_run
            else {}
        )
        error_scan = (
            extract_recent_errors(logs, scope_tokens=log_scope_tokens)
            if not args.dry_run
            else {
                "errors": [],
                "scope_tokens": [],
                "correlation_ids": [],
                "scope_markers": [],
                "ignored_patterns": LOG_BENIGN_PATTERNS,
                "in_scope_only": False,
            }
        )
        errors = list(error_scan.get("errors") or [])
        report["phases"]["kubernetes_logs"] = {
            "started_at": phase_start.isoformat(),
            "ended_at": now_utc().isoformat(),
            "sources": list(logs.keys()),
            "in_scope_only": bool(error_scan.get("in_scope_only")),
            "scope_tokens": error_scan.get("scope_tokens") or [],
            "scope_markers": error_scan.get("scope_markers") or [],
            "correlation_ids": error_scan.get("correlation_ids") or [],
            "ignored_patterns": error_scan.get("ignored_patterns") or [],
            "error_count": len(errors),
            "errors": errors[:200],
        }

        # Validation.
        phase_start = now_utc()
        if not args.dry_run and source_meeting_id:
            latest_source_doc = (
                db.collection("organizations")
                .document(identity.organization_id)
                .collection("meetings")
                .document(source_meeting_id)
                .get()
            )
            if latest_source_doc.exists:
                latest_source_data = latest_source_doc.to_dict() or {}
                latest_session_id = str(
                    latest_source_data.get("meeting_session_id")
                    or latest_source_data.get("session_id")
                    or ""
                ).strip()
                if latest_session_id and latest_session_id != session_id:
                    log(
                        "Updated validation session_id from latest meeting doc: "
                        f"{latest_session_id[:24]}..."
                    )
                    session_id = latest_session_id
        validation = (
            validate_firestore_and_gcs(
                db=db,
                gcs_client=gcs_client,
                bucket=args.bucket,
                org_id=identity.organization_id,
                session_id=session_id,
                source_meeting_id=source_meeting_id,
                require_session_doc=args.require_session_doc,
            )
            if not args.dry_run
            else {"ok": True, "missing": [], "checks": [], "dry_run": True}
        )
        report["phases"]["validation"] = {
            "started_at": phase_start.isoformat(),
            "ended_at": now_utc().isoformat(),
            "result": validation,
        }

        success = bool(validation.get("ok")) and (
            not args.fail_on_recent_errors or len(errors) == 0
        )
        report["success"] = success
        report["ended_at_utc"] = now_utc().isoformat()

        report_path = Path.cwd() / f"teams_e2e_report_{int(time.time())}.json"
        report_path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
        print("\n=== RUN SUMMARY ===")
        print(f"Report: {report_path}")
        print(f"Success: {success}")
        if errors:
            print(f"Recent errors found (last {args.log_window_hours}h): {len(errors)}")
        missing = validation.get("missing", [])
        if missing:
            print("Missing outputs:")
            for item in missing[:20]:
                print(f"  - {item}")
        warnings = validation.get("warnings", [])
        if warnings:
            print("Warnings:")
            for item in warnings[:20]:
                print(f"  - {item}")
        if not errors and not missing:
            print("No recent errors and all expected outputs were present.")
        return 0 if success else 1

    except KeyboardInterrupt:
        print("\nInterrupted by user.")
        return 130
    except Exception as exc:  # noqa: BLE001
        report["success"] = False
        report["ended_at_utc"] = now_utc().isoformat()
        report["fatal_error"] = str(exc)
        report_path = Path.cwd() / f"teams_e2e_report_{int(time.time())}.json"
        report_path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
        print(f"Fatal error: {exc}", file=sys.stderr)
        print(f"Partial report written: {report_path}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
