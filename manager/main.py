#!/usr/bin/env python3
"""Meeting Bot Manager - Job Execution

This module is operational and includes long log lines and pipeline strings,
so we ignore line-length linting here.

# flake8: noqa: E501
# type: ignore

This manager processes a single meeting recording job:
1. Reads job details from environment variables
2. Initiates meeting join via meeting-bot API
3. Monitors meeting status
4. Uploads the original WEBM to GCS
5. Transcribes using the WEBM (optional)

Designed to run as a Kubernetes Job, spawned by the controller.
"""

import os
import sys
import logging
import json
import time
from typing import Any, Dict, List, Optional, Tuple
import tempfile
from pathlib import Path
from datetime import datetime, timezone

from meeting_monitor import MeetingMonitor
from metadata import load_meeting_metadata

# Configure logging ────────────────────────────────────────────────────────────
# Default to JSON for production (better Sentry / GCP Logging integration).
# Set LOG_FORMAT=text for human-readable output during local development.
_log_level_name = os.getenv("LOG_LEVEL", "DEBUG").upper()
_log_level = getattr(logging, _log_level_name, logging.DEBUG)

_handler = logging.StreamHandler(sys.stdout)

if os.getenv("LOG_FORMAT", "json").lower() == "text":
    _handler.setFormatter(
        logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
    )
else:
    from pythonjsonlogger.json import JsonFormatter

    _handler.setFormatter(
        JsonFormatter(
            fmt="%(asctime)s %(name)s %(levelname)s %(message)s",
            rename_fields={
                "asctime": "timestamp",
                "levelname": "level",
                "name": "logger",
            },
            static_fields={"component": "manager"},
        )
    )

logging.basicConfig(level=_log_level, handlers=[_handler])

logger = logging.getLogger(__name__)

# Initialise Sentry early (before any other work)
from sentry_integration import initialise_sentry, capture_error_safe, flush_sentry

initialise_sentry(component="manager")


def _scratch_root() -> str:
    """Prefer a PVC-backed scratch directory if mounted."""
    # /scratch is mounted by the controller when a RWX PVC is available.
    # Fall back to /tmp for local/dev.
    return "/scratch" if os.path.isdir("/scratch") else "/tmp"


def _should_cleanup_scratch() -> bool:
    """Whether to delete per-meeting scratch dirs after successful processing."""
    # Default on: keeps shared RWX PVC from filling up over time.
    return os.environ.get("CLEANUP_SCRATCH", "true").strip().lower() in {
        "1",
        "true",
        "yes",
        "y",
    }


def _cleanup_meeting_scratch_dir(path: str) -> None:
    """Best-effort delete of the per-meeting scratch directory."""
    if not path:
        return

    abs_path = os.path.abspath(path)

    # Safety: only allow delete inside /scratch/meetings/<id>
    allowed_prefix = os.path.abspath("/scratch/meetings") + os.sep
    if not abs_path.startswith(allowed_prefix):
        logger.warning("Skipping scratch cleanup outside allowed prefix: %s", abs_path)
        return

    # Extra safety: don’t delete the root meetings dir.
    if abs_path.rstrip(os.sep) == os.path.abspath("/scratch/meetings"):
        logger.warning("Skipping scratch cleanup of root meetings dir")
        return

    try:
        import shutil

        shutil.rmtree(abs_path, ignore_errors=True)
        logger.info("Cleaned up scratch workspace: %s", abs_path)
    except Exception as e:
        logger.warning("Scratch cleanup failed (ignored): %s", e)


def _env_flag(var_name: str, *, default: bool) -> bool:
    raw = os.environ.get(var_name)
    if raw is None or raw.strip() == "":
        return default

    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False

    logger.warning(
        "Invalid boolean env %s=%r; using default=%s",
        var_name,
        raw,
        default,
    )
    return default


def _env_float(
    var_name: str,
    *,
    default: float,
    min_value: Optional[float] = None,
    max_value: Optional[float] = None,
) -> float:
    raw = os.environ.get(var_name)
    if raw is None or raw.strip() == "":
        return default

    try:
        value = float(raw)
    except ValueError:
        logger.warning(
            "Invalid float env %s=%r; using default=%s",
            var_name,
            raw,
            default,
        )
        return default

    if min_value is not None and value < min_value:
        logger.warning(
            "Float env %s=%s below minimum %s; using default=%s",
            var_name,
            value,
            min_value,
            default,
        )
        return default

    if max_value is not None and value > max_value:
        logger.warning(
            "Float env %s=%s above maximum %s; using default=%s",
            var_name,
            value,
            max_value,
            default,
        )
        return default

    return value


# Reduce noise from some verbose libraries
logging.getLogger("google.auth").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)
logging.getLogger("google.cloud").setLevel(logging.INFO)


class MeetingManager:
    """Main manager for processing a single meeting recording job"""

    def __init__(self):
        # Required environment variables for the meeting job
        self.meeting_url = os.environ.get("MEETING_URL")
        self.meeting_id = os.environ.get("MEETING_ID")
        self.fs_meeting_id = os.environ.get(
            "FS_MEETING_ID"
        )  # Firestore-specific meeting ID

        # Session-based consolidation: if set, this job is for a deduplicated
        # meeting session and we must update the session status on completion.
        self.meeting_session_id = (
            os.environ.get("MEETING_SESSION_ID")
            or os.environ.get("meeting_session_id")
            or ""
        ).strip()
        self.user_id = (
            os.environ.get("USER_ID")
            or os.environ.get("user_id")
            or os.environ.get("FS_USER_ID")
            or os.environ.get("fs_user_id")
        )
        self.team_id = (
            os.environ.get("teamId")
            or os.environ.get("TEAMID")
            or os.environ.get("team_id")
            or os.environ.get("TEAM_ID")
            or ""
        )
        self.gcs_path = os.environ.get("GCS_PATH")

        # Storage layout is typically:
        #   recordings/<user_firebase_document_id>/<meeting_firebase_document_id>/...
        #
        # However, for session-dedupe runs we intentionally allow a canonical
        # shared prefix:
        #   recordings/sessions/<meeting_session_id>/...
        #
        # For backward compatibility we accept legacy values, but we normalize
        # into the canonical prefix as early as possible.
        explicit_gcs_path = (self.gcs_path or "").strip()
        is_canonical_session_path = explicit_gcs_path.startswith("recordings/sessions/")

        # USER_ID should never be blank for per-user recording jobs. Fail fast
        # here so we don't run an hours-long job only to be unable to locate
        # the recording volume directory at the end.
        if isinstance(self.user_id, str):
            self.user_id = self.user_id.strip()

        if not is_canonical_session_path and not self.user_id:
            raise ValueError(
                "Missing USER_ID for recording job. Refusing to start. "
                "Set USER_ID (or user_id/FS_USER_ID) in the manager env."
            )

        if is_canonical_session_path:
            # Respect explicit canonical session path as-is.
            self.gcs_path = explicit_gcs_path
        else:
            storage_meeting_id = self.fs_meeting_id or self.meeting_id
            if storage_meeting_id and self.user_id:
                self.gcs_path = f"recordings/{self.user_id}/{storage_meeting_id}"
            elif storage_meeting_id:
                # Backward-compatible prefix (meeting only) when user id is unknown.
                self.gcs_path = f"recordings/{storage_meeting_id}"
            elif self.gcs_path:
                # Last-resort fallback if FS_MEETING_ID/MEETING_ID are missing.
                # Keep existing behavior: accept bare ids.
                if (
                    not self.gcs_path.startswith("recordings/")
                    and "/" not in self.gcs_path
                ):
                    self.gcs_path = f"recordings/{self.gcs_path}"

        # Optional meeting metadata
        self.metadata = load_meeting_metadata(
            meeting_id=self.meeting_id,
            gcs_path=self.gcs_path,
        )

        # GCS and API configuration
        self.gcs_bucket = os.environ.get("GCS_BUCKET")
        self.firestore_database = os.environ.get(
            "FIRESTORE_DATABASE",
            "(default)",
        )
        self.meeting_bot_api = os.environ.get(
            "MEETING_BOT_API_URL", "http://localhost:3000"
        )

        # Transcription mode:
        # - offline (default): whisper.cpp + offline diarization
        # - azure: Azure Speech fast transcription (AU endpoints only)
        # - gemini: use Gemini for transcription (requires cloud access)
        # - none: skip transcription entirely
        raw_transcription_mode = (
            os.environ.get("TRANSCRIPTION_MODE", "offline").strip().lower()
        )
        if raw_transcription_mode == "online":
            logger.warning(
                "TRANSCRIPTION_MODE=online is deprecated; mapping to gemini"
            )
        self.transcription_mode = {
            "online": "gemini",
        }.get(raw_transcription_mode, raw_transcription_mode)
        self.transcription_client = None
        self.azure_speech_config = None
        self.azure_speech_fallback_to_offline = _env_flag(
            "AZURE_SPEECH_FALLBACK_TO_OFFLINE",
            default=True,
        )

        # Offline pipeline options (used by offline mode and Azure fallback).
        self.offline_language = os.environ.get(
            "OFFLINE_TRANSCRIPTION_LANGUAGE", "en"
        ).strip()
        self.offline_max_speakers = int(os.environ.get("OFFLINE_MAX_SPEAKERS", "6"))
        self.generate_mp4_artifact = _env_flag(
            "GENERATE_MP4_ARTIFACT",
            default=True,
        )
        self.speaker_identity_min_confidence = _env_float(
            "SPEAKER_IDENTITY_MIN_CONFIDENCE",
            default=0.85,
            min_value=0.5,
            max_value=1.0,
        )
        self.visual_augmentation_config = None

        # Validate required and mode-specific environment variables.
        self._validate_config()

        # Clients and heavy deps are initialized lazily in process_meeting()
        # after config validation. This keeps startup fast and avoids import-time
        # failures in minimal environments.
        self.meeting_monitor = MeetingMonitor(self.meeting_bot_api)
        self.storage_client = None
        self.firestore_client = None

        from speaker_identity import load_visual_augmentation_config_from_env

        self.visual_augmentation_config = load_visual_augmentation_config_from_env(
            logger=logger
        )

        logger.info("Transcription backend selected: %s", self.transcription_mode)
        logger.info(
            "Azure->offline fallback enabled: %s",
            self.azure_speech_fallback_to_offline,
        )
        logger.info("MP4 artifact generation enabled: %s", self.generate_mp4_artifact)
        logger.info(
            "Speaker identity confidence threshold: %.2f",
            self.speaker_identity_min_confidence,
        )
        logger.info(
            "Visual speaker augmentation enabled: %s",
            getattr(self.visual_augmentation_config, "enabled", False),
        )

    def _init_clients(self) -> None:
        """Initialize optional clients that pull in heavier dependencies."""

        if self.storage_client and self.firestore_client:
            return

        from storage_client import StorageClient, FirestoreClient

        self.storage_client = StorageClient(self.gcs_bucket)
        self.firestore_client = FirestoreClient(
            database=self.firestore_database, org_id=self.team_id
        )

        if self.transcription_mode == "gemini" and self.transcription_client is None:
            from transcription_client import TranscriptionClient

            self.transcription_client = TranscriptionClient(
                project_id=os.environ.get(
                    "GEMINI_PROJECT_ID",
                    "aw-gemini-api-central",
                )
            )
        elif self.transcription_mode == "azure" and self.transcription_client is None:
            from azure_speech_transcription import (
                AzureSpeechTranscriptionAdapter,
                load_azure_speech_config_from_env,
            )

            if self.azure_speech_config is None:
                self.azure_speech_config = load_azure_speech_config_from_env()
            self.transcription_client = AzureSpeechTranscriptionAdapter(
                self.azure_speech_config
            )

    def _validate_config(self):
        """Validate required environment variables"""
        required_vars = {
            "MEETING_URL": self.meeting_url,
            "MEETING_ID": self.meeting_id,
            "GCS_PATH": self.gcs_path,
            "GCS_BUCKET": self.gcs_bucket,
        }

        missing = [k for k, v in required_vars.items() if not v]
        if missing:
            raise ValueError(
                f"Missing required environment variables: {', '.join(missing)}"
            )

        valid_modes = {"offline", "gemini", "azure", "none"}
        if self.transcription_mode not in valid_modes:
            raise ValueError(
                "Invalid TRANSCRIPTION_MODE="
                f"{self.transcription_mode!r}. Expected one of: "
                f"{', '.join(sorted(valid_modes))}"
            )

        if self.transcription_mode == "azure":
            from azure_speech_transcription import load_azure_speech_config_from_env

            self.azure_speech_config = load_azure_speech_config_from_env()
            if self.azure_speech_config.diarization_enabled:
                logger.info(
                    "Azure Speech config validated for AU region %s with diarization "
                    "(max_speakers=%d)",
                    self.azure_speech_config.region,
                    self.azure_speech_config.diarization_max_speakers,
                )
            else:
                logger.warning(
                    "Azure Speech diarization is disabled; speaker labels will not "
                    "be included in Azure transcript output."
                )

    def _persist_offline_markdown_to_firestore(self, markdown_path: str) -> None:
        """Best-effort persistence of offline markdown transcript to Firestore."""

        if not markdown_path:
            return

        logger.debug("POST-MEETING: Persisting transcript to Firestore")
        try:
            firestore_meeting_id = self.fs_meeting_id or self.meeting_id
            logger.debug("Firestore meeting ID: %s", firestore_meeting_id)
            from firestore_persistence import persist_transcript_to_firestore

            persist_transcript_to_firestore(
                firestore_client=self.firestore_client,
                meeting_id=firestore_meeting_id,
                markdown_path=markdown_path,
                logger=logger,
            )
            logger.debug(
                "POST-MEETING: Transcript persisted to Firestore successfully"
            )
        except Exception as firestore_err:
            logger.exception(
                "Error storing offline transcript in Firestore: %s",
                firestore_err,
            )
            logger.debug(
                "POST-MEETING: Failed to persist transcript to Firestore (non-fatal)"
            )

    def _run_offline_transcription(
        self, *, local_input: str
    ) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        """Execute whisper.cpp + optional diarization with non-fatal error handling."""

        logger.debug("POST-MEETING: Using offline transcription (whisper.cpp)")
        logger.debug("Transcription input file: %s", local_input)
        logger.debug("Transcription language: %s", self.offline_language)
        logger.debug("Max speakers: %d", self.offline_max_speakers)

        try:
            out_dir = Path(tempfile.gettempdir())

            def _run_offline(diarize: bool):
                from offline_pipeline import transcribe_and_diarize_local_media

                return transcribe_and_diarize_local_media(
                    input_path=Path(local_input),
                    out_dir=out_dir,
                    meeting_id=self.meeting_id,
                    language=self.offline_language,
                    diarize=diarize,
                    max_speakers=self.offline_max_speakers,
                )

            try:
                txt_path, json_path = _run_offline(diarize=True)
            except Exception as diar_err:
                logger.warning("Diarization failed; retrying without it: %s", diar_err)
                txt_path, json_path = _run_offline(diarize=False)

            transcript_md_path = os.path.splitext(str(txt_path))[0] + ".md"
            transcript_txt_path = str(txt_path)
            transcript_json_path = str(json_path)

            logger.info(
                "✅ Offline transcription complete (%s, %s)",
                transcript_txt_path,
                transcript_json_path,
            )
            logger.debug("POST-MEETING: Transcription files generated successfully")

            self._persist_offline_markdown_to_firestore(transcript_md_path)
            return transcript_txt_path, transcript_json_path, transcript_md_path
        except Exception as err:
            logger.exception("Offline transcription failed (non-fatal): %s", err)
            logger.debug("POST-MEETING: Transcription failed (continuing without it)")
            return None, None, None

    def _extract_attendees_from_meeting_data(
        self, meeting_data: Optional[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        attendees_raw = (meeting_data or {}).get("attendees") or []
        if not isinstance(attendees_raw, list):
            return []

        attendees: List[Dict[str, Any]] = []
        for attendee in attendees_raw:
            email = ""
            name = ""
            if isinstance(attendee, str):
                if "@" in attendee:
                    email = attendee.strip().lower()
            elif isinstance(attendee, dict):
                email = (
                    str(
                        attendee.get("email")
                        or attendee.get("address")
                        or attendee.get("mail")
                        or attendee.get("userPrincipalName")
                        or ""
                    )
                    .strip()
                    .lower()
                )
                name = str(
                    attendee.get("name")
                    or attendee.get("displayName")
                    or attendee.get("fullName")
                    or ""
                ).strip()

            if not email and not name:
                continue
            attendees.append({"email": email, "name": name})

        return attendees

    def _load_user_profiles(self, user_ids: List[str]) -> Dict[str, Dict[str, Any]]:
        if not user_ids or not self.team_id:
            return {}
        if self.firestore_client is None:
            return {}

        profiles: Dict[str, Dict[str, Any]] = {}
        users_ref = self.firestore_client.client.collection(
            f"organizations/{self.team_id}/users"
        )

        for user_id in sorted(set(user_ids)):
            if not user_id:
                continue
            try:
                user_snap = users_ref.document(str(user_id)).get()
            except Exception as err:
                logger.warning("Failed to read user profile %s: %s", user_id, err)
                continue
            if not user_snap.exists:
                continue
            user_data = user_snap.to_dict() or {}
            profiles[str(user_id)] = user_data

        return profiles

    def _build_attendee_candidates(
        self,
        *,
        source_meeting_data: Optional[Dict[str, Any]],
        attendee_meetings: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        candidates: List[Dict[str, Any]] = []
        seen_keys: set[str] = set()

        def _add_candidate(
            *,
            user_id: str = "",
            email: str = "",
            name: str = "",
        ) -> None:
            normalized_email = email.strip().lower()
            normalized_name = name.strip()
            normalized_user_id = user_id.strip()
            if not normalized_user_id and not normalized_email and not normalized_name:
                return

            key = (
                normalized_user_id
                or normalized_email
                or normalized_name.lower().replace(" ", "_")
            )
            if key in seen_keys:
                return
            seen_keys.add(key)
            candidates.append(
                {
                    "user_id": normalized_user_id or None,
                    "email": normalized_email or None,
                    "name": normalized_name or None,
                }
            )

        for attendee in self._extract_attendees_from_meeting_data(source_meeting_data):
            _add_candidate(
                email=str(attendee.get("email") or ""),
                name=str(attendee.get("name") or ""),
            )

        attendee_user_ids = [
            str(item.get("user_id") or "").strip() for item in attendee_meetings
        ]
        user_profiles = self._load_user_profiles(attendee_user_ids)

        for attendee in attendee_meetings:
            user_id = str(attendee.get("user_id") or "").strip()
            user_profile = user_profiles.get(user_id, {})
            name = str(
                attendee.get("name")
                or user_profile.get("name")
                or user_profile.get("displayName")
                or ""
            ).strip()
            email = str(
                attendee.get("email")
                or user_profile.get("email")
                or user_profile.get("mail")
                or ""
            ).strip()
            _add_candidate(user_id=user_id, email=email, name=name)

        return candidates

    def _build_transcription_metadata(
        self,
        *,
        transcript_json_path: Optional[str],
        recording_path: str,
        source_meeting_data: Optional[Dict[str, Any]],
        attendee_meetings: List[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        if not transcript_json_path or not os.path.exists(transcript_json_path):
            return None

        from speaker_identity import (
            build_speaker_metadata,
            collect_visual_name_evidence,
            load_transcript_payload,
        )

        try:
            transcript_payload = load_transcript_payload(transcript_json_path)
        except (OSError, ValueError, json.JSONDecodeError) as err:
            logger.warning(
                "Unable to load transcript JSON for speaker metadata: %s",
                err,
            )
            return None

        attendee_candidates = self._build_attendee_candidates(
            source_meeting_data=source_meeting_data,
            attendee_meetings=attendee_meetings,
        )
        if not attendee_candidates:
            logger.info("No attendee candidates found for speaker-name resolution")

        visual_name_evidence: Dict[str, List[str]] = {}
        if (
            self.visual_augmentation_config is not None
            and self.visual_augmentation_config.enabled
        ):
            try:
                visual_name_evidence = collect_visual_name_evidence(
                    recording_path=recording_path,
                    segments=transcript_payload.get("segments") or [],
                    attendee_candidates=attendee_candidates,
                    config=self.visual_augmentation_config,
                    logger=logger,
                )
            except Exception as err:
                logger.warning("Visual speaker evidence failed (non-fatal): %s", err)

        metadata = build_speaker_metadata(
            transcript_payload=transcript_payload,
            attendee_candidates=attendee_candidates,
            visual_name_evidence=visual_name_evidence,
            min_confidence=self.speaker_identity_min_confidence,
        )

        # Keep transcript JSON self-contained for downstream fanout/debugging.
        try:
            transcript_payload["transcription_metadata"] = metadata
            with open(transcript_json_path, "w", encoding="utf-8") as f:
                json.dump(transcript_payload, f, indent=2, ensure_ascii=False)
        except OSError as err:
            logger.warning(
                "Failed to persist transcription metadata into transcript JSON: %s",
                err,
            )

        logger.info(
            "Speaker metadata generated: speakers=%d, unresolved=%d, visual_used=%s",
            metadata.get("speaker_count", 0),
            len(metadata.get("unresolved_speakers", [])),
            bool(metadata.get("visual_evidence_used")),
        )
        return metadata

    def process_meeting(self) -> bool:
        """
        Process the meeting recording job

        Returns:
            True if processing succeeded, False otherwise
        """
        pipeline_started_at = time.monotonic()
        stage_durations: Dict[str, float] = {}

        def _record_stage_duration(stage_name: str, stage_started_at: float) -> None:
            elapsed = time.monotonic() - stage_started_at
            stage_durations[stage_name] = elapsed
            logger.info(
                "PIPELINE_STAGE_DURATION: stage=%s, seconds=%.3f",
                stage_name,
                elapsed,
            )

        try:
            # Only import and initialize heavy dependencies once we know the
            # configuration is valid.
            logger.debug("Initializing clients...")
            self._init_clients()

            logger.info(f"Processing meeting {self.meeting_id}")
            logger.info(f"Meeting URL: {self.meeting_url}")
            logger.info(f"Target GCS path: {self.gcs_path}")

            # Step 0: Wait for meeting-bot API to be ready
            logger.info("Step 0: Waiting for meeting-bot API to become ready...")
            logger.debug("PRE-MEETING CHECK: Verifying meeting-bot API availability")
            if not self.meeting_monitor.wait_for_api_ready():
                logger.error("Meeting-bot API did not become ready in time")
                logger.debug("PRE-MEETING DECISION: Aborting - API not ready")
                return False

            logger.debug("PRE-MEETING DECISION: API ready, proceeding to join meeting")

            # Step 1: Join the meeting
            meeting_stage_started_at = time.monotonic()
            logger.info("Step 1: Joining meeting...")
            logger.debug("PRE-MEETING: Sending join request to meeting-bot API")
            logger.debug("Join parameters:")
            logger.debug("  URL: %s", self.meeting_url)
            logger.debug(
                "  Metadata: %s",
                (
                    json.dumps(self.metadata, indent=2, default=str)
                    if self.metadata
                    else "None"
                ),
            )

            job_id = self.meeting_monitor.join_meeting(
                self.meeting_url,
                self.metadata,
            )
            if not job_id:
                logger.error("Failed to join meeting")
                logger.debug(
                    "PRE-MEETING DECISION: Bot did not join - could indicate meeting not started, incorrect URL, or API issue"
                )
                return False

            logger.info(f"Successfully joined meeting with job ID: {job_id}")
            logger.debug("PRE-MEETING DECISION: Bot successfully joined meeting")

            # Enhanced logging for session claim
            session_id = self.fs_meeting_id or self.meeting_id
            logger.info(
                "SESSION_CLAIMED: session_id=%s, org_id=%s, meeting_url=%s, "
                "bot_job_id=%s",
                session_id[:16] if session_id else "unknown",
                self.team_id or "unknown",
                self.meeting_url[:50] if self.meeting_url else "unknown",
                job_id,
            )

            # Step 2: Monitor the meeting (check every 10 seconds)
            logger.info("Step 2: Monitoring meeting status...")
            logger.debug("DURING MEETING: Starting monitoring loop")
            recording_path = self.meeting_monitor.monitor_until_complete(
                job_id, self.metadata, check_interval=10
            )
            if not recording_path:
                logger.warning(
                    "Meeting monitoring ended without a recording. "
                    "This may indicate the bot was not admitted to the meeting "
                    "(lobby timeout or access denied), the meeting ended before "
                    "recording started, or a recording failure occurred."
                )
                logger.debug(
                    "POST-MEETING DECISION: No recording file - meeting may have ended prematurely or recording failed"
                )
                return False

            logger.info(f"Meeting completed. Recording at: {recording_path}")
            logger.debug("POST-MEETING: Recording file created successfully")
            logger.debug("Recording path: %s", recording_path)
            _record_stage_duration("meeting_join_and_record", meeting_stage_started_at)

            # Enhanced logging for recording complete
            session_id = self.fs_meeting_id or self.meeting_id
            logger.info(
                "RECORDING_COMPLETE: session_id=%s, org_id=%s, " "recording_path=%s",
                session_id[:16] if session_id else "unknown",
                self.team_id or "unknown",
                recording_path,
            )

            # Use PVC-backed scratch space for any heavy processing. This avoids
            # GKE Autopilot ephemeral storage limits.
            scratch_root = _scratch_root()
            scratch_tmp = os.path.join(scratch_root, "tmp")
            os.makedirs(scratch_tmp, exist_ok=True)

            work_dir = os.path.join(scratch_root, "meetings", self.meeting_id)
            os.makedirs(work_dir, exist_ok=True)

            # Copy the WEBM into scratch so ffmpeg outputs (mp4/m4a) land on the
            # PVC rather than node ephemeral storage.
            work_webm = os.path.join(work_dir, "recording.webm")
            if os.path.abspath(recording_path) != os.path.abspath(work_webm):
                try:
                    logger.info("Copying recording into scratch workspace...")
                    import shutil

                    shutil.copy2(recording_path, work_webm)
                    recording_path = work_webm
                except Exception as copy_err:
                    logger.warning(
                        "Failed to copy recording into scratch; will process in-place: %s",
                        copy_err,
                    )

            # Step 2.5: Extract audio-only (preferred for transcription)
            # This reduces upload size and significantly improves chances of a
            # one-shot transcription staying within model input limits.
            audio_path = None
            mp4_path = None
            converter = None
            audio_extract_started_at = time.monotonic()
            try:
                logger.info("Step 2.5: Extracting audio-only for transcription...")
                from media_converter import MediaConverter

                converter = MediaConverter()
                extracted_m4a = converter.extract_audio(recording_path)
                if extracted_m4a and os.path.exists(extracted_m4a):
                    audio_size = os.path.getsize(extracted_m4a)
                    logger.info(
                        "Extracted audio size: %s bytes (%.2f MB)",
                        audio_size,
                        audio_size / (1024 * 1024),
                    )
                    if audio_size >= 1000:
                        audio_path = extracted_m4a
                    else:
                        logger.warning(
                            "Extracted audio file is too small; "
                            "will fall back "
                            "to WEBM for transcription."
                        )
                else:
                    logger.warning(
                        "Audio extraction failed; will fall back to WEBM for "
                        "transcription."
                    )
            except Exception as audio_err:
                logger.warning(
                    "Audio extraction failed; continuing without it: %s",
                    audio_err,
                )
            finally:
                _record_stage_duration("audio_extract", audio_extract_started_at)

            # Step 2.9: Check for ad-hoc meeting and create/update if needed
            # IMPORTANT: This must happen BEFORE uploads so gcs_path can be updated
            # Ad-hoc meetings occur when a user joins via Pub/Sub without
            # a pre-scheduled meeting document in Firestore.
            # Even if the meeting exists (created by frontend), it may be
            # missing the 'start' field which is required for UI display.
            logger.debug("POST-MEETING: Checking for ad-hoc meeting requirements")
            if self.fs_meeting_id and self.team_id:
                logger.debug("Fetching meeting document from Firestore...")
                meeting_data = self.firestore_client.get_meeting(
                    organization_id=self.team_id,
                    meeting_id=self.fs_meeting_id,
                )
                logger.debug(
                    "Meeting data from Firestore: %s",
                    (
                        json.dumps(meeting_data, indent=2, default=str)
                        if meeting_data
                        else "None"
                    ),
                )

                # Get recording duration to calculate meeting start time
                from media_converter import get_recording_duration_seconds

                logger.debug("Calculating recording duration...")
                duration_seconds = get_recording_duration_seconds(recording_path)

                # Fallback to extracted audio when WEBM duration isn't available.
                if not duration_seconds and audio_path and os.path.exists(audio_path):
                    logger.info("Falling back to extracted audio for duration check...")
                    duration_seconds = get_recording_duration_seconds(audio_path)

                # Last-resort fallback for duration-only scenarios where WEBM
                # metadata is incomplete and extracted audio is unavailable.
                if (
                    not duration_seconds
                    and self.generate_mp4_artifact
                    and converter is not None
                ):
                    logger.info("Falling back to MP4 for duration check...")
                    fallback_mp4 = converter.convert_to_mp4(recording_path)
                    if fallback_mp4 and os.path.exists(fallback_mp4):
                        mp4_path = fallback_mp4
                        duration_seconds = get_recording_duration_seconds(fallback_mp4)

                logger.debug("Recording duration: %s seconds", duration_seconds)

                if not meeting_data:
                    # Meeting doesn't exist - create it
                    logger.info("Meeting document not found - creating ad-hoc meeting")
                    logger.debug(
                        "POST-MEETING DECISION: Creating ad-hoc meeting document"
                    )

                    if duration_seconds:
                        from datetime import datetime, timezone, timedelta

                        # Calculate meeting start: current time - duration
                        now = datetime.now(timezone.utc)
                        start_time = now - timedelta(seconds=duration_seconds)
                        start_at = start_time.isoformat().replace("+00:00", "Z")

                        logger.info(
                            f"Creating ad-hoc meeting: duration={duration_seconds}s"
                            f" ({duration_seconds/60:.1f}min), start_at={start_at}"
                        )
                        logger.debug("Ad-hoc meeting details:")
                        logger.debug("  organization_id: %s", self.team_id)
                        logger.debug("  user_id: %s", self.user_id)
                        logger.debug("  meeting_url: %s", self.meeting_url)
                        logger.debug("  start_at: %s", start_at)

                        # Create the ad-hoc meeting document
                        new_meeting_id = self.firestore_client.create_adhoc_meeting(
                            organization_id=self.team_id,
                            user_id=self.user_id,
                            meeting_url=self.meeting_url,
                            start_at=start_at,
                        )

                        if new_meeting_id:
                            # Update fs_meeting_id to use the new meeting
                            old_meeting_id = self.fs_meeting_id
                            self.fs_meeting_id = new_meeting_id

                            # CRITICAL: Update gcs_path to use the new meeting ID
                            # so all subsequent uploads go to the correct location
                            old_gcs_path = self.gcs_path
                            self.gcs_path = (
                                f"recordings/{self.user_id}/{new_meeting_id}"
                            )
                            logger.info(
                                f"✅ Created ad-hoc meeting {new_meeting_id}"
                                f" (was {old_meeting_id})"
                            )
                            logger.info(
                                f"📁 Updated GCS path: {old_gcs_path} -> {self.gcs_path}"
                            )

                            # Immediately update with end time and duration to meet schema requirements
                            # (create_adhoc_meeting only sets start and status=scheduled)
                            self.firestore_client.update_adhoc_meeting_times(
                                organization_id=self.team_id,
                                meeting_id=new_meeting_id,
                                start_time=start_time,
                                end_time=now,
                                duration_seconds=duration_seconds,
                            )
                        else:
                            logger.warning("Failed to create ad-hoc meeting document")
                    else:
                        logger.warning(
                            "Could not determine recording duration "
                            "- skipping ad-hoc meeting creation"
                        )
                elif meeting_data.get("source") == "ad_hoc" and not meeting_data.get(
                    "start"
                ):
                    # Ad-hoc meeting exists but is missing 'start' field
                    # This happens when the frontend creates the meeting
                    logger.info(
                        f"Ad-hoc meeting {self.fs_meeting_id} exists but missing "
                        "'start' field - updating"
                    )

                    if duration_seconds:
                        from datetime import datetime, timezone, timedelta

                        now = datetime.now(timezone.utc)
                        start_time = now - timedelta(seconds=duration_seconds)

                        # Update the meeting with the start time and end time
                        updated = self.firestore_client.update_adhoc_meeting_times(
                            organization_id=self.team_id,
                            meeting_id=self.fs_meeting_id,
                            start_time=start_time,
                            end_time=now,
                            duration_seconds=duration_seconds,
                        )

                        if updated:
                            logger.info(
                                f"✅ Updated ad-hoc meeting {self.fs_meeting_id} "
                                f"with start={start_time.isoformat()}, "
                                f"duration={duration_seconds}s"
                            )
                        else:
                            logger.warning(
                                f"Failed to update ad-hoc meeting {self.fs_meeting_id}"
                            )
                    else:
                        logger.warning(
                            "Could not determine recording duration "
                            "- skipping ad-hoc meeting update"
                        )
                else:
                    logger.debug(
                        f"Meeting {self.fs_meeting_id} already exists with "
                        f"source={meeting_data.get('source')}, "
                        f"start={meeting_data.get('start')}"
                    )

            # Validate recording file exists before proceeding to transcription
            logger.debug("POST-MEETING: Verifying recording file exists")
            if not os.path.exists(recording_path):
                logger.error(f"Recording file not found: {recording_path}")
                logger.debug(
                    "POST-MEETING DECISION: Recording file missing - cannot proceed"
                )
                return False

            webm_size = os.path.getsize(recording_path)
            logger.info(
                "WEBM file size: %s bytes (%.2f MB)",
                webm_size,
                webm_size / (1024 * 1024),
            )
            logger.debug("POST-MEETING: Validating file size")
            if webm_size < 1000:
                logger.error(
                    "❌ WEBM file too small (%s bytes) - file is empty or corrupted",
                    webm_size,
                )
                logger.debug("POST-MEETING DECISION: File too small, likely corrupted")
                return False

            # Step 3: Transcribe (optional, non-fatal)
            # Prefer audio-only if available; fall back to WEBM.
            transcript_txt_path = None
            transcript_json_path = None
            transcript_md_path = None

            logger.debug("POST-MEETING: Starting transcription process")
            logger.debug("Transcription mode: %s", self.transcription_mode)
            transcription_started_at = time.monotonic()
            local_transcription_input = (
                audio_path
                if audio_path and os.path.exists(audio_path)
                else recording_path
            )

            if self.transcription_mode == "none":
                logger.info("Step 3: Transcription skipped (TRANSCRIPTION_MODE=none)")
                logger.debug("POST-MEETING DECISION: Skipping transcription")
            elif self.transcription_mode == "offline":
                logger.info(
                    "Step 3: Transcribing offline with whisper.cpp + " "diarization..."
                )
                (
                    transcript_txt_path,
                    transcript_json_path,
                    transcript_md_path,
                ) = self._run_offline_transcription(local_input=local_transcription_input)
            elif self.transcription_mode == "azure":
                logger.info(
                    "Step 3: Transcribing with Azure Speech (AU fast transcription)..."
                )
                logger.debug("POST-MEETING: Using Azure Speech transcription")
            else:
                logger.info(
                    "Step 3: Transcribing with Gemini (audio-only preferred)..."
                )
                logger.debug("POST-MEETING: Using Gemini transcription")

            if self.transcription_mode == "azure":
                try:
                    if not self.transcription_client:
                        raise RuntimeError(
                            "TRANSCRIPTION_MODE=azure but Azure Speech client "
                            "was not initialized"
                        )

                    azure_locale = (
                        self.azure_speech_config.locale
                        if self.azure_speech_config is not None
                        else "en-AU"
                    )
                    transcript_data = self.transcription_client.transcribe_audio(
                        audio_uri=local_transcription_input,
                        language_code=azure_locale,
                        enable_speaker_diarization=True,
                        enable_timestamps=True,
                        enable_action_items=False,
                    )
                    if not transcript_data:
                        raise RuntimeError(
                            "Azure Speech transcription returned no transcript data"
                        )

                    transcript_txt_path = os.path.join(
                        tempfile.gettempdir(), f"{self.meeting_id}_transcript.txt"
                    )
                    self.transcription_client.save_transcript(
                        transcript_data,
                        transcript_txt_path,
                        format="txt",
                    )

                    transcript_json_path = os.path.join(
                        tempfile.gettempdir(), f"{self.meeting_id}_transcript.json"
                    )
                    self.transcription_client.save_transcript(
                        transcript_data,
                        transcript_json_path,
                        format="json",
                    )

                    logger.info(
                        "✅ Azure Speech transcription complete! Words: %s",
                        transcript_data.get("word_count"),
                    )

                    transcription_text = (transcript_data.get("transcript") or "").strip()
                    if transcription_text:
                        try:
                            firestore_meeting_id = self.fs_meeting_id or self.meeting_id
                            if firestore_meeting_id:
                                firestore_stored = (
                                    self.firestore_client.set_transcription(
                                        firestore_meeting_id, transcription_text
                                    )
                                )
                                if firestore_stored:
                                    logger.info(
                                        "✅ Stored Azure transcript for %s",
                                        firestore_meeting_id,
                                    )
                                else:
                                    logger.warning("Failed to store Azure transcript")
                            else:
                                logger.warning(
                                    "No meeting ID available for Firestore storage "
                                    "(neither FS_MEETING_ID nor MEETING_ID set)"
                                )
                        except Exception as firestore_err:
                            logger.exception(
                                "Error storing Azure transcript in Firestore: %s",
                                firestore_err,
                            )
                    else:
                        logger.warning(
                            "Azure transcription completed with empty text payload"
                        )
                except Exception as azure_err:
                    logger.exception(
                        "Azure transcription failed (non-fatal): %s",
                        azure_err,
                    )
                    if self.azure_speech_fallback_to_offline:
                        logger.warning(
                            "Falling back to offline whisper transcription "
                            "after Azure failure"
                        )
                        (
                            transcript_txt_path,
                            transcript_json_path,
                            transcript_md_path,
                        ) = self._run_offline_transcription(
                            local_input=local_transcription_input
                        )
                    else:
                        logger.warning(
                            "Azure fallback disabled "
                            "(AZURE_SPEECH_FALLBACK_TO_OFFLINE=false); "
                            "continuing without transcript"
                        )

            if self.transcription_mode == "gemini":
                # Gemini requires files in GCS to generate signed URLs
                # Upload a temp copy for transcription, then clean up after
                try:
                    if not self.transcription_client:
                        raise RuntimeError(
                            "TRANSCRIPTION_MODE=gemini but Gemini client "
                            "was not initialized"
                        )

                    # Upload audio (preferred) or recording to a temp location in GCS
                    temp_gcs_prefix = f"temp_transcription/{self.meeting_id}"
                    local_file_for_gemini = (
                        audio_path
                        if audio_path and os.path.exists(audio_path)
                        else recording_path
                    )
                    temp_gcs_path = (
                        f"{temp_gcs_prefix}/audio.m4a"
                        if audio_path
                        else f"{temp_gcs_prefix}/recording.webm"
                    )

                    logger.debug(
                        "Uploading temp file for Gemini transcription: %s",
                        temp_gcs_path,
                    )
                    temp_uploaded = self.storage_client.upload_file(
                        local_file_for_gemini,
                        temp_gcs_path,
                    )

                    if not temp_uploaded:
                        raise RuntimeError(
                            "Failed to upload temp file for Gemini transcription"
                        )

                    logger.info(
                        "Transcription target: gs://%s/%s",
                        self.gcs_bucket,
                        temp_gcs_path,
                    )

                    # Generate signed URL for Gemini to access the file.
                    recording_url = self.storage_client.get_signed_url(
                        temp_gcs_path,
                        expiration_minutes=360,
                    )

                    if recording_url:
                        logger.info(
                            "Generated signed URL for transcription: %s...",
                            recording_url[:50],
                        )
                        logger.info("Transcribing with Gemini...")

                        try:
                            transcript_data = (
                                self.transcription_client.transcribe_audio(
                                    audio_uri=recording_url,
                                    language_code="en-AU",
                                    enable_speaker_diarization=True,
                                    enable_timestamps=False,
                                    enable_action_items=True,
                                )
                            )

                            if transcript_data:
                                transcript_text = transcript_data.get("transcript", "")
                                if _is_sample_transcription(transcript_text):
                                    logger.warning(
                                        "⚠️  Transcription appears to be "
                                        "sample/demo "
                                        "text, not actual meeting content"
                                    )
                                    logger.warning(
                                        "This may indicate the WEBM contains "
                                        "no "
                                        "speech or audio capture failed"
                                    )

                                transcript_txt_path = os.path.join(
                                    tempfile.gettempdir(),
                                    f"{self.meeting_id}_transcript.txt",
                                )
                                self.transcription_client.save_transcript(
                                    transcript_data,
                                    transcript_txt_path,
                                    format="txt",
                                )

                                transcript_json_path = os.path.join(
                                    tempfile.gettempdir(),
                                    f"{self.meeting_id}_transcript.json",
                                )
                                self.transcription_client.save_transcript(
                                    transcript_data,
                                    transcript_json_path,
                                    format="json",
                                )

                                logger.info(
                                    "✅ Transcription complete! Words: %s",
                                    transcript_data.get("word_count"),
                                )

                                # Store transcription text in Firestore
                                try:
                                    transcription_text = transcript_data.get(
                                        "transcript", ""
                                    )
                                    if transcription_text:
                                        firestore_meeting_id = (
                                            self.fs_meeting_id or self.meeting_id
                                        )
                                        if firestore_meeting_id:
                                            firestore_stored = (
                                                self.firestore_client.set_transcription(
                                                    firestore_meeting_id,
                                                    transcription_text,
                                                )
                                            )
                                            if firestore_stored:
                                                logger.info(
                                                    "✅ Stored transcription " "for %s",
                                                    firestore_meeting_id,
                                                )
                                            else:
                                                logger.warning(
                                                    "Failed to store " "transcription"
                                                )
                                        else:
                                            logger.warning(
                                                "No meeting ID available for "
                                                "Firestore storage (neither "
                                                "FS_MEETING_ID nor MEETING_ID "
                                                "set)"
                                            )
                                    else:
                                        logger.warning(
                                            "No transcription text available "
                                            "to store in Firestore"
                                        )
                                except Exception as firestore_err:
                                    logger.exception(
                                        "Error storing transcription in "
                                        "Firestore: %s",
                                        firestore_err,
                                    )
                                    logger.warning(
                                        "Continuing despite Firestore storage "
                                        "failure"
                                    )
                            else:
                                logger.warning(
                                    "Transcription completed but no results " "returned"
                                )
                        finally:
                            # Clean up temp GCS file
                            try:
                                self.storage_client.delete_file(temp_gcs_path)
                                logger.debug(
                                    "Cleaned up temp transcription file: %s",
                                    temp_gcs_path,
                                )
                            except Exception as cleanup_err:
                                logger.debug(
                                    "Could not delete temp transcription file: %s",
                                    cleanup_err,
                                )
                    else:
                        logger.warning(
                            "Failed to generate signed URL for transcription"
                        )

                except Exception as e:
                    logger.exception(f"Transcription failed (non-fatal): {e}")
                    logger.warning(
                        "Continuing with upload despite transcription failure"
                    )

            if self.transcription_mode != "none":
                _record_stage_duration("transcription", transcription_started_at)

            if self.generate_mp4_artifact:
                mp4_convert_started_at = time.monotonic()
                try:
                    logger.info("Step 3.5: Generating MP4 playback artifact...")
                    if converter is None:
                        from media_converter import MediaConverter

                        converter = MediaConverter()
                    converted_mp4 = converter.convert_to_mp4(recording_path)
                    if converted_mp4 and os.path.exists(converted_mp4):
                        mp4_path = converted_mp4
                    else:
                        logger.warning(
                            "MP4 conversion failed; continuing without MP4 artifact"
                        )
                except Exception as mp4_err:
                    logger.warning(
                        "MP4 conversion failed (non-fatal): %s",
                        mp4_err,
                    )
                finally:
                    _record_stage_duration("mp4_convert", mp4_convert_started_at)
            else:
                logger.info(
                    "Step 3.5: MP4 generation skipped "
                    "(GENERATE_MP4_ARTIFACT=false)"
                )

            # Step 4: Upload all files to ALL attendees (fanout from container)
            # Find all meetings with the same URL on the same day = attendees
            fanout_started_at = time.monotonic()
            logger.info("Step 4: Discovering attendees and uploading files to all...")
            logger.debug("=" * 80)
            logger.debug(
                "ATTENDEE FANOUT - Upload files from container to all attendees"
            )
            logger.debug("=" * 80)

            # Prepare list of local files to upload
            local_files_to_upload = []

            # WEBM recording (required)
            if os.path.exists(recording_path):
                local_files_to_upload.append(
                    {
                        "local_path": recording_path,
                        "filename": "recording.webm",
                        "content_type": "video/webm",
                        "required": True,
                    }
                )
                logger.debug(
                    "  📦 WEBM: %s (%.2f MB)", recording_path, webm_size / (1024 * 1024)
                )

            # MP4 fallback (optional)
            if mp4_path and os.path.exists(mp4_path):
                mp4_size = os.path.getsize(mp4_path)
                local_files_to_upload.append(
                    {
                        "local_path": mp4_path,
                        "filename": "recording.mp4",
                        "content_type": "video/mp4",
                        "required": False,
                    }
                )
                logger.debug(
                    "  📦 MP4: %s (%.2f MB)", mp4_path, mp4_size / (1024 * 1024)
                )

            # M4A audio (optional)
            if audio_path and os.path.exists(audio_path):
                audio_size = os.path.getsize(audio_path)
                local_files_to_upload.append(
                    {
                        "local_path": audio_path,
                        "filename": "recording.m4a",
                        "content_type": "audio/mp4",
                        "required": False,
                    }
                )
                logger.debug(
                    "  📦 M4A: %s (%.2f MB)", audio_path, audio_size / (1024 * 1024)
                )

            # Transcripts (optional)
            if transcript_txt_path and os.path.exists(transcript_txt_path):
                local_files_to_upload.append(
                    {
                        "local_path": transcript_txt_path,
                        "filename": "transcript.txt",
                        "content_type": "text/plain",
                        "required": False,
                    }
                )
                logger.debug("  📦 TXT: %s", transcript_txt_path)

            if transcript_json_path and os.path.exists(transcript_json_path):
                local_files_to_upload.append(
                    {
                        "local_path": transcript_json_path,
                        "filename": "transcript.json",
                        "content_type": "application/json",
                        "required": False,
                    }
                )
                logger.debug("  📦 JSON: %s", transcript_json_path)

            if transcript_md_path and os.path.exists(transcript_md_path):
                local_files_to_upload.append(
                    {
                        "local_path": transcript_md_path,
                        "filename": "transcript.md",
                        "content_type": "text/markdown",
                        "required": False,
                    }
                )
                logger.debug("  📦 MD: %s", transcript_md_path)

            # VTT subtitles (optional)
            transcript_vtt_path = None
            if transcript_txt_path:
                transcript_vtt_path = os.path.splitext(transcript_txt_path)[0] + ".vtt"
                if os.path.exists(transcript_vtt_path):
                    local_files_to_upload.append(
                        {
                            "local_path": transcript_vtt_path,
                            "filename": "transcript.vtt",
                            "content_type": "text/vtt",
                            "required": False,
                        }
                    )
                    logger.debug("  📦 VTT: %s", transcript_vtt_path)

            logger.info(
                "Total files to upload per attendee: %d", len(local_files_to_upload)
            )

            # Read transcription text for storing in each attendee's Firestore doc
            transcription_text_for_firestore = None
            if transcript_md_path and os.path.exists(transcript_md_path):
                try:
                    with open(transcript_md_path, "r", encoding="utf-8") as f:
                        transcription_text_for_firestore = f.read()
                    logger.debug(
                        "Read transcription text from MD file (%d chars)",
                        len(transcription_text_for_firestore),
                    )
                except Exception as read_err:
                    logger.warning(
                        "Failed to read transcript MD for Firestore: %s", read_err
                    )
            elif transcript_txt_path and os.path.exists(transcript_txt_path):
                try:
                    with open(transcript_txt_path, "r", encoding="utf-8") as f:
                        transcription_text_for_firestore = f.read()
                    logger.debug(
                        "Read transcription text from TXT file (%d chars)",
                        len(transcription_text_for_firestore),
                    )
                except Exception as read_err:
                    logger.warning(
                        "Failed to read transcript TXT for Firestore: %s", read_err
                    )

            # Discover all attendee meetings (same URL, same time)
            attendee_meetings = []
            source_meeting_data: Dict[str, Any] = {}
            if self.team_id and self.meeting_url:
                # Get the meeting start and end times from Firestore
                meeting_start_time = None
                meeting_end_time = None
                if self.fs_meeting_id:
                    meeting_data = self.firestore_client.get_meeting(
                        organization_id=self.team_id,
                        meeting_id=self.fs_meeting_id,
                    )
                    if meeting_data:
                        source_meeting_data = meeting_data
                        start_val = meeting_data.get("start")
                        end_val = meeting_data.get("end")
                        if hasattr(start_val, "date"):
                            meeting_start_time = start_val
                            if meeting_start_time.tzinfo is None:
                                meeting_start_time = meeting_start_time.replace(
                                    tzinfo=timezone.utc
                                )
                        if hasattr(end_val, "date"):
                            meeting_end_time = end_val
                            if meeting_end_time.tzinfo is None:
                                meeting_end_time = meeting_end_time.replace(
                                    tzinfo=timezone.utc
                                )

                if meeting_start_time and meeting_end_time:
                    logger.debug(
                        "Using meeting times for attendee lookup: start=%s, end=%s",
                        meeting_start_time,
                        meeting_end_time,
                    )

                    attendee_meetings = (
                        self.firestore_client.find_attendee_meetings_by_url_and_time(
                            organization_id=self.team_id,
                            meeting_url=self.meeting_url,
                            start_time=meeting_start_time,
                            end_time=meeting_end_time,
                        )
                    )
                else:
                    logger.warning(
                        "Cannot discover attendees: missing start or end time in meeting data"
                    )
                    logger.debug("  start_time: %s", meeting_start_time)
                    logger.debug("  end_time: %s", meeting_end_time)
            else:
                logger.warning(
                    "Cannot discover attendees: missing team_id or meeting_url"
                )
                logger.debug("  team_id: %s", self.team_id)
                logger.debug(
                    "  meeting_url: %s",
                    self.meeting_url[:50] if self.meeting_url else "N/A",
                )

            # If no attendee meetings found, fall back to just the current meeting
            if not attendee_meetings:
                logger.info(
                    "No attendee meetings found via URL matching, using current meeting only"
                )
                attendee_meetings = [
                    {
                        "id": self.fs_meeting_id or self.meeting_id,
                        "user_id": self.user_id,
                        "email": self.metadata.get("email")
                        if isinstance(self.metadata, dict)
                        else "",
                        "name": self.metadata.get("name")
                        if isinstance(self.metadata, dict)
                        else "",
                        "start": None,
                        "title": "",
                        "join_url": self.meeting_url,
                        "status": "",
                    }
                ]

            transcription_metadata = self._build_transcription_metadata(
                transcript_json_path=transcript_json_path,
                recording_path=recording_path,
                source_meeting_data=source_meeting_data,
                attendee_meetings=attendee_meetings,
            )

            logger.info("=" * 80)
            logger.info(
                "FANOUT: Uploading files to %d attendee(s)", len(attendee_meetings)
            )
            logger.info("=" * 80)

            # Log all attendees for debugging
            for idx, attendee in enumerate(attendee_meetings):
                logger.debug(
                    "  ATTENDEE [%d/%d]: meeting_id=%s, user_id=%s, title=%s",
                    idx + 1,
                    len(attendee_meetings),
                    attendee["id"],
                    attendee["user_id"],
                    attendee.get("title", "N/A")[:30],
                )

            # Track upload results for each attendee
            fanout_results = []
            artifacts_manifest = {}  # Will be set from first successful upload

            for attendee_idx, attendee in enumerate(attendee_meetings):
                attendee_meeting_id = attendee["id"]
                attendee_user_id = attendee["user_id"]

                if not attendee_user_id:
                    logger.warning(
                        "FANOUT_SKIP: meeting_id=%s has no user_id, skipping",
                        attendee_meeting_id,
                    )
                    continue

                # Construct GCS path for this attendee
                attendee_gcs_path = (
                    f"recordings/{attendee_user_id}/{attendee_meeting_id}"
                )

                logger.info("=" * 60)
                logger.info(
                    "FANOUT [%d/%d]: user_id=%s, meeting_id=%s",
                    attendee_idx + 1,
                    len(attendee_meetings),
                    attendee_user_id,
                    attendee_meeting_id,
                )
                logger.info(
                    "  Target GCS path: gs://%s/%s/", self.gcs_bucket, attendee_gcs_path
                )

                attendee_result = {
                    "user_id": attendee_user_id,
                    "meeting_id": attendee_meeting_id,
                    "gcs_path": attendee_gcs_path,
                    "files_uploaded": 0,
                    "files_failed": 0,
                    "success": True,
                }

                # Upload each file to this attendee's GCS path
                for file_info in local_files_to_upload:
                    local_path = file_info["local_path"]
                    filename = file_info["filename"]
                    content_type = file_info["content_type"]
                    required = file_info["required"]

                    gcs_dest_path = f"{attendee_gcs_path}/{filename}"

                    logger.info(
                        "  COPY: %s -> gs://%s/%s",
                        filename,
                        self.gcs_bucket,
                        gcs_dest_path,
                    )

                    try:
                        upload_success = self.storage_client.upload_file(
                            local_path,
                            gcs_dest_path,
                            content_type=content_type,
                        )

                        if upload_success:
                            attendee_result["files_uploaded"] += 1
                            logger.info(
                                "    ✅ SUCCESS: %s uploaded to user %s",
                                filename,
                                attendee_user_id,
                            )

                            # Build artifacts manifest from first attendee
                            if attendee_idx == 0:
                                artifact_key = filename.replace(".", "_").replace(
                                    "recording_", "recording_"
                                )
                                # Normalize artifact keys
                                if filename == "recording.webm":
                                    artifact_key = "recording_webm"
                                elif filename == "recording.mp4":
                                    artifact_key = "recording_mp4"
                                elif filename == "recording.m4a":
                                    artifact_key = "recording_m4a"
                                elif filename == "transcript.txt":
                                    artifact_key = "transcript_txt"
                                elif filename == "transcript.json":
                                    artifact_key = "transcript_json"
                                elif filename == "transcript.md":
                                    artifact_key = "transcript_md"
                                elif filename == "transcript.vtt":
                                    artifact_key = "transcript_vtt"
                                artifacts_manifest[artifact_key] = gcs_dest_path
                        else:
                            attendee_result["files_failed"] += 1
                            logger.error(
                                "    ❌ FAILED: %s upload to user %s failed",
                                filename,
                                attendee_user_id,
                            )
                            if required:
                                attendee_result["success"] = False

                    except Exception as upload_err:
                        attendee_result["files_failed"] += 1
                        logger.error(
                            "    ❌ ERROR: %s upload to user %s: %s",
                            filename,
                            attendee_user_id,
                            upload_err,
                        )
                        if required:
                            attendee_result["success"] = False

                # Build artifacts manifest for THIS attendee (using their GCS paths)
                attendee_artifacts = {}
                for file_info in local_files_to_upload:
                    filename = file_info["filename"]
                    gcs_dest_path = f"{attendee_gcs_path}/{filename}"
                    # Normalize artifact keys
                    if filename == "recording.webm":
                        attendee_artifacts["recording_webm"] = gcs_dest_path
                    elif filename == "recording.mp4":
                        attendee_artifacts["recording_mp4"] = gcs_dest_path
                    elif filename == "recording.m4a":
                        attendee_artifacts["recording_m4a"] = gcs_dest_path
                    elif filename == "transcript.txt":
                        attendee_artifacts["transcript_txt"] = gcs_dest_path
                    elif filename == "transcript.json":
                        attendee_artifacts["transcript_json"] = gcs_dest_path
                    elif filename == "transcript.md":
                        attendee_artifacts["transcript_md"] = gcs_dest_path
                    elif filename == "transcript.vtt":
                        attendee_artifacts["transcript_vtt"] = gcs_dest_path

                # Update this attendee's Firestore meeting document
                if attendee_result["success"] and self.team_id:
                    try:
                        from datetime import datetime as dt, timezone as tz
                        from google.cloud import firestore as fs_lib

                        db = fs_lib.Client(database=self.firestore_database)
                        attendee_meeting_ref = (
                            db.collection("organizations")
                            .document(str(self.team_id))
                            .collection("meetings")
                            .document(str(attendee_meeting_id))
                        )

                        now = dt.now(tz.utc)
                        attendee_payload: dict = {
                            "bot_status": "complete",
                            "bot_completed_at": now,
                            "updated_at": now,
                            "artifacts": attendee_artifacts,
                            "recording_available": True,
                            "recording_status": "complete",
                        }

                        # Set recording_url from webm path if available
                        webm_path = attendee_artifacts.get("recording_webm")
                        if webm_path:
                            attendee_payload["recording_url"] = (
                                f"gs://{self.gcs_bucket}/{webm_path}"
                            )

                        # Add transcription text if available
                        if transcription_text_for_firestore:
                            attendee_payload["transcription"] = (
                                transcription_text_for_firestore
                            )
                            logger.debug(
                                "    Transcription text available (%d chars)",
                                len(transcription_text_for_firestore),
                            )
                        else:
                            logger.warning(
                                "    ⚠️ No transcription text available for meeting %s",
                                attendee_meeting_id,
                            )

                        if transcription_metadata:
                            attendee_payload["transcription_metadata"] = (
                                transcription_metadata
                            )

                        logger.debug(
                            "    Firestore payload: bot_status=%s, artifacts=%s, "
                            "has_transcription=%s, has_transcription_metadata=%s, "
                            "has_recording_url=%s",
                            attendee_payload.get("bot_status"),
                            list(attendee_payload.get("artifacts", {}).keys()),
                            "transcription" in attendee_payload,
                            "transcription_metadata" in attendee_payload,
                            "recording_url" in attendee_payload,
                        )

                        attendee_meeting_ref.set(attendee_payload, merge=True)
                        logger.info(
                            "    📝 FIRESTORE: Updated meeting %s with "
                            "transcription and artifacts",
                            attendee_meeting_id,
                        )
                    except Exception as fs_err:
                        logger.warning(
                            "    ⚠️ FIRESTORE: Failed to update meeting %s: %s",
                            attendee_meeting_id,
                            fs_err,
                        )
                else:
                    # Log why we skipped the Firestore update
                    if not attendee_result["success"]:
                        logger.warning(
                            "    ⚠️ FIRESTORE_SKIP: meeting %s - file upload failed",
                            attendee_meeting_id,
                        )
                    elif not self.team_id:
                        logger.warning(
                            "    ⚠️ FIRESTORE_SKIP: meeting %s - no team_id available",
                            attendee_meeting_id,
                        )

                fanout_results.append(attendee_result)

                logger.info(
                    "  FANOUT RESULT: user_id=%s, uploaded=%d, failed=%d, success=%s",
                    attendee_user_id,
                    attendee_result["files_uploaded"],
                    attendee_result["files_failed"],
                    attendee_result["success"],
                )

            # Summary logging
            logger.info("=" * 80)
            logger.info("FANOUT COMPLETE SUMMARY")
            logger.info("=" * 80)
            total_success = sum(1 for r in fanout_results if r["success"])
            total_failed = len(fanout_results) - total_success
            total_files = sum(r["files_uploaded"] for r in fanout_results)
            logger.info("  Total attendees: %d", len(fanout_results))
            logger.info("  Successful: %d", total_success)
            logger.info("  Failed: %d", total_failed)
            logger.info("  Total files copied: %d", total_files)

            for result in fanout_results:
                logger.debug(
                    "  ATTENDEE RESULT: user=%s, meeting=%s, files=%d/%d, success=%s",
                    result["user_id"],
                    result["meeting_id"],
                    result["files_uploaded"],
                    result["files_uploaded"] + result["files_failed"],
                    result["success"],
                )

            _record_stage_duration("fanout_upload", fanout_started_at)

            # Check if at least one attendee was successful (for the primary meeting)
            primary_success = any(r["success"] for r in fanout_results)
            if not primary_success:
                logger.error("FANOUT FAILED: No attendees received files successfully")
                return False

            logger.info(
                "✅ Fanout complete: %d attendees received files", total_success
            )

            # Cleanup local files (recording + transcripts)
            try:
                # Only delete the recording file when it lives in /scratch.
                # The source recording under /recordings is part of the shared
                # volume and we should not delete it here.
                if os.path.exists(recording_path) and os.path.abspath(
                    recording_path
                ).startswith(os.path.abspath("/scratch") + os.sep):
                    os.remove(recording_path)
                    logger.info(f"Cleaned up scratch file: {recording_path}")
            except Exception as cleanup_err:
                logger.warning(
                    f"Failed to cleanup file {recording_path}: {cleanup_err}"
                )

            if audio_path and os.path.exists(audio_path):
                try:
                    os.remove(audio_path)
                    logger.debug(f"Removed extracted audio: {audio_path}")
                except Exception as cleanup_err:
                    logger.debug(
                        "Failed to cleanup extracted audio %s: %s",
                        audio_path,
                        cleanup_err,
                    )

            if transcript_txt_path and os.path.exists(transcript_txt_path):
                os.remove(transcript_txt_path)
                logger.debug(
                    "Removed local transcript: %s",
                    transcript_txt_path,
                )
            if transcript_json_path and os.path.exists(transcript_json_path):
                os.remove(transcript_json_path)
                logger.debug(
                    "Removed local transcript: %s",
                    transcript_json_path,
                )
            if transcript_md_path and os.path.exists(transcript_md_path):
                os.remove(transcript_md_path)
                logger.debug(f"Removed local transcript: {transcript_md_path}")

            # Remove local VTT (if created).
            if transcript_txt_path:
                transcript_vtt_path = os.path.splitext(transcript_txt_path)[0] + ".vtt"
                if os.path.exists(transcript_vtt_path):
                    os.remove(transcript_vtt_path)
                    logger.debug(f"Removed local transcript: {transcript_vtt_path}")

            # Best-effort: delete the per-meeting scratch workspace.
            if _should_cleanup_scratch() and os.path.isdir("/scratch"):
                _cleanup_meeting_scratch_dir(
                    os.path.join("/scratch", "meetings", self.meeting_id)
                )

            # Session-dedupe support: mark the meeting session complete and
            # publish an artifact manifest so the controller can fan-out copies.
            # NOTE: With attendee-based fanout, files are already copied to all attendees
            # but we still mark the session complete for status tracking.
            logger.debug("=" * 80)
            logger.debug("POST-MEETING: Marking session complete")
            logger.debug("=" * 80)

            # artifacts_manifest was already built during the fanout loop above
            logger.debug("Artifacts manifest:")
            logger.debug(json.dumps(artifacts_manifest, indent=2, default=str))
            logger.debug(
                "FANOUT: Artifacts already copied to %d attendees", len(fanout_results)
            )

            # Update meeting document with bot_status and artifacts (for K8s dedup fanout)
            try:
                self._mark_meeting_complete(
                    ok=True,
                    artifacts=artifacts_manifest,
                    transcription_metadata=transcription_metadata,
                )
            except Exception as meet_err:
                logger.warning("Meeting completion update failed: %s", meet_err)

            # Also update session document (for backwards compatibility)
            try:
                self._mark_session_complete(
                    ok=True,
                    artifacts=artifacts_manifest,
                    transcription_metadata=transcription_metadata,
                )
            except Exception as sess_err:
                logger.debug("Session completion update failed (ignored): %s", sess_err)

            return True

        except Exception as e:
            logger.exception(f"Error processing meeting: {e}")
            # Mark both meeting and session as failed
            try:
                self._mark_meeting_complete(
                    ok=False,
                    artifacts=None,
                    transcription_metadata=None,
                )
            except Exception:
                pass
            try:
                self._mark_session_complete(
                    ok=False,
                    artifacts=None,
                    transcription_metadata=None,
                )
            except Exception:
                pass
            return False
        finally:
            total_elapsed = time.monotonic() - pipeline_started_at
            logger.info(
                "PIPELINE_TIMING_SUMMARY: meeting_id=%s, mode=%s, "
                "total_seconds=%.3f, stage_seconds=%s",
                self.meeting_id,
                self.transcription_mode,
                total_elapsed,
                json.dumps(stage_durations, sort_keys=True),
            )

    def _mark_session_complete(
        self,
        *,
        ok: bool,
        artifacts: Optional[dict],
        transcription_metadata: Optional[Dict[str, Any]],
    ) -> None:
        """Best-effort: update per-org session state when running in session mode.

        Session mode is detected by the presence of MEETING_SESSION_ID env var.
        """

        # Session mode is identified by meeting_session_id, not GCS path
        if not self.meeting_session_id:
            return

        session_id = self.meeting_session_id
        org_id = self.team_id or ""
        if not org_id:
            logger.warning(
                "SESSION_COMPLETE_SKIPPED: session_id=%s, reason=missing_org_id",
                session_id[:16] if session_id else "unknown",
            )
            return

        # Use a lightweight Firestore client directly for session updates
        from google.cloud import firestore

        db = firestore.Client(database=self.firestore_database)
        ref = (
            db.collection("organizations")
            .document(str(org_id))
            .collection("meeting_sessions")
            .document(str(session_id))
        )

        now = datetime.now(timezone.utc)
        new_status = "complete" if ok else "failed"
        payload: dict = {
            "status": new_status,
            "processed_at": now,
            "updated_at": now,
        }

        if artifacts is not None:
            payload["artifacts"] = {k: v for k, v in artifacts.items() if v}
        if transcription_metadata:
            payload["transcription_metadata"] = transcription_metadata

        # Enhanced logging for session status change
        logger.info(
            "SESSION_STATUS_CHANGE: session_id=%s, org_id=%s, "
            "to_status=%s, trigger=recording_%s, artifact_count=%d",
            session_id[:16] if session_id else "unknown",
            org_id,
            new_status,
            "complete" if ok else "failed",
            len(payload.get("artifacts", {})),
        )

        ref.set(payload, merge=True)

    def _mark_meeting_complete(
        self,
        *,
        ok: bool,
        artifacts: Optional[dict],
        transcription_metadata: Optional[Dict[str, Any]],
    ) -> None:
        """Update the meeting document with bot_status and artifacts for fanout.

        This is required for the K8s-based deduplication approach where the
        controller queries meetings by bot_status='complete' to trigger fanout.
        """
        # Need org_id and fs_meeting_id to locate the meeting document
        org_id = self.team_id or ""
        meeting_id = self.fs_meeting_id or ""

        if not org_id or not meeting_id:
            logger.debug(
                "MEETING_COMPLETE_SKIPPED: reason=missing_org_or_meeting_id, "
                "org_id=%s, meeting_id=%s",
                org_id or "missing",
                meeting_id or "missing",
            )
            return

        from google.cloud import firestore

        db = firestore.Client(database=self.firestore_database)
        meeting_ref = (
            db.collection("organizations")
            .document(str(org_id))
            .collection("meetings")
            .document(str(meeting_id))
        )

        now = datetime.now(timezone.utc)
        new_status = "complete" if ok else "failed"

        payload: dict = {
            "bot_status": new_status,
            "bot_completed_at": now,
            "updated_at": now,
            "recording_available": ok,
            "recording_status": "complete" if ok else "failed",
        }

        # Add artifacts and recording_url for fanout
        if artifacts is not None:
            clean_artifacts = {k: v for k, v in artifacts.items() if v}
            payload["artifacts"] = clean_artifacts

            # Set recording_url from webm path if available
            webm_path = clean_artifacts.get("recording_webm")
            if webm_path:
                payload["recording_url"] = f"gs://{self.gcs_bucket}/{webm_path}"

        if transcription_metadata:
            payload["transcription_metadata"] = transcription_metadata

        logger.info(
            "MEETING_STATUS_CHANGE: meeting_id=%s, org_id=%s, "
            "bot_status=%s, artifact_count=%d",
            meeting_id,
            org_id,
            new_status,
            len(payload.get("artifacts", {})),
        )

        try:
            meeting_ref.set(payload, merge=True)
            logger.debug("Meeting document updated with bot_status=%s", new_status)
        except Exception as e:
            logger.warning("Failed to update meeting document: %s", e)

    def run(self):
        """Main run - process the meeting job"""
        logger.info("=" * 50)
        logger.info("Meeting Bot Manager starting...")
        logger.info("=" * 50)
        logger.debug("ENVIRONMENT VARIABLES:")
        logger.debug("  MEETING_ID: %s", self.meeting_id)
        logger.debug("  FS_MEETING_ID: %s", self.fs_meeting_id)
        logger.debug("  MEETING_SESSION_ID: %s", self.meeting_session_id)
        logger.debug("  MEETING_URL: %s", self.meeting_url)
        logger.debug("  USER_ID: %s", self.user_id)
        logger.debug("  TEAM_ID: %s", self.team_id)
        logger.debug("  GCS_BUCKET: %s", self.gcs_bucket)
        logger.debug("  GCS_PATH: %s", self.gcs_path)
        logger.debug("  MEETING_BOT_API_URL: %s", self.meeting_bot_api)
        logger.debug("  TRANSCRIPTION_MODE: %s", self.transcription_mode)
        logger.debug(
            "  AZURE_SPEECH_FALLBACK_TO_OFFLINE: %s",
            self.azure_speech_fallback_to_offline,
        )
        logger.debug(
            "  WHISPER_CPP_USE_GPU: %s",
            os.environ.get("WHISPER_CPP_USE_GPU", "false"),
        )
        logger.debug("  FIRESTORE_DATABASE: %s", self.firestore_database)

        # Log session mode detection
        if self.meeting_session_id:
            logger.info(
                "SESSION_MODE_DETECTED: session_id=%s, org_id=%s - "
                "Will update session status on completion for fanout",
                self.meeting_session_id[:16] if self.meeting_session_id else "unknown",
                self.team_id or "unknown",
            )

        logger.info(f"Meeting ID: {self.meeting_id}")
        if self.fs_meeting_id:
            logger.info(f"Firestore Meeting ID: {self.fs_meeting_id}")
        logger.info(f"Meeting URL: {self.meeting_url}")
        logger.info(f"GCS Bucket: {self.gcs_bucket}")
        logger.info(f"GCS Path: {self.gcs_path}")
        logger.info(f"Meeting Bot API: {self.meeting_bot_api}")

        if self.metadata:
            logger.debug(
                "Meeting metadata: %s", json.dumps(self.metadata, indent=2, default=str)
            )

        logger.info("=" * 50)

        exit_code = 0

        try:
            # Process the meeting
            success = self.process_meeting()

            if success:
                logger.info("=" * 50)
                logger.info("Processing completed successfully")
                logger.info("=" * 50)
                exit_code = 0
            else:
                logger.info("=" * 50)
                logger.error("Processing failed")
                logger.info("=" * 50)
                exit_code = 1

        finally:
            # ALWAYS trigger shutdown of meeting-bot, regardless of success or
            # failure
            logger.info("Triggering meeting-bot shutdown...")
            shutdown_success = self.meeting_monitor.shutdown()
            if shutdown_success:
                logger.info("Meeting-bot shutdown triggered successfully")
            else:
                logger.warning("Failed to trigger meeting-bot shutdown")

        return exit_code


def _is_sample_transcription(transcript_text: str) -> bool:
    """
    Check if transcription text appears to be sample/demo content

    Args:
        transcript_text: The transcription text to check

    Returns:
        True if it looks like sample text, False otherwise
    """
    if not transcript_text:
        return False

    # Common indicators of sample/demo text from the provided example
    sample_indicators = [
        "[Name Redacted]",
        "[Company Name Redacted]",
        "revolutionize how we interact with our customers",
        "360-degree view of each customer",
        "CRM system that integrates all our customer touchpoints",
        "phased rollout, starting with a pilot program in Q3",
        "sales and customer support departments",
        "customer satisfaction scores, response times, resolution rates",
        "I'm the director of operations",
        "new project that we're going to be launching",
        "Speaker 1 (*Male*):",
        "Speaker 2 (*Female*):",
    ]

    # Check if multiple sample indicators are present
    found_indicators = sum(
        1
        for indicator in sample_indicators
        if indicator.lower() in transcript_text.lower()
    )

    # Also check for generic business meeting patterns that suggest sample
    # content
    generic_patterns = [
        "thank you [name redacted]",
        "really excited about this new project",
        "director of operations",
        "customer touchpoints",
        "pilot program in q3",
    ]

    found_patterns = sum(
        1 for pattern in generic_patterns if pattern.lower() in transcript_text.lower()
    )

    # If we find 3+ indicators OR 2+ patterns, likely sample text
    return found_indicators >= 3 or found_patterns >= 2


def main():
    """Entry point"""
    manager = None
    exit_code = 1

    try:
        manager = MeetingManager()
        exit_code = manager.run()
    except Exception as e:
        logger.exception(f"Fatal error during initialization: {e}")
        capture_error_safe(e, component="manager", feature="main", action="fatal_error")
        exit_code = 1

        # Try to shutdown even if initialization failed partway through
        if manager and hasattr(manager, "meeting_monitor"):
            try:
                logger.info("Attempting meeting-bot shutdown after fatal error...")
                manager.meeting_monitor.shutdown()
            except Exception as shutdown_error:
                logger.error(
                    "Error during shutdown after fatal error: %s",
                    shutdown_error,
                )

    flush_sentry()
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
