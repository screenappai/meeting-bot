#!/usr/bin/env python3
"""controller.main  # noqa: E501

Meeting Bot Controller - Kubernetes Job Orchestrator

This controller polls Firestore for queued meeting/bot-instance work and
spawns Kubernetes Jobs to process each meeting via the manager.

Why Firestore polling?
- Removes Pub/Sub + Firebase Functions infrastructure.
- Uses existing Firestore state as the source of truth.

Workflow:
1. Query Firestore for queued bot instances
2. Atomically claim a bot instance (best-effort distributed lock)
3. Build a job payload compatible with the existing manager env contract
4. Create a Kubernetes Job for the claimed item
5. Repeat
"""

# NOTE: This module is operational and contains long env var / YAML-ish lines.
# flake8: noqa: E501

import os
import sys
import time
import socket
import logging
import hashlib
import uuid
from urllib.parse import urlsplit, urlunsplit
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, List, Optional, Tuple, Set
import re

from google.cloud import firestore, pubsub_v1
from google.cloud import storage
from kubernetes import client, config
from kubernetes.client.rest import ApiException
import json

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
            static_fields={"component": "controller"},
        )
    )

logging.basicConfig(level=_log_level, handlers=[_handler])

logger = logging.getLogger(__name__)

# Initialise Sentry early (before any other work)
from sentry_integration import initialise_sentry, capture_error_safe, flush_sentry

initialise_sentry(component="controller")

# Reduce noise from some verbose libraries (unless DEBUG is explicitly set)
if _log_level > logging.DEBUG:
    logging.getLogger("google.auth").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("google.cloud").setLevel(logging.INFO)
    logging.getLogger("kubernetes").setLevel(logging.INFO)
    logging.getLogger("google.cloud.pubsub_v1").setLevel(logging.WARNING)


class HealthCheckServer:
    """Simple HTTP server for health checks"""

    def __init__(self, port: int = None):
        if port is None:
            port = int(os.getenv("HEALTH_PORT", "8080"))
        from http.server import HTTPServer, BaseHTTPRequestHandler

        class HealthHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/health":
                    self.send_response(200)
                    self.send_header("Content-type", "text/plain")
                    self.end_headers()
                    self.wfile.write(b"OK")
                elif self.path == "/ready":
                    self.send_response(200)
                    self.send_header("Content-type", "text/plain")
                    self.end_headers()
                    self.wfile.write(b"READY")
                else:
                    self.send_response(404)
                    self.end_headers()

            def log_message(self, format, *args):
                pass  # Suppress default logging

        self.server = HTTPServer(("0.0.0.0", port), HealthHandler)

    def start(self):
        import threading

        port = self.server.server_address[1]
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        logger.info("Health check server started on port %d", port)


class MeetingController:
    """Controller that creates Kubernetes Jobs for meeting processing"""

    def __init__(self):
        # Required environment variables
        self.project_id = os.getenv("GCP_PROJECT_ID")
        self.gcs_bucket = os.getenv("GCS_BUCKET")
        self.manager_image = os.getenv("MANAGER_IMAGE")
        self.meeting_bot_image = os.getenv("MEETING_BOT_IMAGE")

        # Firestore configuration
        # NOTE: We keep the GCP project id as the canonical project identifier.
        self.firestore_database = os.getenv("FIRESTORE_DATABASE", "(default)")
        # When claim TTL expires, another controller instance may re-claim.
        self.claim_ttl_seconds = int(os.getenv("CLAIM_TTL_SECONDS", "600"))
        self.max_claim_per_poll = int(os.getenv("MAX_CLAIM_PER_POLL", "10"))

        # Firestore query behavior
        # Query for bot instances in queued state.
        self.bot_instance_status_field = os.getenv(
            "BOT_INSTANCE_STATUS_FIELD", "status"
        )
        self.bot_instance_queued_value = os.getenv(
            "BOT_INSTANCE_QUEUED_VALUE", "queued"
        )

        # Leader election configuration
        self.instance_id = socket.gethostname()
        self.leader_collection_path = "system"
        self.leader_doc_id = "controller_leader"
        self.leader_lease_seconds = 30
        self.is_leader = False
        # Skip leader election for local development
        self.skip_leader_election = os.getenv("SKIP_LEADER_ELECTION", "").lower() in (
            "true",
            "1",
            "yes",
        )

        # Meeting discovery / creation behavior
        # The controller is the source of truth for creating bot_instances.
        # It discovers meetings that need a bot and creates a bot_instances doc
        # in queued state.
        self.meetings_collection_path = os.getenv(
            "MEETINGS_COLLECTION_PATH",
            # Default to a flat collection for simplicity.
            # If your schema is per-org, set MEETINGS_COLLECTION_PATH to
            # organizations/<org_id>/meetings and also set MEETINGS_QUERY_MODE.
            "meetings",
        )
        self.meetings_query_mode = (
            os.getenv(
                "MEETINGS_QUERY_MODE",
                # 'collection' -> use MEETINGS_COLLECTION_PATH as a collection
                # 'collection_group' -> treat MEETINGS_COLLECTION_PATH as a collection id
                #                     and query across all parents.
                "collection",
            )
            .strip()
            .lower()
        )
        self.meeting_status_field = os.getenv("MEETING_STATUS_FIELD", "status")
        self.meeting_status_values = [
            s.strip()
            for s in os.getenv("MEETING_STATUS_VALUES", "scheduled").split(",")
            if s.strip()
        ]

        # Only create a bot instance when meeting doesn't already have one.
        self.meeting_bot_instance_field = os.getenv(
            "MEETING_BOT_INSTANCE_FIELD", "bot_instance_id"
        )

        # Kubernetes configuration
        self.k8s_namespace = os.getenv("KUBERNETES_NAMESPACE", "default")
        self.job_service_account = os.getenv("JOB_SERVICE_ACCOUNT", "meeting-bot-job")
        self.job_gcp_adc_secret_name = os.getenv("JOB_GCP_ADC_SECRET_NAME", "").strip()
        self.job_google_application_credentials = (
            os.getenv(
                "JOB_GOOGLE_APPLICATION_CREDENTIALS",
                "/var/run/secrets/google/adc.json",
            ).strip()
            or "/var/run/secrets/google/adc.json"
        )
        self.job_google_application_credentials_dir = (
            os.path.dirname(self.job_google_application_credentials).strip()
            or "/var/run/secrets/google"
        )
        self.job_use_azure_workload_identity = (
            os.getenv("JOB_USE_AZURE_WORKLOAD_IDENTITY", "").lower()
            in ("true", "1", "yes")
        ) or bool(self.job_gcp_adc_secret_name)

        # Session validation / orphan remediation behavior
        self.orphaned_session_validation_limit = int(
            os.getenv("ORPHANED_SESSION_VALIDATION_LIMIT", "50")
        )
        self.orphaned_session_remediation_enabled = os.getenv(
            "ORPHANED_SESSION_REMEDIATION_ENABLED", "true"
        ).lower() in ("true", "1", "yes")
        default_orphaned_age_minutes = max(1, (self.claim_ttl_seconds + 59) // 60)
        self.orphaned_session_remediation_min_age_minutes = int(
            os.getenv(
                "ORPHANED_SESSION_REMEDIATION_MIN_AGE_MINUTES",
                str(default_orphaned_age_minutes),
            )
        )
        self.orphaned_session_remediation_action = (
            os.getenv("ORPHANED_SESSION_REMEDIATION_ACTION", "requeue").strip().lower()
        )
        self.orphaned_session_remediation_max_per_cycle = int(
            os.getenv(
                "ORPHANED_SESSION_REMEDIATION_MAX_PER_CYCLE",
                str(self.max_claim_per_poll),
            )
        )

        # Job container resources (defaults preserve existing production values)
        self.meeting_bot_resource_requests: Dict[str, str] = {
            "cpu": os.getenv("MEETING_BOT_CPU_REQUEST", "3000m"),
            "memory": os.getenv("MEETING_BOT_MEMORY_REQUEST", "2Gi"),
            "ephemeral-storage": os.getenv(
                "MEETING_BOT_EPHEMERAL_STORAGE_REQUEST", "8Gi"
            ),
        }
        self.meeting_bot_resource_limits: Dict[str, str] = {
            "cpu": os.getenv("MEETING_BOT_CPU_LIMIT", "4000m"),
            "memory": os.getenv("MEETING_BOT_MEMORY_LIMIT", "3Gi"),
            "ephemeral-storage": os.getenv(
                "MEETING_BOT_EPHEMERAL_STORAGE_LIMIT", "8Gi"
            ),
        }
        self.manager_resource_requests: Dict[str, str] = {
            "cpu": os.getenv("MANAGER_CPU_REQUEST", "2500m"),
            "memory": os.getenv("MANAGER_MEMORY_REQUEST", "4Gi"),
            "ephemeral-storage": os.getenv("MANAGER_EPHEMERAL_STORAGE_REQUEST", "2Gi"),
        }
        self.manager_resource_limits: Dict[str, str] = {
            "cpu": os.getenv("MANAGER_CPU_LIMIT", "3750m"),
            "memory": os.getenv("MANAGER_MEMORY_LIMIT", "8Gi"),
            "ephemeral-storage": os.getenv("MANAGER_EPHEMERAL_STORAGE_LIMIT", "2Gi"),
        }
        self.enable_meeting_bot_gpu_scheduling = os.getenv(
            "ENABLE_MEETING_BOT_GPU_SCHEDULING", "false"
        ).lower() in ("true", "1", "yes")
        self.meeting_bot_gpu_node_selector_key = os.getenv(
            "MEETING_BOT_GPU_NODE_SELECTOR_KEY", "workload"
        )
        self.meeting_bot_gpu_node_selector_value = os.getenv(
            "MEETING_BOT_GPU_NODE_SELECTOR_VALUE", "meeting-bot-gpu"
        )
        self.meeting_bot_gpu_taint_key = os.getenv(
            "MEETING_BOT_GPU_TAINT_KEY", "workload"
        )
        self.meeting_bot_gpu_taint_value = os.getenv(
            "MEETING_BOT_GPU_TAINT_VALUE", "meeting-bot-gpu"
        )
        self.meeting_bot_gpu_taint_effect = os.getenv(
            "MEETING_BOT_GPU_TAINT_EFFECT", "NoSchedule"
        )
        self.meeting_bot_gpu_resource_request = os.getenv(
            "MEETING_BOT_GPU_RESOURCE_REQUEST", "1"
        )

        # Dry-run mode - logs K8s operations but doesn't execute them
        self.dry_run = os.getenv("DRY_RUN", "").lower() in ("true", "1", "yes")

        # Optional configuration
        self.node_env = os.getenv("NODE_ENV", "development")
        self.sentry_dsn = os.getenv("SENTRY_DSN", "")
        self.max_recording_duration = int(
            os.getenv("MAX_RECORDING_DURATION_MINUTES", "600")
        )
        self.meeting_inactivity = int(os.getenv("MEETING_INACTIVITY_MINUTES", "15"))
        self.inactivity_detection_delay = int(
            os.getenv("INACTIVITY_DETECTION_START_DELAY_MINUTES", "5")
        )

        # How often the controller checks Firestore for new meetings/bot work.
        # Kept configurable; default matches prior behavior.
        self.poll_interval = int(os.getenv("POLL_INTERVAL", "10"))
        self.past_meeting_grace_minutes = int(
            os.getenv("PAST_MEETING_GRACE_MINUTES", "30")
        )

        # Pub/Sub configuration
        self.pubsub_subscription = os.getenv("PUBSUB_SUBSCRIPTION")
        self.subscriber = None
        self.streaming_pull_future = None

        # Validate required environment variables
        self._validate_config()

        # Initialize Firestore client
        self.db = firestore.Client(
            project=self.project_id, database=self.firestore_database
        )

        # Initialize GCS client (used for post-processing fan-out copies).
        # Skip in DRY_RUN mode to avoid authentication issues in local development
        if self.dry_run:
            logger.info("DRY_RUN mode - skipping GCS client initialization")
            self.gcs_client = None
            self.gcs_bucket_client = None
        else:
            self.gcs_client = storage.Client(project=self.project_id)
            self.gcs_bucket_client = self.gcs_client.bucket(self.gcs_bucket)

        # Initialize Kubernetes client (skip in dry-run mode if unavailable)
        self.batch_v1 = None
        self.core_v1 = None
        if self.dry_run:
            logger.info("DRY_RUN mode enabled - K8s operations will be simulated")
            try:
                config.load_incluster_config()
            except config.ConfigException:
                try:
                    config.load_kube_config()
                except Exception:
                    logger.warning(
                        "DRY_RUN: No K8s config available, skipping K8s init"
                    )
            # Initialize APIs if config loaded, but they won't be used
            try:
                self.batch_v1 = client.BatchV1Api()
                self.core_v1 = client.CoreV1Api()
            except Exception:
                pass
        else:
            try:
                # Try to load in-cluster config first
                config.load_incluster_config()
                logger.info("Loaded in-cluster Kubernetes configuration")
            except config.ConfigException:
                # Fall back to kubeconfig for local development
                config.load_kube_config()
                logger.info("Loaded kubeconfig configuration")

            self.batch_v1 = client.BatchV1Api()
            self.core_v1 = client.CoreV1Api()

        logger.info("Controller initialized:")
        logger.info(f"  Project: {self.project_id}")
        logger.info(f"  Firestore DB: {self.firestore_database}")
        logger.info(f"  Namespace: {self.k8s_namespace}")
        logger.info(f"  Manager Image: {self.manager_image}")
        logger.info(f"  Meeting Bot Image: {self.meeting_bot_image}")
        logger.info(
            "  Job ADC Secret: %s",
            self.job_gcp_adc_secret_name or "disabled",
        )
        logger.info(
            "  Job Workload Identity Label: %s",
            self.job_use_azure_workload_identity,
        )
        logger.info(
            "  Meeting Bot Resources: requests=%s limits=%s",
            self.meeting_bot_resource_requests,
            self.meeting_bot_resource_limits,
        )
        logger.info(
            "  Manager Resources: requests=%s limits=%s",
            self.manager_resource_requests,
            self.manager_resource_limits,
        )
        logger.info(
            "  GPU Scheduling: enabled=%s selector=%s=%s taint=%s=%s:%s request_gpu=%s",
            self.enable_meeting_bot_gpu_scheduling,
            self.meeting_bot_gpu_node_selector_key,
            self.meeting_bot_gpu_node_selector_value,
            self.meeting_bot_gpu_taint_key,
            self.meeting_bot_gpu_taint_value,
            self.meeting_bot_gpu_taint_effect,
            self.meeting_bot_gpu_resource_request,
        )
        logger.info(
            "  Orphan Session Remediation: enabled=%s action=%s min_age_minutes=%d "
            "validation_limit=%d max_per_cycle=%d",
            self.orphaned_session_remediation_enabled,
            self.orphaned_session_remediation_action,
            self.orphaned_session_remediation_min_age_minutes,
            self.orphaned_session_validation_limit,
            self.orphaned_session_remediation_max_per_cycle,
        )
        logger.info(f"  Dry Run: {self.dry_run}")
        logger.info(
            "  Meeting discovery: mode=%s path=%s",
            self.meetings_query_mode,
            self.meetings_collection_path,
        )
        logger.info(
            "  Past meeting guard: grace_minutes=%d",
            self.past_meeting_grace_minutes,
        )

    def _log_meeting_context(
        self,
        event: str,
        *,
        session_id: str = "",
        org_id: str = "",
        meeting_url: str = "",
        user_id: str = "",
        status: str = "",
        extra: Dict[str, Any] = None,
    ) -> None:
        """
        Log structured context optimized for LLM analysis.

        These logs are designed to be copy-pasted into LLM prompts
        for debugging session/job issues.
        """
        context = {
            "event": event,
            "session_id": session_id[:16] if session_id else "",
            "org_id": org_id,
            "meeting_url": meeting_url[:60] if meeting_url else "",
            "user_id": user_id,
            "status": status,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        if extra:
            context.update(extra)

        # Single-line structured log for easy grep/parsing
        log_parts = [f"{k}={v}" for k, v in context.items() if v]
        logger.info("MEETING_CONTEXT: %s", ", ".join(log_parts))

    def _validate_config(self):
        """Validate required environment variables"""
        required_vars = {
            "GCP_PROJECT_ID": self.project_id,
            "MANAGER_IMAGE": self.manager_image,
            "MEETING_BOT_IMAGE": self.meeting_bot_image,
            "GCS_BUCKET": self.gcs_bucket,
        }

        missing = [k for k, v in required_vars.items() if not v]
        if missing:
            raise ValueError(
                f"Missing required environment variables: {', '.join(missing)}"
            )

        if self.orphaned_session_validation_limit <= 0:
            raise ValueError("ORPHANED_SESSION_VALIDATION_LIMIT must be greater than 0")

        if self.orphaned_session_remediation_min_age_minutes < 0:
            raise ValueError(
                "ORPHANED_SESSION_REMEDIATION_MIN_AGE_MINUTES must be >= 0"
            )

        if self.orphaned_session_remediation_max_per_cycle < 0:
            raise ValueError("ORPHANED_SESSION_REMEDIATION_MAX_PER_CYCLE must be >= 0")

        allowed_orphan_actions = {"requeue", "failed"}
        if self.orphaned_session_remediation_action not in allowed_orphan_actions:
            raise ValueError(
                "ORPHANED_SESSION_REMEDIATION_ACTION must be one of: "
                f"{', '.join(sorted(allowed_orphan_actions))}"
            )

        if self.past_meeting_grace_minutes < 0:
            raise ValueError("PAST_MEETING_GRACE_MINUTES must be >= 0")

    def create_manager_job(self, message_data: Dict[str, Any], message_id: str) -> bool:
        """
        Create a Kubernetes Job to process the meeting

        Args:
            message_data: Message data containing meeting details
            message_id: Pub/Sub message ID for unique job naming

        Returns:
            True if job created successfully, False otherwise
        """
        # Extract key identifiers early for logging
        meeting_url = message_data.get("meeting_url", "")
        org_id = (
            message_data.get("team_id")
            or message_data.get("teamId")
            or message_data.get("org_id")
            or ""
        )
        session_id = (
            message_data.get("session_id", "")[:16]
            if message_data.get("session_id")
            else ""
        )

        # Extract occurrence_start_utc for recurring meetings (FR-003)
        occurrence_start_utc = message_data.get("occurrence_start_utc") or ""

        # Generate consistent meeting_id based on org_id + meeting_url
        # This ensures job names are consistent for deduplication
        if meeting_url and org_id:
            meeting_id = self._meeting_session_id(
                org_id=org_id,
                meeting_url=meeting_url,
                occurrence_start_utc=occurrence_start_utc,
            )
        else:
            # Fallback for legacy payloads or incomplete data
            meeting_id = message_data.get("meeting_id", message_id)

        try:

            # Storage layout is always:
            #   recordings/<user_firebase_document_id>/<meeting_firebase_document_id>/<files>
            # The manager container will append fixed filenames.
            meeting_doc_id = (
                message_data.get("fs_meeting_id")
                or message_data.get("FS_MEETING_ID")
                or message_data.get("meeting_firebase_document_id")
                or message_data.get("meeting_doc_id")
                or meeting_id
            )

            user_doc_id = (
                message_data.get("user_id")
                or message_data.get("USER_ID")
                or message_data.get("fs_user_id")
                or message_data.get("FS_USER_ID")
                or message_data.get("creator_user_id")
                or message_data.get("user_firebase_document_id")
                or message_data.get("user_doc_id")
                or ""
            )

            if isinstance(user_doc_id, str):
                user_doc_id = user_doc_id.strip()

            if not user_doc_id:
                # LLM-FRIENDLY: Structured context for missing user_id diagnosis
                logger.error(
                    "BOT_JOB_BLOCKED: reason=missing_user_id, "
                    "session_id=%s, org_id=%s, meeting_url=%s, "
                    "available_keys=%s",
                    session_id,
                    org_id,
                    meeting_url[:50] if meeting_url else "none",
                    list(message_data.keys()),
                )
                logger.error(
                    "LLM_CONTEXT: Job creation blocked. The message_data payload "
                    "is missing a user identifier. Expected fields: user_id, USER_ID, "
                    "fs_user_id, FS_USER_ID, creator_user_id, user_firebase_document_id, "
                    "or user_doc_id. Received keys: %s. Full payload sample: %s",
                    list(message_data.keys()),
                    {k: str(v)[:100] for k, v in list(message_data.items())[:10]},
                )
                return False

            # All recordings go to recordings/{user_id}/{meeting_id}
            gcs_path = f"recordings/{user_doc_id}/{meeting_doc_id}"

            if not meeting_url:
                # LLM-FRIENDLY: Structured context for missing meeting_url
                logger.error(
                    "BOT_JOB_BLOCKED: reason=missing_meeting_url, "
                    "session_id=%s, org_id=%s, user_id=%s",
                    session_id,
                    org_id,
                    user_doc_id,
                )
                logger.error(
                    "LLM_CONTEXT: Job creation blocked. No meeting_url in payload. "
                    "This typically means the meeting document is malformed. "
                    "Payload keys: %s",
                    list(message_data.keys()),
                )
                return False

            # Generate unique job name with GUID to avoid conflicts
            # Simple and clean naming that's guaranteed to be unique
            job_guid = str(uuid.uuid4())
            job_name = f"meeting-bot-{job_guid}"

            # Compute hashes for K8s labels (used for deduplication)
            url_hash = self._meeting_url_hash(meeting_url)
            org_hash = self._org_id_hash(org_id)

            logger.info(
                "JOB_NAME_GENERATED: org_id='%s', job_guid=%s, job_name=%s",
                org_id,
                job_guid,
                job_name,
            )

            logger.info(
                "HASH_GENERATED: org_id='%s' -> org_hash='%s', meeting_url='%s' -> url_hash='%s'",
                org_id,
                org_hash,
                meeting_url,
                url_hash,
            )

            # K8s-based deduplication: Check if a bot is already assigned
            # to this org+URL combination BEFORE creating a new job.
            # This is the final safety check to prevent duplicate bots.
            is_assigned, existing_job = self._is_bot_already_assigned(
                org_id, meeting_url
            )
            if is_assigned:
                logger.warning(
                    "DUPLICATE_PREVENTED: Bot already assigned for org_id='%s', "
                    "meeting_url='%s', existing_job='%s'. Skipping job creation.",
                    org_id,
                    meeting_url,
                    existing_job,
                )
                return False

            logger.info(f"Creating Kubernetes Job: {job_name}")

            # Extract meeting_session_id from payload for session-based jobs
            meeting_session_id = message_data.get("meeting_session_id") or ""

            # Build environment variables for the manager
            env_vars = [
                client.V1EnvVar(name="MEETING_URL", value=meeting_url),
                client.V1EnvVar(name="MEETING_ID", value=meeting_id),
                client.V1EnvVar(
                    name="ORG_ID", value=org_id
                ),  # Explicit org_id for consistency
                client.V1EnvVar(
                    name="TEAM_ID", value=org_id
                ),  # Explicit team_id (same as org_id) for manager compatibility
                client.V1EnvVar(
                    name="MEETING_SESSION_ID", value=meeting_session_id
                ),  # Explicit session_id for fanout marking
                client.V1EnvVar(
                    name="OCCURRENCE_START_UTC", value=occurrence_start_utc
                ),  # Recurring meeting instance identifier
                client.V1EnvVar(name="FS_MEETING_ID", value=str(meeting_doc_id)),
                client.V1EnvVar(name="USER_ID", value=str(user_doc_id)),
                client.V1EnvVar(name="GCS_PATH", value=gcs_path),
                client.V1EnvVar(name="GCS_BUCKET", value=self.gcs_bucket),
                client.V1EnvVar(name="GCP_PROJECT_ID", value=self.project_id),
                client.V1EnvVar(name="GOOGLE_CLOUD_PROJECT", value=self.project_id),
                client.V1EnvVar(name="GCLOUD_PROJECT", value=self.project_id),
                client.V1EnvVar(name="MEETING_BOT_IMAGE", value=self.meeting_bot_image),
                client.V1EnvVar(name="NODE_ENV", value=self.node_env),
                client.V1EnvVar(
                    name="MAX_RECORDING_DURATION_MINUTES",
                    value=str(self.max_recording_duration),
                ),
                client.V1EnvVar(
                    name="MEETING_INACTIVITY_MINUTES",
                    value=str(self.meeting_inactivity),
                ),
                client.V1EnvVar(
                    name="INACTIVITY_DETECTION_START_DELAY_MINUTES",
                    value=str(self.inactivity_detection_delay),
                ),
            ]

            # Add ALL fields from message payload as environment variables
            # This ensures the manager has all the data it needs for the meeting-bot API
            # We add both original case AND uppercase versions for compatibility
            for key, value in message_data.items():
                if value is not None and isinstance(value, (str, int, float, bool)):
                    # Skip keys we've already added explicitly above
                    if key.lower() not in [
                        "meeting_url",
                        "meeting_id",
                        "org_id",
                        "team_id",
                        "gcs_path",
                        "meeting_session_id",
                        "occurrence_start_utc",
                    ]:
                        # Add original case (e.g., bearerToken, teamId, userId)
                        env_vars.append(client.V1EnvVar(name=key, value=str(value)))

                        # Also add UPPERCASE version for backward compatibility (e.g., BEARERTOKEN, TEAM_ID)
                        env_key_upper = key.upper().replace("-", "_")
                        if env_key_upper != key:  # Only add if different from original
                            env_vars.append(
                                client.V1EnvVar(name=env_key_upper, value=str(value))
                            )

            # Add optional metadata fields (for backward compatibility)
            if message_data.get("meeting_title"):
                env_vars.append(
                    client.V1EnvVar(
                        name="MEETING_TITLE", value=message_data["meeting_title"]
                    )
                )
            if message_data.get("organizer"):
                env_vars.append(
                    client.V1EnvVar(
                        name="MEETING_ORGANIZER", value=message_data["organizer"]
                    )
                )
            if message_data.get("start_time"):
                env_vars.append(
                    client.V1EnvVar(
                        name="MEETING_START_TIME", value=message_data["start_time"]
                    )
                )

            # Log key environment variables for debugging
            key_env_vars = {
                "MEETING_URL": meeting_url,
                "MEETING_ID": meeting_id,
                "ORG_ID": org_id,
            }
            logger.info(
                "KEY_ENV_VARS_SET: %s",
                ", ".join([f"{k}={v}" for k, v in key_env_vars.items()]),
            )

            # Log all environment variable names for debugging
            all_env_names = [env_var.name for env_var in env_vars]
            logger.debug("ALL_ENV_VARS: %s", ", ".join(sorted(all_env_names)))

            job_pod_labels = {
                "app": "meeting-bot",
                "org_id_hash": org_hash,
                "meeting_url_hash": url_hash,
            }
            if self.job_use_azure_workload_identity:
                job_pod_labels["azure.workload.identity/use"] = "true"

            meeting_bot_env = [
                client.V1EnvVar(name="PORT", value="3000"),
                client.V1EnvVar(name="NODE_ENV", value=self.node_env),
                # Prefer using the RWX scratch PVC for temp files.
                client.V1EnvVar(name="TMPDIR", value="/scratch/tmp"),
                client.V1EnvVar(name="TMP", value="/scratch/tmp"),
                client.V1EnvVar(name="TEMP", value="/scratch/tmp"),
                # Prefer writing recording artifacts to the scratch PVC.
                client.V1EnvVar(name="TEMPVIDEO_DIR", value="/scratch/tempvideo"),
                client.V1EnvVar(
                    name="MAX_RECORDING_DURATION_MINUTES",
                    value=str(self.max_recording_duration),
                ),
                client.V1EnvVar(
                    name="MEETING_INACTIVITY_MINUTES",
                    value=str(self.meeting_inactivity),
                ),
                client.V1EnvVar(
                    name="INACTIVITY_DETECTION_START_DELAY_MINUTES",
                    value=str(self.inactivity_detection_delay),
                ),
                # Disable S3 upload - manager will handle the recording file
                client.V1EnvVar(name="S3_ENDPOINT", value=""),
                # Required by meeting-bot src/config.ts
                client.V1EnvVar(name="GCP_MISC_BUCKET", value=self.gcs_bucket),
                client.V1EnvVar(
                    name="GCP_DEFAULT_REGION",
                    value=os.getenv("GCP_DEFAULT_REGION", "us-central1"),
                ),
                # Sentry error monitoring
                client.V1EnvVar(name="SENTRY_DSN", value=self.sentry_dsn),
                client.V1EnvVar(name="SENTRY_ENVIRONMENT", value=self.node_env),
            ]
            manager_env = env_vars + [
                # Manager needs to communicate with meeting-bot on localhost
                client.V1EnvVar(
                    name="MEETING_BOT_API_URL", value="http://localhost:3000"
                ),
                # Prefer using the RWX scratch PVC for temp files.
                client.V1EnvVar(name="TMPDIR", value="/scratch/tmp"),
                client.V1EnvVar(name="TMP", value="/scratch/tmp"),
                client.V1EnvVar(name="TEMP", value="/scratch/tmp"),
                # Sentry error monitoring
                client.V1EnvVar(name="SENTRY_DSN", value=self.sentry_dsn),
                client.V1EnvVar(name="SENTRY_ENVIRONMENT", value=self.node_env),
            ]

            manager_runtime_env_vars = [
                "TRANSCRIPTION_MODE",
                "GENERATE_MP4_ARTIFACT",
                "AZURE_SPEECH_REGION",
                "AZURE_SPEECH_ENDPOINT",
                "AZURE_SPEECH_LOCALE",
                "AZURE_SPEECH_ENABLE_DIARIZATION",
                "AZURE_SPEECH_DIARIZATION_MAX_SPEAKERS",
                "AZURE_SPEECH_FALLBACK_TO_OFFLINE",
                "AZURE_SPEECH_KEY",
                "WHISPER_CPP_USE_GPU",
                "WHISPER_CPP_REQUIRE_GPU",
                "WHISPER_CPP_GPU_LAYERS",
                "ENABLE_MEETING_BOT_GPU_SCHEDULING",
                "MEETING_BOT_GPU_NODE_SELECTOR_KEY",
                "MEETING_BOT_GPU_NODE_SELECTOR_VALUE",
                "MEETING_BOT_GPU_TAINT_KEY",
                "MEETING_BOT_GPU_TAINT_VALUE",
                "MEETING_BOT_GPU_TAINT_EFFECT",
                "MEETING_BOT_GPU_RESOURCE_REQUEST",
            ]
            manager_env_names = {env_var.name for env_var in manager_env}
            forwarded_manager_runtime_env_vars: List[str] = []
            for env_name in manager_runtime_env_vars:
                env_value = os.getenv(env_name)
                if env_value is not None and env_name not in manager_env_names:
                    manager_env.append(client.V1EnvVar(name=env_name, value=env_value))
                    manager_env_names.add(env_name)
                    forwarded_manager_runtime_env_vars.append(env_name)
            if forwarded_manager_runtime_env_vars:
                logger.debug(
                    "FORWARDED_MANAGER_RUNTIME_ENV_VARS: %s",
                    ", ".join(forwarded_manager_runtime_env_vars),
                )

            meeting_bot_runtime_env_vars = [
                "RECORDING_VIDEO_BITRATE_BPS",
                "RECORDING_AUDIO_BITRATE_BPS",
                "RECORDING_CHUNK_DURATION_MS",
            ]
            meeting_bot_env_names = {env_var.name for env_var in meeting_bot_env}
            forwarded_meeting_bot_runtime_env_vars: List[str] = []
            for env_name in meeting_bot_runtime_env_vars:
                env_value = os.getenv(env_name)
                if env_value is not None and env_name not in meeting_bot_env_names:
                    meeting_bot_env.append(
                        client.V1EnvVar(name=env_name, value=env_value)
                    )
                    meeting_bot_env_names.add(env_name)
                    forwarded_meeting_bot_runtime_env_vars.append(env_name)
            if forwarded_meeting_bot_runtime_env_vars:
                logger.debug(
                    "FORWARDED_MEETING_BOT_RUNTIME_ENV_VARS: %s",
                    ", ".join(forwarded_meeting_bot_runtime_env_vars),
                )

            meeting_bot_volume_mounts = [
                client.V1VolumeMount(
                    name="scratch", mount_path="/usr/src/app/dist/_tempvideo"
                ),
                client.V1VolumeMount(name="scratch", mount_path="/scratch"),
                # Mount shared memory for Chrome (prevents crashes)
                client.V1VolumeMount(name="dshm", mount_path="/dev/shm"),
                # Mount tmp for XDG and PulseAudio runtime directories
                client.V1VolumeMount(name="tmp", mount_path="/tmp"),
            ]
            manager_volume_mounts = [
                client.V1VolumeMount(name="recordings", mount_path="/recordings"),
                client.V1VolumeMount(name="scratch", mount_path="/scratch"),
            ]
            job_volumes = [
                client.V1Volume(
                    name="recordings", empty_dir=client.V1EmptyDirVolumeSource()
                ),
                # Scratch will be mounted via a per-job RWO PVC created below.
                # Shared memory for Chrome
                client.V1Volume(
                    name="dshm",
                    empty_dir=client.V1EmptyDirVolumeSource(
                        medium="Memory", size_limit="2Gi"
                    ),
                ),
                # Temporary storage for runtime dirs (XDG, PulseAudio)
                client.V1Volume(name="tmp", empty_dir=client.V1EmptyDirVolumeSource()),
            ]

            if self.job_gcp_adc_secret_name:
                meeting_bot_env.append(
                    client.V1EnvVar(
                        name="GOOGLE_APPLICATION_CREDENTIALS",
                        value=self.job_google_application_credentials,
                    )
                )
                manager_env.append(
                    client.V1EnvVar(
                        name="GOOGLE_APPLICATION_CREDENTIALS",
                        value=self.job_google_application_credentials,
                    )
                )
                meeting_bot_volume_mounts.append(
                    client.V1VolumeMount(
                        name="gcp-adc",
                        mount_path=self.job_google_application_credentials_dir,
                        read_only=True,
                    )
                )
                manager_volume_mounts.append(
                    client.V1VolumeMount(
                        name="gcp-adc",
                        mount_path=self.job_google_application_credentials_dir,
                        read_only=True,
                    )
                )
                job_volumes.append(
                    client.V1Volume(
                        name="gcp-adc",
                        secret=client.V1SecretVolumeSource(
                            secret_name=self.job_gcp_adc_secret_name
                        ),
                    )
                )
                logger.info(
                    "JOB_ADC_ENABLED: secret=%s credentials_path=%s",
                    self.job_gcp_adc_secret_name,
                    self.job_google_application_credentials,
                )

            # Container 1: meeting-bot (TypeScript app that joins meetings)
            meeting_bot_container = client.V1Container(
                name="meeting-bot",
                image=self.meeting_bot_image,
                image_pull_policy="IfNotPresent",
                env=meeting_bot_env,
                volume_mounts=meeting_bot_volume_mounts,
                resources=client.V1ResourceRequirements(
                    requests=dict(self.meeting_bot_resource_requests),
                    limits=dict(self.meeting_bot_resource_limits),
                ),
            )

            pod_node_selector = None
            pod_tolerations = None

            # Container 2: manager (Python orchestrator that calls meeting-bot API)
            manager_container = client.V1Container(
                name="manager",
                image=self.manager_image,
                env=manager_env,
                volume_mounts=manager_volume_mounts,
                image_pull_policy="IfNotPresent",
                resources=client.V1ResourceRequirements(
                    requests=dict(self.manager_resource_requests),
                    limits=dict(self.manager_resource_limits),
                ),
            )
            if self.enable_meeting_bot_gpu_scheduling:
                manager_container.resources.requests["nvidia.com/gpu"] = (
                    self.meeting_bot_gpu_resource_request
                )
                manager_container.resources.limits["nvidia.com/gpu"] = (
                    self.meeting_bot_gpu_resource_request
                )
                pod_node_selector = {
                    self.meeting_bot_gpu_node_selector_key: self.meeting_bot_gpu_node_selector_value
                }
                pod_tolerations = [
                    client.V1Toleration(
                        key=self.meeting_bot_gpu_taint_key,
                        operator="Equal",
                        value=self.meeting_bot_gpu_taint_value,
                        effect=self.meeting_bot_gpu_taint_effect,
                    )
                ]

            # Define the pod template with BOTH containers
            template = client.V1PodTemplateSpec(
                metadata=client.V1ObjectMeta(
                    labels=job_pod_labels,
                    annotations={
                        "cluster-autoscaler.kubernetes.io/safe-to-evict": "false"
                    },
                ),
                spec=client.V1PodSpec(
                    restart_policy="Never",
                    priority_class_name="high-priority",
                    init_containers=[
                        client.V1Container(
                            name="init-scratch-dirs",
                            image="busybox:1.36",
                            command=[
                                "sh",
                                "-c",
                                "mkdir -p /scratch/tmp /scratch/tempvideo && chmod 1777 /scratch/tmp && chmod 0777 /scratch/tempvideo",
                            ],
                            volume_mounts=[
                                client.V1VolumeMount(
                                    name="scratch", mount_path="/scratch"
                                )
                            ],
                        )
                    ],
                    containers=[meeting_bot_container, manager_container],
                    service_account_name=self.job_service_account,
                    # Security context for audio/video capture
                    security_context=client.V1PodSecurityContext(
                        run_as_user=1001,  # nodejs user
                        run_as_group=1001,
                        fs_group=1001,  # Ensures volume mounts have correct permissions
                    ),
                    volumes=job_volumes,
                    node_selector=pod_node_selector,
                    tolerations=pod_tolerations,
                ),
            )

            # Create a per-job RWO scratch PVC for /scratch.
            # This avoids relying on RWX provisioning and keeps large artifacts
            # off node ephemeral storage.
            scratch_pvc_name = f"{job_name}-scratch"

            # Compute URL hash for K8s label-based deduplication (used for both PVC and Job)
            url_hash = self._meeting_url_hash(meeting_url)

            # PVC labels (subset of job labels for easy identification)
            pvc_labels = {
                "app": "meeting-bot",
                "org_id_hash": org_hash,
                "meeting_url_hash": url_hash,
            }

            # DRY_RUN mode - log what would be created but don't actually create K8s resources
            if self.dry_run:
                logger.info(
                    "DRY_RUN: Would create job '%s' for meeting %s (org=%s, user=%s)",
                    job_name,
                    meeting_doc_id,
                    org_id,
                    user_doc_id,
                )
                logger.info(
                    "DRY_RUN: Job spec: session_id=%s, meeting_url=%s, gcs_path=%s",
                    session_id,
                    meeting_url[:80] if meeting_url else "none",
                    gcs_path,
                )
                return True

            scratch_pvc = client.V1PersistentVolumeClaim(
                api_version="v1",
                kind="PersistentVolumeClaim",
                metadata=client.V1ObjectMeta(
                    name=scratch_pvc_name,
                    namespace=self.k8s_namespace,
                    labels=pvc_labels,
                ),
                spec=client.V1PersistentVolumeClaimSpec(
                    access_modes=["ReadWriteOnce"],
                    storage_class_name=os.getenv(
                        "SCRATCH_STORAGE_CLASS", "standard-rwo"
                    ),
                    resources=client.V1ResourceRequirements(
                        requests={"storage": os.getenv("SCRATCH_STORAGE_SIZE", "50Gi")}
                    ),
                ),
            )

            # Check if the PVC already exists (e.g., from a previous failed attempt)
            # and delete it before creating a new one to avoid 409 Conflict errors.
            try:
                existing_pvc = self.core_v1.read_namespaced_persistent_volume_claim(
                    name=scratch_pvc_name, namespace=self.k8s_namespace
                )
                logger.warning(
                    "PVC_CLEANUP: Found existing PVC %s (phase=%s), deleting before recreation",
                    scratch_pvc_name,
                    existing_pvc.status.phase if existing_pvc.status else "unknown",
                )
                self.core_v1.delete_namespaced_persistent_volume_claim(
                    name=scratch_pvc_name, namespace=self.k8s_namespace
                )
                # Brief wait for deletion to propagate
                time.sleep(1)
            except ApiException as e:
                if e.status != 404:
                    # Re-raise if it's not a "not found" error
                    raise

            self.core_v1.create_namespaced_persistent_volume_claim(
                namespace=self.k8s_namespace, body=scratch_pvc
            )

            logger.info("Scratch PVC for job %s: %s", job_name, scratch_pvc_name)

            # Add the scratch volume to the template now that the PVC exists.
            template.spec.volumes.insert(
                1,
                client.V1Volume(
                    name="scratch",
                    persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(
                        claim_name=scratch_pvc_name
                    ),
                ),
            )

            # Build job labels (used for deduplication)
            job_labels = {
                "app": "meeting-bot",
                "org_id_hash": org_hash,
                "meeting_url_hash": url_hash,
            }

            # Define and create the job.
            job = client.V1Job(
                api_version="batch/v1",
                kind="Job",
                metadata=client.V1ObjectMeta(
                    name=job_name,
                    namespace=self.k8s_namespace,
                    labels=job_labels,
                ),
                spec=client.V1JobSpec(
                    template=template,
                    backoff_limit=0,  # Do not retry on failure
                    # Hard cap the overall job runtime. This prevents runaway
                    # pods if recording/monitoring gets stuck.
                    active_deadline_seconds=39600,  # 11 hours
                    ttl_seconds_after_finished=3600,  # Clean up after 1 hour
                ),
            )

            created_job = self.batch_v1.create_namespaced_job(
                namespace=self.k8s_namespace,
                body=job,
            )

            # Update the scratch PVC ownerReference to point at the Job.
            scratch_pvc.metadata.owner_references = [
                client.V1OwnerReference(
                    api_version=created_job.api_version,
                    kind=created_job.kind,
                    name=created_job.metadata.name,
                    uid=created_job.metadata.uid,
                    controller=True,
                    block_owner_deletion=True,
                )
            ]
            self.core_v1.patch_namespaced_persistent_volume_claim(
                name=scratch_pvc_name,
                namespace=self.k8s_namespace,
                body={
                    "metadata": {
                        "ownerReferences": scratch_pvc.metadata.owner_references
                    }
                },
            )

            # LLM-FRIENDLY: Comprehensive job creation success log
            logger.info(
                "BOT_JOB_CREATED: job_name=%s, session_id=%s, org_id=%s, "
                "meeting_id=%s, meeting_url=%s, user_id=%s, gcs_path=%s",
                job_name,
                session_id,
                org_id,
                meeting_id,
                meeting_url[:50] if meeting_url else "none",
                user_doc_id,
                gcs_path,
            )
            logger.info(f"✅ Created job '{job_name}' for meeting {meeting_id}")
            return True

        except ApiException as e:
            # LLM-FRIENDLY: K8s API error with full context
            logger.error(
                "BOT_JOB_FAILED: reason=k8s_api_error, session_id=%s, "
                "org_id=%s, meeting_url=%s, error=%s",
                session_id,
                org_id,
                meeting_url[:50] if meeting_url else "none",
                str(e)[:200],
            )
            logger.error(
                "LLM_CONTEXT: Kubernetes API rejected job creation. "
                "Common causes: resource quota exceeded, invalid job spec, "
                "namespace issues, RBAC permissions. Error: %s",
                str(e),
            )
            return False
        except Exception as e:
            # LLM-FRIENDLY: Generic error with context
            logger.error(
                "BOT_JOB_FAILED: reason=exception, session_id=%s, "
                "org_id=%s, meeting_url=%s, error_type=%s, error=%s",
                session_id,
                org_id,
                meeting_url[:50] if meeting_url else "none",
                type(e).__name__,
                str(e)[:200],
            )
            logger.error(f"❌ Error creating manager job: {e}")
            return False

    def _build_job_payload_from_firestore(
        self, bot_doc: firestore.DocumentSnapshot
    ) -> Dict[str, Any]:
        """Translate a bot_instance Firestore doc into the payload expected by the manager.

        This mirrors (a subset of) what the Firebase callable function used to publish
        to Pub/Sub.
        """
        data = bot_doc.to_dict() or {}

        meeting_url = data.get("meeting_url")
        if not meeting_url:
            raise ValueError("bot_instance missing meeting_url")

        # Best-effort meeting id (join link meeting id).
        meeting_id = (
            data.get("meeting_id")
            or data.get("initial_linked_meeting", {}).get("meeting_id")
            or bot_doc.id
        )

        # Canonical Firebase document id used for storage prefix.
        meeting_doc_id = bot_doc.id

        org_id = (
            data.get("creator_organization_id")
            or data.get("initial_linked_meeting", {}).get("organization_id")
            or ""
        )

        now = datetime.now(timezone.utc)

        user_doc_id = (
            data.get("creator_user_id")
            or data.get("user_id")
            or data.get("initial_linked_meeting", {}).get("user_id")
            or ""
        )

        gcs_path = (
            f"recordings/{user_doc_id}/{meeting_doc_id}"
            if user_doc_id
            else f"recordings/{meeting_doc_id}"
        )

        # Determine meeting bot display name.
        # Migration: `meeting_bot_name` moved from users/{uid} to organizations/{orgId}.
        bot_display_name = "AdviseWell"
        if org_id and getattr(self, "db", None) is not None:
            try:
                org_snap = self.db.collection("organizations").document(org_id).get()
                if org_snap.exists:
                    org_data = org_snap.to_dict() or {}
                    candidate = org_data.get("meeting_bot_name")
                    if isinstance(candidate, str) and candidate.strip():
                        bot_display_name = candidate.strip()
            except Exception:
                # Never fail job creation due to missing org doc or transient Firestore issues.
                pass

        payload: Dict[str, Any] = {
            "meeting_url": meeting_url,
            "meeting_id": meeting_id,
            "gcs_path": gcs_path,
            "fs_meeting_id": meeting_doc_id,
            # Maintain compatibility with existing manager payload expectations.
            "name": bot_display_name,
            "teamId": org_id or data.get("teamId") or data.get("team_id") or meeting_id,
            "timezone": data.get("timezone") or "UTC",
            "user_id": user_doc_id,
            "user_email": data.get("user_email", ""),
            "initiated_at": data.get("initiated_at")
            or (now.isoformat().replace("+00:00", "Z")),
            "auto_joined": bool(data.get("auto_joined", False)),
            # Handy for consumers/debugging.
            "bot_instance_id": bot_doc.id,
        }

        # Preserve pass-through fields if present.
        for key in [
            "bearerToken",
            "bearer_token",
            "userId",
            "user_id",
            "botId",
            "bot_id",
            "eventId",
            "event_id",
        ]:
            if key in data and data[key] is not None:
                payload[key] = data[key]

        return payload

    def _query_queued_bot_instances(self) -> List[firestore.DocumentSnapshot]:
        """Find candidate bot instances to process."""
        q = (
            self.db.collection("bot_instances")
            .where(
                field_path=self.bot_instance_status_field,
                op_string="==",
                value=self.bot_instance_queued_value,
            )
            .limit(self.max_claim_per_poll)
        )
        results = list(q.stream())
        logger.debug(
            f"Query bot_instances where {self.bot_instance_status_field}="
            f"'{self.bot_instance_queued_value}': found {len(results)} docs"
        )
        return results

    # --- Meeting session dedupe (org + meeting_url) ---
    def _normalize_meeting_url(self, url: str) -> str:
        """Normalize meeting URLs so equivalent invites hash to the same session.

        Keep this intentionally conservative: strip whitespace, drop fragments,
        and remove common tracking query params.

        IMPORTANT: Meeting URLs are case-insensitive. Teams, Zoom, and Google Meet
        all treat URLs as case-insensitive, so we lowercase the entire URL
        (scheme, netloc, path, and query) to ensure equivalent URLs hash the same.
        """

        raw = (url or "").strip()
        if not raw:
            return ""

        # Lowercase the entire URL before parsing to ensure case-insensitive matching.
        # Meeting providers (Teams, Zoom, Meet) treat URLs as case-insensitive.
        raw_lower = raw.lower()

        parts = urlsplit(raw_lower)

        # Drop fragment and normalize components.
        scheme = parts.scheme or "https"
        netloc = parts.netloc
        path = parts.path.rstrip("/")

        # Filter query params (Teams/Zoom links often have tracking params).
        # Keep provider-specific critical params if any are needed later.
        # Also strip trailing slashes from query param values (can happen with
        # malformed URLs like "?p=abc/#fragment" where "/" ends up in the value).
        filtered_query_items: List[str] = []
        if parts.query:
            for kv in parts.query.split("&"):
                k = kv.split("=", 1)[0]
                if k in {
                    "utm_source",
                    "utm_medium",
                    "utm_campaign",
                    "utm_term",
                    "utm_content",
                }:
                    continue
                if k in {"fbclid", "gclid"}:
                    continue
                # Strip trailing slashes from the param value
                filtered_query_items.append(kv.rstrip("/"))

        normalized_query = "&".join(filtered_query_items)
        return urlunsplit((scheme, netloc, path, normalized_query, ""))

    def _meeting_session_id(
        self, *, org_id: str, meeting_url: str, occurrence_start_utc: str = ""
    ) -> str:
        """
        Generate deterministic session ID.

        For recurring meetings (with occurrence_start_utc):
          hash(org_id:normalized_url:occurrence_start_utc)

        For single meetings or backward compatibility:
          hash(org_id:normalized_url:)  # Empty string appended
        """
        normalized = self._normalize_meeting_url(meeting_url)
        base = f"{(org_id or '').strip()}:{normalized}:{occurrence_start_utc}".encode(
            "utf-8"
        )
        return hashlib.sha256(base).hexdigest()

    def _meeting_url_hash(self, meeting_url: str) -> str:
        """Compute a 16-char hash of the normalized meeting URL for K8s labels."""
        normalized = self._normalize_meeting_url(meeting_url)
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]

    def _org_id_hash(self, org_id: str) -> str:
        """Compute a 12-char hash of the org_id for K8s job names."""
        if not org_id:
            return "no-org"
        return hashlib.sha256(org_id.encode("utf-8")).hexdigest()[:12]

    def _sanitize_label_value(self, value: str) -> str:
        """Sanitize a value for use as a K8s label.

        K8s labels must:
        - Be max 63 characters
        - Contain only alphanumeric, '-', '_', '.'
        - Start and end with alphanumeric
        """
        if not value:
            return ""
        # Replace invalid chars with dashes
        sanitized = re.sub(r"[^a-zA-Z0-9_.-]", "-", str(value))
        # Strip leading/trailing dashes
        sanitized = sanitized.strip("-")
        return sanitized[:63]

    def _is_bot_already_assigned(
        self, org_id: str, meeting_url: str
    ) -> Tuple[bool, Optional[str]]:
        """Check if an active bot job exists for this org + meeting URL.

        Uses K8s job labels to determine if a bot is already assigned to a meeting.
        This replaces the Firestore session-based deduplication.

        Uses labels 'org_id_hash' and 'meeting_url_hash' for precise matching.
        Job names include timestamps for uniqueness to avoid Kubernetes conflicts.

        Returns:
            (is_assigned, job_name): Whether a bot is active and its name if so
        """
        # In dry-run mode, skip K8s queries and assume no bot is assigned
        if self.dry_run:
            logger.debug("DRY_RUN: Skipping K8s job check for org=%s", org_id)
            return False, None

        url_hash = self._meeting_url_hash(meeting_url)
        org_hash = self._org_id_hash(org_id)

        logger.debug(
            "DEDUP_HASH_CHECK: org_id='%s' -> org_hash='%s', meeting_url='%s' -> url_hash='%s'",
            org_id,
            org_hash,
            meeting_url,
            url_hash,
        )

        if not org_hash or not url_hash:
            logger.warning(
                "Cannot check bot assignment: org_id=%s, org_hash=%s, url_hash=%s",
                org_id,
                org_hash,
                url_hash,
            )
            return False, None

        # Use hash labels for precise deduplication matching
        label_selector = (
            f"app=meeting-bot,"
            f"org_id_hash={org_hash},"
            f"meeting_url_hash={url_hash}"
        )

        logger.debug(
            "DEDUP_CHECK: Querying K8s jobs with label_selector=%s", label_selector
        )

        try:
            jobs = self.batch_v1.list_namespaced_job(
                namespace=self.k8s_namespace,
                label_selector=label_selector,
            )

            # If no jobs found with specific org_hash and org_id is not empty,
            # also check for jobs with "no-org" as a fallback for legacy compatibility
            if not jobs.items and org_id and org_hash != "no-org":
                fallback_label_selector = (
                    f"app=meeting-bot,"
                    f"org_id_hash=no-org,"
                    f"meeting_url_hash={url_hash}"
                )
                logger.debug(
                    "DEDUP_FALLBACK: No jobs found, checking fallback label_selector=%s",
                    fallback_label_selector,
                )
                jobs = self.batch_v1.list_namespaced_job(
                    namespace=self.k8s_namespace,
                    label_selector=fallback_label_selector,
                )

        except ApiException as e:
            logger.warning("Failed to query K8s jobs for dedup: %s", e)
            return False, None

        for job in jobs.items:
            if not self._is_job_terminal(job):
                logger.info(
                    "BOT_ALREADY_ASSIGNED: org_id=%s, org_hash=%s, url_hash=%s, job=%s",
                    org_id,
                    org_hash,
                    url_hash,
                    job.metadata.name,
                )
                return True, job.metadata.name

        return False, None

    def _meeting_session_ref(
        self, *, org_id: str, session_id: str
    ) -> firestore.DocumentReference:
        """Return the Firestore ref for a meeting session.

        Sessions are namespaced per org to avoid cross-org collisions and to keep
        session lifecycle state isolated.
        """

        return (
            self.db.collection("organizations")
            .document(str(org_id))
            .collection("meeting_sessions")
            .document(str(session_id))
        )

    # --- Duplicate meeting detection and consolidation ---
    def _extract_meeting_key(self, url: str) -> Optional[str]:
        """
        Extract a unique meeting key from the URL.

        For Teams: The meeting ID from the URL
        For Meet: The meeting code
        For Zoom: The meeting ID

        Returns:
            A unique key like "teams:123456" or None if can't extract
        """
        if not url:
            return None

        import re

        url_lower = url.lower()

        # Teams Meet URLs: /meet/4393898968980?p=...
        if "teams.microsoft.com/meet/" in url_lower:
            match = re.search(r"/meet/(\d+)", url)
            if match:
                return f"teams:{match.group(1)}"

        # Teams meetup-join URLs: /meetup-join/19%3ameeting_xxx/...
        if "teams.microsoft.com/l/meetup-join" in url_lower:
            # Extract the meeting GUID from encoded URL
            match = re.search(r"meeting_([A-Za-z0-9]+)", url)
            if match:
                return f"teams:meeting_{match.group(1)}"

        # Google Meet: /abc-defg-hij
        if "meet.google.com/" in url_lower:
            match = re.search(r"meet\.google\.com/([a-z]+-[a-z]+-[a-z]+)", url_lower)
            if match:
                return f"meet:{match.group(1)}"

        # Zoom: /j/12345678901
        if "zoom.us/j/" in url_lower or "zoom.com/j/" in url_lower:
            match = re.search(r"/j/(\d+)", url)
            if match:
                return f"zoom:{match.group(1)}"

        return None

    def _create_bot_for_meeting(
        self,
        meeting_doc: firestore.DocumentSnapshot,
        org_id: str,
        meeting_url: str,
        user_id: str,
    ) -> bool:
        """Create a K8s job directly for a meeting using K8s-based deduplication.

        This is the new simplified flow that bypasses Firestore session management
        and uses K8s job labels for deduplication instead.

        Args:
            meeting_doc: The Firestore meeting document
            org_id: Organization ID
            meeting_url: The meeting URL
            user_id: The user ID requesting the bot

        Returns:
            True if job created successfully, False otherwise
        """
        data = meeting_doc.to_dict() or {}
        meeting_ref = meeting_doc.reference

        # Extract occurrence_start_utc from meeting document for recurring meetings
        occurrence_start_utc = data.get("occurrence_start_utc") or ""

        # Compute meeting_id (same as session_id for consistency)
        meeting_id = self._meeting_session_id(
            org_id=org_id,
            meeting_url=meeting_url,
            occurrence_start_utc=occurrence_start_utc,
        )

        # Build job payload
        payload = {
            "meeting_id": meeting_id,
            "meeting_url": meeting_url,
            "org_id": org_id,
            "team_id": org_id,
            "user_id": user_id,
            "fs_meeting_id": meeting_doc.id,
            "gcs_path": f"recordings/{user_id}/{meeting_doc.id}",
            # Include meeting_session_id for fanout marking
            "meeting_session_id": meeting_id,
            # Include other fields from meeting doc
            "meeting_title": data.get("title") or data.get("subject"),
            "timezone": data.get("timezone", "UTC"),
            "auto_joined": True,
            "initiated_at": datetime.now(timezone.utc).isoformat(),
        }

        # Get org-specific bot name (same field as other code paths)
        bot_display_name = "AdviseWell"
        try:
            org_ref = self.db.collection("organizations").document(org_id)
            org_doc = org_ref.get()
            if org_doc.exists:
                org_data = org_doc.to_dict() or {}
                candidate = org_data.get("meeting_bot_name")
                if isinstance(candidate, str) and candidate.strip():
                    bot_display_name = candidate.strip()
        except Exception as e:
            logger.warning("Failed to get org bot name: %s", e)
        payload["name"] = bot_display_name

        # Create the job
        success = self.create_manager_job(payload, meeting_id[:16])

        if success:
            # Update meeting doc with job reference
            now = datetime.now(timezone.utc)
            try:
                meeting_ref.update(
                    {
                        "bot_status": "joining",
                        "bot_job_created_at": now,
                        "meeting_session_id": meeting_id[:16],
                        "session_status": "processing",
                    }
                )
            except Exception as e:
                logger.warning("Failed to update meeting doc after job creation: %s", e)

            logger.info(
                "BOT_CREATED_FOR_MEETING: meeting_id=%s, org_id=%s, user_id=%s",
                meeting_doc.id,
                org_id,
                user_id,
            )
        else:
            logger.error(
                "BOT_CREATION_FAILED: meeting_id=%s, org_id=%s, user_id=%s",
                meeting_doc.id,
                org_id,
                user_id,
            )

        return success

    def _link_meeting_to_existing_bot(
        self,
        meeting_doc: firestore.DocumentSnapshot,
        existing_job_name: str,
    ) -> None:
        """Link a meeting document to an existing bot job.

        When K8s deduplication finds an active job for the same org+URL,
        this method links the new meeting to that job for fanout purposes.

        Args:
            meeting_doc: The Firestore meeting document
            existing_job_name: Name of the existing K8s job
        """
        try:
            now = datetime.now(timezone.utc)
            meeting_doc.reference.update(
                {
                    "bot_job_name": existing_job_name,
                    "bot_status": "assigned",
                    "assigned_at": now,
                }
            )
            logger.info(
                "MEETING_LINKED_TO_BOT: meeting_id=%s, job=%s",
                meeting_doc.id,
                existing_job_name,
            )
        except Exception as e:
            logger.warning(
                "Failed to link meeting %s to job %s: %s",
                meeting_doc.id,
                existing_job_name,
                e,
            )

    def _try_create_or_update_session_for_meeting(
        self,
        meeting_doc: firestore.DocumentSnapshot,
    ) -> Optional[str]:
        """Ensure a meeting_session exists and register the meeting's user as a subscriber.

        This is the key behavior that makes "one bot per org+meeting" possible.

        Returns:
            session_id (sha256 hex) if session/subscription created/updated.
        """

        meeting_data = meeting_doc.to_dict() or {}
        meeting_ref = meeting_doc.reference

        logger.debug("=" * 80)
        logger.debug("SESSION DEDUPLICATION LOGIC")
        logger.debug("=" * 80)
        logger.debug("Meeting ID: %s", meeting_doc.id)
        logger.debug(
            "Meeting data: %s", json.dumps(meeting_data, indent=2, default=str)
        )

        meeting_url = (
            meeting_data.get("meeting_url")
            or meeting_data.get("meetingUrl")
            or meeting_data.get("join_url")
        )
        if not meeting_url:
            logger.debug(
                "DEDUPLICATION DECISION: No meeting URL found, cannot deduplicate"
            )
            logger.debug("Available fields: %s", list(meeting_data.keys()))
            return None

        logger.debug("Meeting URL: %s", meeting_url)

        org_id = (
            meeting_data.get("organization_id")
            or meeting_data.get("organizationId")
            or meeting_data.get("teamId")
            or meeting_data.get("team_id")
            or ""
        )
        user_id = meeting_data.get("user_id") or meeting_data.get("userId") or ""
        occurrence_start_utc = meeting_data.get("occurrence_start_utc") or ""

        logger.debug("Organization ID: %s", org_id)
        logger.debug("User ID: %s", user_id)

        if not org_id:
            # Without org we can't safely dedupe.
            logger.debug(
                "DEDUPLICATION DECISION: No organization ID, cannot deduplicate"
            )
            return None
        if not user_id:
            # Without user we can't subscribe/fan-out.
            logger.debug("DEDUPLICATION DECISION: No user ID, cannot subscribe/fan-out")
            return None

        session_id = self._meeting_session_id(
            org_id=org_id,
            meeting_url=str(meeting_url),
            occurrence_start_utc=occurrence_start_utc,
        )

        logger.debug("Computed session ID (SHA256 of org+URL): %s", session_id)

        session_ref = self._meeting_session_ref(org_id=org_id, session_id=session_id)
        subscriber_ref = session_ref.collection("subscribers").document(str(user_id))

        logger.debug("Session reference path: %s", session_ref.path)
        logger.debug("Subscriber reference path: %s", subscriber_ref.path)

        now = datetime.now(timezone.utc)

        transaction = self.db.transaction()

        @firestore.transactional
        def _txn(txn: firestore.Transaction) -> Optional[str]:
            # IMPORTANT: Read ALL documents first, before any writes.
            # Firestore transactions do not allow reads after writes.
            logger.debug("Transaction started: reading documents...")
            fresh_meeting = meeting_ref.get(transaction=txn)
            if not fresh_meeting.exists:
                logger.debug("Transaction: meeting document no longer exists")
                return None

            fresh_data = fresh_meeting.to_dict() or {}
            # Re-read fields inside txn.
            fresh_meeting_url = (
                fresh_data.get("meeting_url")
                or fresh_data.get("meetingUrl")
                or fresh_data.get("join_url")
            )
            if not fresh_meeting_url:
                logger.debug("Transaction: meeting URL no longer available")
                return None
            fresh_occurrence_start_utc = fresh_data.get("occurrence_start_utc") or ""
            is_past_meeting, past_reason = self._is_meeting_payload_past(
                fresh_data, now=now
            )

            # Read session doc.
            sess_snap = session_ref.get(transaction=txn)
            logger.debug("Transaction: session exists=%s", sess_snap.exists)

            # Read subscriber doc.
            sub_snap = subscriber_ref.get(transaction=txn)
            logger.debug("Transaction: subscriber exists=%s", sub_snap.exists)

            if is_past_meeting:
                stale_reason = f"stale_{past_reason or 'timing_threshold'}"
                logger.info(
                    "SESSION_CREATE_SKIPPED_STALE: meeting_id=%s, org_id=%s, reason=%s",
                    meeting_doc.id,
                    org_id,
                    stale_reason,
                )
                txn.update(
                    meeting_ref,
                    {
                        "session_status": "cancelled",
                        "session_cancelled_at": now,
                        "session_cancel_reason": stale_reason,
                        "updated_at": now,
                    },
                )

                if sess_snap.exists:
                    sess_data = sess_snap.to_dict() or {}
                    sess_status = sess_data.get("status", "")
                    if sess_status in {"queued", "claimed", "processing"}:
                        txn.update(
                            session_ref,
                            {
                                "status": "failed",
                                "processed_at": now,
                                "updated_at": now,
                                "failure_reason": stale_reason,
                            },
                        )
                return None

            # Now perform all writes.
            # Create session doc if missing.
            if not sess_snap.exists:
                logger.debug("Transaction: Creating new session document")
                txn.set(
                    session_ref,
                    {
                        "status": "queued",
                        "org_id": org_id,
                        "meeting_url": str(fresh_meeting_url),
                        "occurrence_start_utc": fresh_occurrence_start_utc,
                        "created_at": now,
                        "updated_at": now,
                    },
                )
                logger.debug(
                    "DEDUPLICATION DECISION: New session created for org=%s, url=%s",
                    org_id,
                    fresh_meeting_url,
                )
            else:
                # Session exists - check if it's in a terminal state.
                # For recurring meetings with the same URL, a previous session
                # may be complete/failed. We need to re-queue it for the new
                # occurrence.
                sess_data = sess_snap.to_dict() or {}
                sess_status = sess_data.get("status", "")

                # Enhanced logging for session check
                logger.info(
                    "SESSION_CHECK: session_id=%s, org_id=%s, exists=true, "
                    "current_status=%s",
                    session_id[:16],
                    org_id,
                    sess_status,
                )

                # Terminal states that indicate a previous meeting occurrence
                # has finished - we should re-queue for the new occurrence.
                terminal_states = {"complete", "failed", "cancelled", "error"}

                if sess_status in terminal_states:
                    # Re-queue the session for this new meeting occurrence
                    logger.info(
                        "SESSION_REQUEUE_DECISION: session_id=%s, "
                        "current_status=%s, is_terminal=true, action=requeue",
                        session_id[:16],
                        sess_status,
                    )
                    txn.update(
                        session_ref,
                        {
                            "status": "queued",
                            "updated_at": now,
                            "requeued_at": now,
                            "previous_status": sess_status,
                        },
                    )
                    logger.info(
                        "SESSION_STATUS_CHANGE: session_id=%s, from_status=%s, "
                        "to_status=queued, trigger=recurring_requeue",
                        session_id[:16],
                        sess_status,
                    )
                elif sess_status == "queued":
                    # Already queued, just update timestamp
                    logger.debug(
                        "Transaction: Session already queued, updating timestamp"
                    )
                    txn.update(session_ref, {"updated_at": now})
                    logger.debug(
                        "DEDUPLICATION DECISION: Existing queued session - bot will be shared"
                    )
                else:
                    # Session is in progress (e.g., "processing", "claimed")
                    # Just update timestamp, don't interfere
                    logger.debug("Transaction: Session in progress (%s)", sess_status)
                    txn.update(session_ref, {"updated_at": now})
                    logger.debug(
                        "DEDUPLICATION DECISION: Session in progress - bot already running"
                    )

            # Ensure subscriber.
            if not sub_snap.exists:
                logger.debug("Transaction: Adding new subscriber user_id=%s", user_id)
                txn.set(
                    subscriber_ref,
                    {
                        "user_id": str(user_id),
                        # Where copies should land:
                        "fs_meeting_id": meeting_doc.id,
                        # Store the meeting reference path for fanout updates
                        "meeting_path": meeting_ref.path,
                        "status": "requested",
                        "requested_at": now,
                        "updated_at": now,
                    },
                )
                logger.debug(
                    "FANOUT RECIPIENT: User %s will receive copies via fanout", user_id
                )
            else:
                logger.debug(
                    "Transaction: Subscriber already exists, updating timestamp"
                )
                txn.update(subscriber_ref, {"updated_at": now})
                logger.debug("FANOUT RECIPIENT: User %s already subscribed", user_id)

            # Link meeting to session (handy for debugging/UI).
            clean_session_id = (
                session_id.strip() if isinstance(session_id, str) else session_id
            )
            txn.update(
                meeting_ref,
                {
                    "meeting_session_id": clean_session_id,
                    "session_status": "queued",
                    "session_enqueued_at": now,
                },
            )
            logger.debug("Transaction: Meeting linked to session %s", clean_session_id)

            return session_id

        try:
            result = _txn(transaction)
            if result:
                logger.debug("Session deduplication successful: session_id=%s", result)
            logger.debug("=" * 80)
            return result
        except Exception as e:
            logger.error(
                "Failed to create/update meeting session for meeting %s: %s",
                meeting_doc.id,
                e,
                exc_info=True,
            )
            return None

    def _query_queued_meeting_sessions(self) -> List[firestore.DocumentSnapshot]:
        # Query across all orgs.
        q = (
            self.db.collection_group("meeting_sessions")
            .where(field_path="status", op_string="==", value="queued")
            .limit(self.max_claim_per_poll)
        )
        results = list(q.stream())
        logger.debug(
            "Query meeting_sessions where status='queued': found %d docs", len(results)
        )
        return results

    @staticmethod
    def _is_job_terminal(job: Any) -> bool:
        """Return True when a Kubernetes Job is complete or failed."""
        conditions = getattr(getattr(job, "status", None), "conditions", None) or []
        return any(
            getattr(condition, "type", "") in ("Complete", "Failed")
            and getattr(condition, "status", "") == "True"
            for condition in conditions
        )

    @staticmethod
    def _session_age_minutes(session_data: Dict[str, Any]) -> Optional[float]:
        """Calculate session age in minutes from claimed/updated/created timestamps."""
        now_timestamp = datetime.now(timezone.utc).timestamp()
        for field in ("claimed_at", "updated_at", "created_at"):
            candidate = session_data.get(field)
            if candidate is None or not hasattr(candidate, "timestamp"):
                continue
            try:
                return max(0.0, (now_timestamp - candidate.timestamp()) / 60)
            except Exception:
                continue
        return None

    def _remediate_orphaned_session(
        self,
        session_ref: firestore.DocumentReference,
        *,
        session_id: str,
        org_id: str,
        previous_status: str,
        age_minutes: Optional[float],
        action_override: Optional[str] = None,
        remediation_reason: str = "missing_k8s_job",
    ) -> bool:
        """Apply configured remediation for an orphaned processing session."""
        now = datetime.now(timezone.utc)
        action = (action_override or self.orphaned_session_remediation_action).strip().lower()
        if action not in {"requeue", "failed"}:
            raise ValueError(f"Invalid remediation action: {action}")
        controller_id = (
            os.getenv("CONTROLLER_ID") or os.getenv("HOSTNAME") or "controller"
        )

        transaction = self.db.transaction()

        @firestore.transactional
        def _txn(txn: firestore.Transaction) -> bool:
            snap = session_ref.get(transaction=txn)
            if not snap.exists:
                logger.info(
                    "SESSION_ORPHANED_REMEDIATION_SKIPPED: session_id=%s, org_id=%s, "
                    "reason=session_not_found",
                    session_id[:16],
                    org_id,
                )
                return False

            current_data = snap.to_dict() or {}
            current_status = current_data.get("status", "unknown")
            if current_status not in ("claimed", "processing"):
                logger.info(
                    "SESSION_ORPHANED_REMEDIATION_SKIPPED: session_id=%s, org_id=%s, "
                    "reason=status_changed, current_status=%s",
                    session_id[:16],
                    org_id,
                    current_status,
                )
                return False

            remediation_count = (
                int(current_data.get("orphaned_session_remediation_count", 0)) + 1
            )
            update_payload: Dict[str, Any] = {
                "updated_at": now,
                "orphaned_session_detected_at": now,
                "orphaned_session_remediation_by": controller_id,
                "orphaned_session_remediation_action": action,
                "orphaned_session_remediation_reason": remediation_reason,
                "orphaned_session_remediation_count": remediation_count,
                "orphaned_session_previous_status": current_status,
            }
            if age_minutes is not None:
                update_payload["orphaned_session_age_minutes"] = round(age_minutes, 1)

            if action == "requeue":
                update_payload.update(
                    {
                        "status": "queued",
                        "claimed_at": None,
                        "claim_expires_at": None,
                        "claimed_by": None,
                    }
                )
            else:
                update_payload.update({"status": "failed", "processed_at": now})

            txn.update(session_ref, update_payload)
            return True

        try:
            remediated = bool(_txn(transaction))
            if remediated:
                logger.warning(
                    "SESSION_ORPHANED_REMEDIATED: session_id=%s, org_id=%s, "
                    "previous_status=%s, new_status=%s, action=%s, age_minutes=%s, reason=%s",
                    session_id[:16],
                    org_id,
                    previous_status,
                    "queued" if action == "requeue" else "failed",
                    action,
                    f"{age_minutes:.1f}" if age_minutes is not None else "unknown",
                    remediation_reason,
                )
            return remediated
        except Exception as e:
            logger.error(
                "SESSION_ORPHANED_REMEDIATION_FAILED: session_id=%s, org_id=%s, "
                "action=%s, error=%s",
                session_id[:16],
                org_id,
                action,
                e,
                exc_info=True,
            )
            return False

    def _validate_claimed_sessions_have_jobs(self) -> None:
        """
        Validate that sessions in 'claimed' or 'processing' status have corresponding K8s jobs.

        This helps detect orphaned sessions where job creation failed silently
        or the job was deleted but the session wasn't updated.
        """
        try:
            if not self.batch_v1:
                logger.debug("SESSION_VALIDATION_SKIPPED: reason=batch_v1_unavailable")
                return

            q = (
                self.db.collection_group("meeting_sessions")
                .where(
                    field_path="status", op_string="in", value=["claimed", "processing"]
                )
                .limit(self.orphaned_session_validation_limit)
            )
            claimed_sessions = sorted(list(q.stream()), key=lambda session: session.id)

            if not claimed_sessions:
                return

            try:
                jobs = self.batch_v1.list_namespaced_job(
                    namespace=self.k8s_namespace,
                    label_selector="app=meeting-bot",
                )
            except Exception as e:
                logger.warning("Failed to list K8s jobs for validation: %s", e)
                return

            active_job_names: Set[str] = set()
            active_hash_pairs: Set[Tuple[str, str]] = set()
            for job in jobs.items:
                if self._is_job_terminal(job):
                    continue
                job_name = getattr(getattr(job, "metadata", None), "name", "")
                if job_name:
                    active_job_names.add(job_name)

                labels = getattr(getattr(job, "metadata", None), "labels", {}) or {}
                org_hash = labels.get("org_id_hash")
                url_hash = labels.get("meeting_url_hash")
                if org_hash and url_hash:
                    active_hash_pairs.add((org_hash, url_hash))

            orphaned_count = 0
            remediated_count = 0
            remediation_budget = self.orphaned_session_remediation_max_per_cycle

            for session in claimed_sessions:
                session_data = session.to_dict() or {}
                session_id = session.id
                org_id = session_data.get("org_id", "unknown")
                meeting_url = session_data.get("meeting_url", "")
                status = session_data.get("status", "unknown")
                age_minutes = self._session_age_minutes(session_data)

                has_job = False
                if org_id != "unknown" and meeting_url:
                    org_hash = self._org_id_hash(org_id)
                    url_hash = self._meeting_url_hash(meeting_url)
                    has_job = (org_hash, url_hash) in active_hash_pairs

                    # Legacy fallback while old jobs migrate to hashed org labels.
                    if not has_job and org_hash != "no-org":
                        has_job = ("no-org", url_hash) in active_hash_pairs

                if not has_job:
                    # Legacy fallback: older jobs can only be correlated by name.
                    has_job = any(
                        session_id[:8] in job_name for job_name in active_job_names
                    )

                if has_job:
                    continue

                orphaned_count += 1
                remediation_action = self.orphaned_session_remediation_action
                remediation_reason = "missing_k8s_job"
                try:
                    is_past_session, past_reason = self._is_session_past(
                        session_data, session_ref=session.reference
                    )
                    if is_past_session:
                        remediation_action = "failed"
                        suffix = past_reason or "timing_threshold"
                        remediation_reason = f"stale_session_{suffix}"
                        logger.info(
                            "SESSION_ORPHANED_STALE: session_id=%s, org_id=%s, reason=%s",
                            session_id[:16],
                            org_id,
                            remediation_reason,
                        )
                except Exception as past_check_error:
                    remediation_action = "failed"
                    remediation_reason = "session_past_check_failed"
                    logger.error(
                        "SESSION_PAST_CHECK_FAILED: session_id=%s, org_id=%s, error=%s",
                        session_id[:16],
                        org_id,
                        past_check_error,
                        exc_info=True,
                    )

                logger.warning(
                    "SESSION_ORPHANED: session_id=%s, org_id=%s, status=%s, "
                    "age_minutes=%s, has_k8s_job=false",
                    session_id[:16],
                    org_id,
                    status,
                    f"{age_minutes:.1f}" if age_minutes is not None else "unknown",
                )
                logger.warning(
                    "LLM_CONTEXT: Session %s is in '%s' status but has no "
                    "corresponding K8s job. This session may be stuck. "
                    "Possible causes: job creation failed, job was deleted, "
                    "or job completed but didn't update session status.",
                    session_id[:16],
                    status,
                )

                if not self.orphaned_session_remediation_enabled:
                    continue

                if remediation_budget <= 0:
                    logger.info(
                        "SESSION_ORPHANED_REMEDIATION_SKIPPED: session_id=%s, "
                        "org_id=%s, reason=cycle_budget_exhausted",
                        session_id[:16],
                        org_id,
                    )
                    continue

                if age_minutes is None:
                    logger.info(
                        "SESSION_ORPHANED_REMEDIATION_SKIPPED: session_id=%s, "
                        "org_id=%s, reason=age_unknown",
                        session_id[:16],
                        org_id,
                    )
                    continue

                if age_minutes < self.orphaned_session_remediation_min_age_minutes:
                    logger.info(
                        "SESSION_ORPHANED_REMEDIATION_SKIPPED: session_id=%s, "
                        "org_id=%s, reason=below_age_threshold, age_minutes=%.1f, "
                        "required_age_minutes=%d",
                        session_id[:16],
                        org_id,
                        age_minutes,
                        self.orphaned_session_remediation_min_age_minutes,
                    )
                    continue

                if self._remediate_orphaned_session(
                    session.reference,
                    session_id=session_id,
                    org_id=org_id,
                    previous_status=status,
                    age_minutes=age_minutes,
                    action_override=remediation_action,
                    remediation_reason=remediation_reason,
                ):
                    remediated_count += 1
                    remediation_budget -= 1

            if orphaned_count > 0:
                logger.warning(
                    "SESSION_VALIDATION_SUMMARY: total_claimed=%d, orphaned=%d, "
                    "remediated=%d, remediation_enabled=%s, remediation_action=%s",
                    len(claimed_sessions),
                    orphaned_count,
                    remediated_count,
                    self.orphaned_session_remediation_enabled,
                    self.orphaned_session_remediation_action,
                )

        except Exception as e:
            logger.error("Session validation check failed: %s", e, exc_info=True)

    # --- Attendee-based fanout helpers ---

    def _get_user_id_by_email(self, email: str) -> Optional[str]:
        """Look up a user_id by email address from the users collection.

        Returns the user_id if found, None otherwise.
        """
        if not email:
            return None

        email_lower = email.lower().strip()

        try:
            # Query users collection by email
            users_ref = self.db.collection("users")
            matches = list(
                users_ref.where(field_path="email", op_string="==", value=email_lower)
                .limit(1)
                .stream()
            )

            if matches:
                return matches[0].id

            # Try case-insensitive match (email might be stored with different case)
            # Check a few common variations
            for email_variant in [email, email.lower(), email.upper()]:
                matches = list(
                    users_ref.where(
                        field_path="email", op_string="==", value=email_variant
                    )
                    .limit(1)
                    .stream()
                )
                if matches:
                    return matches[0].id

        except Exception as e:
            logger.warning("Failed to look up user by email %s: %s", email, e)

        return None

    def _get_org_user_ids_for_attendees(
        self, org_id: str, attendee_emails: List[str]
    ) -> Dict[str, str]:
        """Map attendee emails to user_ids for users in the organization.

        Args:
            org_id: Organization ID
            attendee_emails: List of email addresses from meeting attendees

        Returns:
            Dict mapping email -> user_id for attendees who are org members
        """
        email_to_user_id: Dict[str, str] = {}

        for email in attendee_emails:
            if not email:
                continue

            email_lower = email.lower().strip()
            user_id = self._get_user_id_by_email(email_lower)

            if user_id:
                # Verify user is part of this organization
                # Check if user has any meetings in this org
                org_meetings = list(
                    self.db.collection(f"organizations/{org_id}/meetings")
                    .where(field_path="user_id", op_string="==", value=user_id)
                    .limit(1)
                    .stream()
                )

                if org_meetings:
                    email_to_user_id[email_lower] = user_id
                    logger.debug(
                        "ATTENDEE_LOOKUP: email=%s -> user_id=%s (org member)",
                        email_lower,
                        user_id,
                    )
                else:
                    logger.debug(
                        "ATTENDEE_LOOKUP: email=%s -> user_id=%s (not in org %s)",
                        email_lower,
                        user_id,
                        org_id,
                    )
            else:
                logger.debug(
                    "ATTENDEE_LOOKUP: email=%s -> not found in users collection",
                    email_lower,
                )

        return email_to_user_id

    def _get_fresh_meeting_attendees(self, org_id: str, meeting_id: str) -> List[str]:
        """Re-read meeting document to get the latest attendees list.

        Args:
            org_id: Organization ID
            meeting_id: Meeting document ID

        Returns:
            List of attendee email addresses
        """
        try:
            meeting_ref = self.db.document(
                f"organizations/{org_id}/meetings/{meeting_id}"
            )
            meeting_snap = meeting_ref.get()

            if not meeting_snap.exists:
                logger.warning(
                    "FRESH_ATTENDEES: Meeting %s not found in org %s",
                    meeting_id,
                    org_id,
                )
                return []

            data = meeting_snap.to_dict() or {}
            attendees = data.get("attendees", [])

            # Normalize attendee format (could be strings or dicts)
            emails = []
            for attendee in attendees:
                if isinstance(attendee, str):
                    emails.append(attendee.lower().strip())
                elif isinstance(attendee, dict):
                    email = attendee.get("email", "")
                    if email:
                        emails.append(email.lower().strip())

            logger.info(
                "FRESH_ATTENDEES: meeting_id=%s, attendee_count=%d, emails=%s",
                meeting_id,
                len(emails),
                emails,
            )
            return emails

        except Exception as e:
            logger.warning(
                "FRESH_ATTENDEES: Failed to read meeting %s: %s", meeting_id, e
            )
            return []

    def _ensure_subscriber_for_attendee(
        self,
        *,
        org_id: str,
        session_id: str,
        session_ref: firestore.DocumentReference,
        user_id: str,
        email: str,
        source_meeting_id: str,
        source_meeting_data: Dict[str, Any],
    ) -> Optional[str]:
        """Ensure an attendee has a meeting doc and is subscribed to the session.

        If the attendee doesn't have a meeting document for this session,
        create one based on the source meeting.

        Args:
            org_id: Organization ID
            session_id: Session ID
            session_ref: Session document reference
            user_id: User ID of the attendee
            email: Email of the attendee
            source_meeting_id: ID of the source meeting to copy from
            source_meeting_data: Data from the source meeting

        Returns:
            The meeting ID for this attendee (existing or newly created)
        """
        # Check if already subscribed
        subscriber_ref = session_ref.collection("subscribers").document(user_id)
        sub_snap = subscriber_ref.get()

        if sub_snap.exists:
            sub_data = sub_snap.to_dict() or {}
            existing_meeting_id = sub_data.get("fs_meeting_id")
            logger.debug(
                "ATTENDEE_SUBSCRIBER: user_id=%s already subscribed, meeting_id=%s",
                user_id,
                existing_meeting_id,
            )
            return existing_meeting_id

        # Check if user has an existing meeting doc for this session
        existing_meetings = list(
            self.db.collection(f"organizations/{org_id}/meetings")
            .where(field_path="user_id", op_string="==", value=user_id)
            .where(field_path="meeting_session_id", op_string="==", value=session_id)
            .limit(1)
            .stream()
        )

        if existing_meetings:
            meeting_id = existing_meetings[0].id
            meeting_path = existing_meetings[0].reference.path
        else:
            # Create a new meeting document for this attendee
            meeting_id = self._create_meeting_for_attendee(
                org_id=org_id,
                session_id=session_id,
                user_id=user_id,
                email=email,
                source_meeting_data=source_meeting_data,
            )
            meeting_path = f"organizations/{org_id}/meetings/{meeting_id}"

        if not meeting_id:
            logger.warning(
                "ATTENDEE_SUBSCRIBER: Failed to get/create meeting for user %s",
                user_id,
            )
            return None

        # Add as subscriber
        now = datetime.now(timezone.utc)
        subscriber_ref.set(
            {
                "user_id": user_id,
                "fs_meeting_id": meeting_id,
                "meeting_path": meeting_path,
                "status": "requested",
                "requested_at": now,
                "updated_at": now,
                "added_via": "attendee_fanout",
                "email": email,
            }
        )

        logger.info(
            "ATTENDEE_SUBSCRIBER: Added user_id=%s as subscriber, meeting_id=%s",
            user_id,
            meeting_id,
        )
        return meeting_id

    def _create_meeting_for_attendee(
        self,
        *,
        org_id: str,
        session_id: str,
        user_id: str,
        email: str,
        source_meeting_data: Dict[str, Any],
    ) -> Optional[str]:
        """Create a meeting document for an attendee based on the source meeting.

        Args:
            org_id: Organization ID
            session_id: Session ID
            user_id: User ID for the new meeting
            email: Email of the attendee
            source_meeting_data: Data from the source meeting to copy

        Returns:
            The new meeting document ID, or None on failure
        """
        try:
            now = datetime.now(timezone.utc)

            # Copy relevant fields from source meeting
            new_meeting_data = {
                "title": source_meeting_data.get("title", "Shared Meeting"),
                "start": source_meeting_data.get("start"),
                "end": source_meeting_data.get("end"),
                "platform": source_meeting_data.get("platform"),
                "join_url": source_meeting_data.get("join_url"),
                "teams_url": source_meeting_data.get("teams_url"),
                "attendees": source_meeting_data.get("attendees", []),
                # Set user-specific fields
                "user_id": user_id,
                "synced_by_user_id": user_id,
                "organization_id": org_id,
                # Mark as created via fanout
                "source": "attendee_fanout",
                "created_from_meeting": source_meeting_data.get("id"),
                "meeting_session_id": session_id,
                "session_status": "complete",
                # Timestamps
                "created_at": now,
                "updated_at": now,
                "status": "completed",
            }

            # Create the document
            meetings_ref = self.db.collection(f"organizations/{org_id}/meetings")
            new_doc_ref = meetings_ref.document()
            new_doc_ref.set(new_meeting_data)

            logger.info(
                "ATTENDEE_MEETING_CREATED: meeting_id=%s, user_id=%s, email=%s",
                new_doc_ref.id,
                user_id,
                email,
            )
            return new_doc_ref.id

        except Exception as e:
            logger.error(
                "ATTENDEE_MEETING_CREATE_FAILED: user_id=%s, error=%s",
                user_id,
                e,
            )
            return None

    def _validate_fanout_results(
        self,
        *,
        org_id: str,
        session_id: str,
        expected_artifact_keys: List[str],
    ) -> Dict[str, Any]:
        """Validate that all subscribers received all expected files.

        Args:
            org_id: Organization ID
            session_id: Session ID
            expected_artifact_keys: List of artifact keys that should exist

        Returns:
            Validation result dict with success status and any errors
        """
        session_ref = self._meeting_session_ref(org_id=org_id, session_id=session_id)
        subs = list(session_ref.collection("subscribers").stream())

        validation_result = {
            "success": True,
            "total_subscribers": len(subs),
            "validated": 0,
            "errors": [],
        }

        for sub in subs:
            sub_data = sub.to_dict() or {}
            user_id = sub_data.get("user_id") or sub.id
            meeting_id = sub_data.get("fs_meeting_id")
            meeting_path = sub_data.get("meeting_path")

            if not meeting_id:
                validation_result["errors"].append(
                    f"Subscriber {user_id} has no meeting_id"
                )
                validation_result["success"] = False
                continue

            # Check meeting document exists and has expected fields
            try:
                if meeting_path:
                    meeting_ref = self.db.document(meeting_path)
                else:
                    meeting_ref = self.db.document(
                        f"organizations/{org_id}/meetings/{meeting_id}"
                    )

                meeting_snap = meeting_ref.get()
                if not meeting_snap.exists:
                    validation_result["errors"].append(
                        f"Meeting {meeting_id} for user {user_id} does not exist"
                    )
                    validation_result["success"] = False
                    continue

                meeting_data = meeting_snap.to_dict() or {}

                # Check transcription
                if not meeting_data.get("transcription"):
                    validation_result["errors"].append(
                        f"User {user_id} missing transcription"
                    )
                    validation_result["success"] = False

                # Check artifacts
                artifacts = meeting_data.get("artifacts", {})
                for key in expected_artifact_keys:
                    if key not in artifacts:
                        validation_result["errors"].append(
                            f"User {user_id} missing artifact: {key}"
                        )
                        validation_result["success"] = False

                # Verify GCS files exist for this subscriber
                dst_prefix = f"recordings/{user_id}/{meeting_id}"
                gcs_objects = self._list_gcs_prefix(dst_prefix + "/")
                if len(gcs_objects) < len(expected_artifact_keys):
                    validation_result["errors"].append(
                        f"User {user_id} has {len(gcs_objects)} GCS files, "
                        f"expected at least {len(expected_artifact_keys)}"
                    )
                    validation_result["success"] = False

                validation_result["validated"] += 1

            except Exception as e:
                validation_result["errors"].append(
                    f"Validation error for user {user_id}: {e}"
                )
                validation_result["success"] = False

        # Log validation result
        if validation_result["success"]:
            logger.info(
                "FANOUT_VALIDATION: session_id=%s, status=SUCCESS, "
                "validated=%d/%d subscribers",
                session_id[:16],
                validation_result["validated"],
                validation_result["total_subscribers"],
            )
        else:
            logger.warning(
                "FANOUT_VALIDATION: session_id=%s, status=FAILED, "
                "validated=%d/%d, errors=%s",
                session_id[:16],
                validation_result["validated"],
                validation_result["total_subscribers"],
                validation_result["errors"],
            )

        return validation_result

    def _query_completed_sessions_needing_fanout(
        self,
    ) -> List[firestore.DocumentSnapshot]:
        """Find completed sessions where fan-out hasn't succeeded yet."""

        q = (
            self.db.collection_group("meeting_sessions")
            .where(field_path="status", op_string="==", value="complete")
            .limit(self.max_claim_per_poll)
        )
        results = list(q.stream())

        # Firestore has limited support for != queries without indexes; filter in memory.
        pending: List[firestore.DocumentSnapshot] = []
        for snap in results:
            data = snap.to_dict() or {}
            if data.get("fanout_status") != "complete":
                pending.append(snap)

        logger.debug(
            "Query meeting_sessions status='complete' (fanout pending): found %d docs",
            len(pending),
        )
        return pending

    def _try_claim_meeting_session(
        self, session_ref: firestore.DocumentReference
    ) -> bool:
        claim_expires_at_field = "claim_expires_at"
        claimed_by_field = "claimed_by"
        claimed_at_field = "claimed_at"
        status_field = "status"
        queued_value = "queued"
        processing_value = "processing"

        controller_id = (
            os.getenv("CONTROLLER_ID") or os.getenv("HOSTNAME") or "controller"
        )
        now = datetime.now(timezone.utc)
        expires = datetime.fromtimestamp(
            now.timestamp() + self.claim_ttl_seconds, tz=timezone.utc
        )

        transaction = self.db.transaction()

        @firestore.transactional
        def _txn(txn: firestore.Transaction) -> bool:
            snap = session_ref.get(transaction=txn)
            if not snap.exists:
                return False

            data = snap.to_dict() or {}
            if data.get(status_field) != queued_value:
                return False

            existing_exp = data.get(claim_expires_at_field)
            if existing_exp is not None:
                try:
                    exp_dt = (
                        existing_exp.replace(tzinfo=timezone.utc)
                        if getattr(existing_exp, "tzinfo", None) is None
                        else existing_exp
                    )
                except Exception:
                    exp_dt = None
                if exp_dt and exp_dt > now:
                    return False

            txn.update(
                session_ref,
                {
                    claimed_by_field: controller_id,
                    claimed_at_field: now,
                    claim_expires_at_field: expires,
                    status_field: processing_value,
                    "updated_at": now,
                },
            )
            return True

        return bool(_txn(transaction))

    def _mark_meeting_session_done(
        self, session_ref: firestore.DocumentReference, ok: bool
    ) -> None:
        session_ref.update(
            {
                "status": "complete" if ok else "failed",
                "processed_at": datetime.now(timezone.utc),
                "updated_at": datetime.now(timezone.utc),
            }
        )

    def _list_gcs_prefix(self, prefix: str) -> List[str]:
        """List object names under a prefix."""
        clean_prefix = (prefix or "").lstrip("/")
        blobs = self.gcs_client.list_blobs(self.gcs_bucket, prefix=clean_prefix)
        return [b.name for b in blobs]

    def _gcs_blob_exists(self, name: str) -> bool:
        blob = self.gcs_bucket_client.blob(name.lstrip("/"))
        return bool(blob.exists())

    def _copy_gcs_blob(self, *, src: str, dst: str) -> None:
        src_name = src.lstrip("/")
        dst_name = dst.lstrip("/")
        src_blob = self.gcs_bucket_client.blob(src_name)
        self.gcs_bucket_client.copy_blob(
            src_blob,
            self.gcs_bucket_client,
            new_name=dst_name,
        )

    def _fanout_meeting_session_artifacts(
        self, *, org_id: str, session_id: str
    ) -> None:
        """Copy session artifacts from the first subscriber to additional subscribers.

        This is best-effort and idempotent: it skips objects that already exist.
        The first subscriber's files are the canonical source.
        """

        logger.debug("=" * 80)
        logger.debug("FANOUT LOGIC - ARTIFACT DISTRIBUTION")
        logger.debug("=" * 80)
        logger.debug("Organization ID: %s", org_id)
        logger.debug("Session ID: %s", session_id)

        try:
            session_ref = self._meeting_session_ref(
                org_id=org_id, session_id=session_id
            )
            session_snap = session_ref.get()
            if not session_snap.exists:
                logger.debug("Session document does not exist, aborting fanout")
                return

            logger.debug(
                "Session data: %s",
                json.dumps(session_snap.to_dict() or {}, indent=2, default=str),
            )

            # Get all subscribers
            subs = list(session_ref.collection("subscribers").stream())
            logger.debug("Total subscribers found: %d", len(subs))

            # Enhanced logging for fanout start - list each subscriber with details
            logger.info(
                "FANOUT_STARTING: session_id=%s, org_id=%s, subscriber_count=%d",
                session_id[:16],
                org_id,
                len(subs),
            )

            for idx, sub in enumerate(subs):
                sub_data = sub.to_dict() or {}
                user_id = sub_data.get("user_id") or sub.id
                fs_meeting_id = sub_data.get("fs_meeting_id", "N/A")
                email = sub_data.get("email", "N/A")
                status = sub_data.get("status", "unknown")
                target_path = f"recordings/{user_id}/{fs_meeting_id}/"
                logger.info(
                    "FANOUT_SUBSCRIBER_LIST: [%d/%d] user_id=%s, email=%s, "
                    "fs_meeting_id=%s, status=%s, target_path=%s",
                    idx + 1,
                    len(subs),
                    user_id,
                    email,
                    fs_meeting_id,
                    status,
                    target_path,
                )
                logger.debug(
                    "Subscriber %d full data: %s",
                    idx + 1,
                    json.dumps(sub_data, indent=2, default=str),
                )

            if len(subs) == 0:
                logger.info("No subscribers found for session %s", session_id)
                return

            # First subscriber is the source
            first_sub = subs[0]
            first_sub_data = first_sub.to_dict() or {}
            source_user_id = first_sub_data.get("user_id") or first_sub.id
            source_meeting_id = first_sub_data.get("fs_meeting_id")

            logger.debug("=" * 80)
            logger.debug("FANOUT SOURCE")
            logger.debug("Source User ID: %s", source_user_id)
            logger.debug("Source Meeting ID: %s", source_meeting_id)
            logger.debug("=" * 80)

            if not source_user_id or not source_meeting_id:
                logger.error(
                    "First subscriber for session %s missing user_id or fs_meeting_id",
                    session_id,
                )
                logger.debug("Cannot proceed with fanout - missing source information")
                return

            source_prefix = f"recordings/{source_user_id}/{source_meeting_id}".rstrip(
                "/"
            )
            logger.debug(
                "Source GCS prefix: gs://%s/%s", self.gcs_bucket, source_prefix
            )

            # List source objects
            logger.debug("Listing source objects from GCS...")
            src_objects = self._list_gcs_prefix(source_prefix + "/")
            logger.debug("Found %d source objects", len(src_objects))

            for obj in src_objects:
                logger.debug("  - %s", obj)

            if not src_objects:
                logger.info(
                    "No artifacts found yet for session %s (%s)",
                    session_id,
                    source_prefix,
                )
                return

            # Try to read transcription text from source location (if it exists)
            logger.debug("Attempting to read transcription from source...")
            transcription_text = None
            transcription_metadata = None
            transcript_txt_path = f"{source_prefix}/transcript.txt"
            try:
                transcript_blob = self.gcs_bucket_client.blob(transcript_txt_path)
                if transcript_blob.exists():
                    transcription_text = transcript_blob.download_as_text()
                    logger.debug(
                        "Read transcription from %s (%d chars)",
                        transcript_txt_path,
                        len(transcription_text),
                    )
                else:
                    logger.debug(
                        "Transcription file does not exist: %s", transcript_txt_path
                    )
            except Exception as e:
                logger.warning(
                    "Could not read transcription from %s: %s", transcript_txt_path, e
                )

            transcript_json_path = f"{source_prefix}/transcript.json"
            try:
                transcript_json_blob = self.gcs_bucket_client.blob(transcript_json_path)
                if transcript_json_blob.exists():
                    transcript_payload = json.loads(
                        transcript_json_blob.download_as_text()
                    )
                    if isinstance(transcript_payload, dict):
                        metadata_candidate = transcript_payload.get(
                            "transcription_metadata"
                        )
                        if isinstance(metadata_candidate, dict):
                            transcription_metadata = metadata_candidate
                            logger.debug(
                                "Read transcription metadata from %s",
                                transcript_json_path,
                            )
            except (OSError, ValueError, TypeError) as e:
                logger.warning(
                    "Could not read transcription metadata from %s: %s",
                    transcript_json_path,
                    e,
                )

            # Get session artifacts to copy to meeting documents
            session_data = session_snap.to_dict() or {}
            session_artifacts = session_data.get("artifacts", {})
            logger.debug(
                "Session artifacts to distribute: %s", list(session_artifacts.keys())
            )

            # === ATTENDEE-BASED FANOUT ===
            # Re-read the source meeting to get the latest attendees list
            # and add any org members as subscribers
            logger.debug("=" * 80)
            logger.debug("ATTENDEE-BASED FANOUT - Checking for additional org members")
            logger.debug("=" * 80)

            source_meeting_data = {}
            first_meeting_path = first_sub_data.get("meeting_path")
            if first_meeting_path:
                try:
                    source_meeting_ref = self.db.document(first_meeting_path)
                    source_meeting_snap = source_meeting_ref.get()
                    if source_meeting_snap.exists:
                        source_meeting_data = source_meeting_snap.to_dict() or {}
                        source_meeting_data["id"] = source_meeting_snap.id
                except Exception as e:
                    logger.warning(
                        "Failed to read source meeting %s: %s", first_meeting_path, e
                    )

            if not transcription_metadata:
                metadata_candidate = source_meeting_data.get("transcription_metadata")
                if isinstance(metadata_candidate, dict):
                    transcription_metadata = metadata_candidate

            # Get fresh attendees list from the source meeting
            attendee_emails = self._get_fresh_meeting_attendees(
                org_id, source_meeting_id
            )

            if attendee_emails:
                # Map attendee emails to org user_ids
                email_to_user_id = self._get_org_user_ids_for_attendees(
                    org_id, attendee_emails
                )

                logger.info(
                    "ATTENDEE_FANOUT: Found %d attendees, %d are org members",
                    len(attendee_emails),
                    len(email_to_user_id),
                )

                # Add each org member as a subscriber if not already
                for email, user_id in email_to_user_id.items():
                    # Skip if this is the source user
                    if user_id == source_user_id:
                        logger.debug(
                            "ATTENDEE_FANOUT: Skipping source user %s", user_id
                        )
                        continue

                    # Ensure subscriber exists (creates meeting doc if needed)
                    self._ensure_subscriber_for_attendee(
                        org_id=org_id,
                        session_id=session_id,
                        session_ref=session_ref,
                        user_id=user_id,
                        email=email,
                        source_meeting_id=source_meeting_id,
                        source_meeting_data=source_meeting_data,
                    )

                # Refresh subscriber list after adding attendees
                subs = list(session_ref.collection("subscribers").stream())
                logger.info(
                    "ATTENDEE_FANOUT: Subscriber count after attendee check: %d",
                    len(subs),
                )
            else:
                logger.debug("ATTENDEE_FANOUT: No attendees found in source meeting")

            # === END ATTENDEE-BASED FANOUT ===

            # Update the first subscriber's meeting with transcription and artifacts
            logger.debug("Updating first subscriber's meeting document...")
            logger.debug("First subscriber meeting path: %s", first_meeting_path)

            if first_meeting_path:
                logger.debug(
                    "Updating meeting %s with transcription, recording URL, and artifacts",
                    first_meeting_path,
                )
                try:
                    meeting_ref = self.db.document(first_meeting_path)
                    first_meeting_update = {
                        "recording_url": f"gs://{self.gcs_bucket}/{source_prefix}/recording.webm",
                        "updated_at": datetime.now(timezone.utc),
                        "recording_available": True,
                        "recording_status": "complete",
                    }

                    # Add transcription if available
                    if transcription_text:
                        first_meeting_update["transcription"] = transcription_text
                    if transcription_metadata:
                        first_meeting_update["transcription_metadata"] = (
                            transcription_metadata
                        )

                    # Add artifacts (first subscriber uses original paths)
                    if session_artifacts:
                        first_meeting_update["artifacts"] = session_artifacts
                        logger.debug(
                            "Added %d artifacts to first subscriber",
                            len(session_artifacts),
                        )

                    meeting_ref.set(first_meeting_update, merge=True)
                    logger.debug(
                        "Updated first subscriber meeting doc %s with transcription and artifacts",
                        first_meeting_path,
                    )
                    logger.debug(
                        "FANOUT RECIPIENT UPDATE: First subscriber %s received transcription",
                        source_user_id,
                    )
                except Exception as e:
                    logger.warning(
                        "Failed to update first subscriber meeting document %s: %s",
                        first_meeting_path,
                        e,
                    )
            elif not first_meeting_path:
                logger.debug("No meeting path for first subscriber, skipping update")
            elif not transcription_text:
                logger.debug("No transcription available, skipping update")

            # Mark first subscriber as complete (no copying needed)
            logger.debug("Marking first subscriber as complete (source user)")
            first_sub.reference.set(
                {
                    "status": "complete",
                    "updated_at": datetime.now(timezone.utc),
                },
                merge=True,
            )
            logger.debug(
                "FANOUT RECIPIENT: First subscriber %s marked complete", source_user_id
            )

            # Copy to remaining subscribers (if any)
            logger.debug("=" * 80)
            logger.debug("COPYING TO ADDITIONAL SUBSCRIBERS")
            logger.debug("Additional subscribers to process: %d", len(subs) - 1)
            logger.debug("=" * 80)

            for sub in subs[1:]:
                sub_ref = sub.reference
                sub_data = sub.to_dict() or {}
                user_id = sub_data.get("user_id") or sub.id
                fs_meeting_id = sub_data.get("fs_meeting_id")
                meeting_path = sub_data.get("meeting_path")

                logger.debug("Processing additional subscriber:")
                logger.debug("  User ID: %s", user_id)
                logger.debug("  Meeting ID: %s", fs_meeting_id)
                logger.debug("  Meeting Path: %s", meeting_path)

                if not user_id or not fs_meeting_id:
                    logger.warning(
                        "Subscriber missing user_id or fs_meeting_id, skipping"
                    )
                    continue

                dst_prefix = f"recordings/{user_id}/{fs_meeting_id}".rstrip("/")
                logger.info(
                    "FANOUT_COPY_START: user_id=%s, source=%s, destination=%s",
                    user_id,
                    f"gs://{self.gcs_bucket}/{source_prefix}/",
                    f"gs://{self.gcs_bucket}/{dst_prefix}/",
                )

                # Skip if source and dest are the same
                if dst_prefix == source_prefix:
                    logger.info(
                        "FANOUT_COPY_SKIP: user_id=%s, reason=same_as_source", user_id
                    )
                    continue

                copied = 0
                skipped = 0

                for src in src_objects:
                    if not src.startswith(source_prefix + "/"):
                        continue
                    rel = src[len(source_prefix) + 1 :]
                    dst = f"{dst_prefix}/{rel}"
                    if self._gcs_blob_exists(dst):
                        skipped += 1
                        logger.info(
                            "FANOUT_FILE_SKIP: user_id=%s, file=%s, reason=already_exists",
                            user_id,
                            rel,
                        )
                        continue
                    logger.info(
                        "FANOUT_FILE_COPY: user_id=%s, file=%s, src=%s, dst=%s",
                        user_id,
                        rel,
                        src,
                        dst,
                    )
                    self._copy_gcs_blob(src=src, dst=dst)
                    copied += 1

                logger.info(
                    "FANOUT_COPY_COMPLETE: user_id=%s, files_copied=%d, files_skipped=%d, total=%d",
                    user_id,
                    copied,
                    skipped,
                    len(src_objects),
                )

                # Enhanced per-subscriber fanout logging
                logger.info(
                    "FANOUT_SUBSCRIBER: session_id=%s, user_id=%s, "
                    "files_copied=%d, files_skipped=%d, status=success",
                    session_id[:16],
                    user_id,
                    copied,
                    skipped,
                )

                sub_ref.set(
                    {
                        "status": "copied",
                        "copied_at": datetime.now(timezone.utc),
                        "copied_count": copied,
                        "skipped_count": skipped,
                        "total_count": len(src_objects),
                        "updated_at": datetime.now(timezone.utc),
                    },
                    merge=True,
                )

                # Update the meeting document with transcription, artifacts, and file links
                if meeting_path:
                    logger.debug("  Updating meeting document %s", meeting_path)
                    try:
                        meeting_ref = self.db.document(meeting_path)
                        meeting_update = {
                            "updated_at": datetime.now(timezone.utc),
                            "recording_url": f"gs://{self.gcs_bucket}/{dst_prefix}/recording.webm",
                            "recording_available": True,
                            "recording_status": "complete",
                        }

                        # Add transcription if available
                        if transcription_text:
                            meeting_update["transcription"] = transcription_text
                            logger.debug("  Added transcription to meeting update")
                        if transcription_metadata:
                            meeting_update["transcription_metadata"] = (
                                transcription_metadata
                            )

                        # Build artifacts dict with updated paths for this subscriber
                        if session_artifacts:
                            subscriber_artifacts = {}
                            for (
                                artifact_key,
                                artifact_path,
                            ) in session_artifacts.items():
                                # Replace source prefix with destination prefix
                                if source_prefix in artifact_path:
                                    new_path = artifact_path.replace(
                                        source_prefix, dst_prefix
                                    )
                                    subscriber_artifacts[artifact_key] = new_path
                                else:
                                    # Keep original if path doesn't match expected format
                                    subscriber_artifacts[artifact_key] = artifact_path
                            meeting_update["artifacts"] = subscriber_artifacts
                            logger.debug(
                                "  Added %d artifacts to subscriber meeting",
                                len(subscriber_artifacts),
                            )

                        meeting_ref.set(meeting_update, merge=True)
                        logger.debug(
                            "Updated meeting doc %s with transcription, artifacts, and file links",
                            meeting_path,
                        )
                        logger.debug(
                            "  FANOUT RECIPIENT UPDATE: User %s meeting updated with transcription and artifacts",
                            user_id,
                        )
                    except Exception as e:
                        logger.warning(
                            "Failed to update meeting document %s: %s", meeting_path, e
                        )
                else:
                    logger.debug(
                        "  No meeting path for subscriber, skipping meeting update"
                    )

            # === VALIDATION STEP ===
            # Verify all subscribers received their files
            logger.debug("=" * 80)
            logger.debug("VALIDATING FANOUT RESULTS")
            logger.debug("=" * 80)

            expected_artifact_keys = list(session_artifacts.keys())
            validation_result = self._validate_fanout_results(
                org_id=org_id,
                session_id=session_id,
                expected_artifact_keys=expected_artifact_keys,
            )

            # Store validation result on session
            fanout_status = "complete" if validation_result["success"] else "partial"

            logger.debug("=" * 80)
            logger.debug("Marking session fanout as %s", fanout_status)
            session_ref.set(
                {
                    "fanout_status": fanout_status,
                    "fanout_completed_at": datetime.now(timezone.utc),
                    "fanout_validation": validation_result,
                    "updated_at": datetime.now(timezone.utc),
                },
                merge=True,
            )

            # Enhanced logging for fanout completion
            logger.info(
                "FANOUT_COMPLETE: session_id=%s, org_id=%s, "
                "total_subscribers=%d, status=success",
                session_id[:16],
                org_id,
                len(subs),
            )
            logger.debug("=" * 80)
        except Exception as e:
            # Enhanced logging for fanout failure
            logger.error(
                "FANOUT_FAILED: session_id=%s, org_id=%s, error=%s",
                session_id[:16],
                org_id,
                str(e),
            )
            logger.error(
                "Fan-out failed for session %s: %s",
                session_id,
                e,
                exc_info=True,
            )
            logger.debug("=" * 80)
            try:
                self._meeting_session_ref(org_id=org_id, session_id=session_id).set(
                    {
                        "fanout_status": "failed",
                        "fanout_last_error": str(e),
                        "updated_at": datetime.now(timezone.utc),
                    },
                    merge=True,
                )
            except Exception:
                pass

    # --- NEW: URL-based fanout for K8s deduplication approach ---

    def _query_completed_meetings_needing_fanout(
        self,
    ) -> List[firestore.DocumentSnapshot]:
        """Find completed meetings where fanout hasn't succeeded yet.

        This queries meetings directly (not sessions) for the K8s-based
        deduplication approach. Looks for meetings with:
        - bot_status = "complete"
        - fanout_status != "complete"
        """
        results = []

        try:
            # Query all organizations for completed meetings
            orgs = self.db.collection("organizations").stream()
            for org_doc in orgs:
                org_id = org_doc.id
                meetings_ref = (
                    self.db.collection("organizations")
                    .document(org_id)
                    .collection("meetings")
                )

                # Query for bot_status = "complete"
                query = meetings_ref.where(
                    filter=firestore.FieldFilter("bot_status", "==", "complete")
                ).limit(self.max_claim_per_poll)

                for meeting_doc in query.stream():
                    data = meeting_doc.to_dict() or {}
                    # Filter for pending fanout
                    if data.get("fanout_status") != "complete":
                        results.append(meeting_doc)

                        if len(results) >= self.max_claim_per_poll:
                            break

                if len(results) >= self.max_claim_per_poll:
                    break

        except Exception as e:
            logger.warning("Failed to query completed meetings for fanout: %s", e)

        logger.debug(
            "Query meetings with bot_status='complete' (fanout pending): found %d docs",
            len(results),
        )
        return results

    def _fanout_completed_meeting_by_url(
        self, source_meeting_doc: firestore.DocumentSnapshot
    ) -> None:
        """Copy artifacts from source meeting to all meetings with same URL and time.

        This fanout approach finds meetings by matching:
        - Same join_url in the same organization
        - Same start and end times (within 5-minute tolerance)

        This handles cases where multiple users have the same calendar meeting
        (same URL, same scheduled time) and ensures all users get the recording.
        """
        data = source_meeting_doc.to_dict() or {}
        org_id = (
            data.get("organization_id")
            or data.get("organizationId")
            or data.get("teamId")
            or data.get("team_id")
        )
        meeting_url = data.get("join_url") or data.get("meeting_url")
        source_start = data.get("start")
        source_end = data.get("end")

        if not org_id or not meeting_url:
            logger.warning(
                "FANOUT_SKIPPED: meeting=%s, reason=missing_org_or_url",
                source_meeting_doc.id,
            )
            source_meeting_doc.reference.update(
                {
                    "fanout_status": "skipped",
                    "fanout_reason": "missing_org_id_or_meeting_url",
                    "updated_at": datetime.now(timezone.utc),
                }
            )
            return

        source_user_id = data.get("user_id") or data.get("synced_by_user_id")
        source_meeting_id = source_meeting_doc.id
        source_artifacts = data.get("artifacts", {})
        source_transcription = data.get("transcription")
        source_transcription_metadata = data.get("transcription_metadata")

        if not source_user_id:
            logger.warning(
                "FANOUT_SKIPPED: meeting=%s, reason=missing_user_id", source_meeting_id
            )
            source_meeting_doc.reference.update(
                {
                    "fanout_status": "skipped",
                    "fanout_reason": "missing_user_id",
                    "updated_at": datetime.now(timezone.utc),
                }
            )
            return

        logger.info(
            "FANOUT_BY_URL_START: source_meeting=%s, org=%s, url=%s, "
            "start=%s, end=%s, user=%s",
            source_meeting_id,
            org_id,
            meeting_url[:50] if meeting_url else "N/A",
            source_start,
            source_end,
            source_user_id,
        )

        # Find all meetings with same URL in this org
        meetings_ref = (
            self.db.collection("organizations").document(org_id).collection("meetings")
        )

        try:
            url_matching_meetings = list(
                meetings_ref.where(
                    filter=firestore.FieldFilter("join_url", "==", meeting_url)
                ).stream()
            )
        except Exception as e:
            logger.error(
                "FANOUT_FAILED: meeting=%s, error=query_failed: %s",
                source_meeting_id,
                e,
            )
            return

        logger.info(
            "FANOUT_URL_MATCHES: source=%s, url_match_count=%d",
            source_meeting_id,
            len(url_matching_meetings),
        )

        # Filter to meetings with matching start/end times (within tolerance)
        TIME_TOLERANCE_SECONDS = 300  # 5 minutes tolerance
        matching_meetings = []

        for meeting_doc in url_matching_meetings:
            meeting_data = meeting_doc.to_dict() or {}
            meeting_start = meeting_data.get("start")
            meeting_end = meeting_data.get("end")
            meeting_user_id = meeting_data.get("user_id") or meeting_data.get(
                "synced_by_user_id"
            )

            # Log each URL match for visibility
            logger.debug(
                "FANOUT_URL_MATCH: meeting=%s, user=%s, start=%s, end=%s",
                meeting_doc.id,
                meeting_user_id,
                meeting_start,
                meeting_end,
            )

            # If source has start/end, filter by time match
            if source_start and source_end and meeting_start and meeting_end:
                try:
                    # Convert to datetime if needed
                    src_start_dt = (
                        source_start
                        if isinstance(source_start, datetime)
                        else source_start
                    )
                    src_end_dt = (
                        source_end if isinstance(source_end, datetime) else source_end
                    )
                    mtg_start_dt = (
                        meeting_start
                        if isinstance(meeting_start, datetime)
                        else meeting_start
                    )
                    mtg_end_dt = (
                        meeting_end
                        if isinstance(meeting_end, datetime)
                        else meeting_end
                    )

                    # Check if times match within tolerance
                    start_diff = abs((src_start_dt - mtg_start_dt).total_seconds())
                    end_diff = abs((src_end_dt - mtg_end_dt).total_seconds())

                    if (
                        start_diff <= TIME_TOLERANCE_SECONDS
                        and end_diff <= TIME_TOLERANCE_SECONDS
                    ):
                        matching_meetings.append(meeting_doc)
                        logger.info(
                            "FANOUT_TIME_MATCH: meeting=%s, user=%s, "
                            "start_diff=%ds, end_diff=%ds",
                            meeting_doc.id,
                            meeting_user_id,
                            int(start_diff),
                            int(end_diff),
                        )
                    else:
                        logger.debug(
                            "FANOUT_TIME_MISMATCH: meeting=%s, user=%s, "
                            "start_diff=%ds, end_diff=%ds (tolerance=%ds)",
                            meeting_doc.id,
                            meeting_user_id,
                            int(start_diff),
                            int(end_diff),
                            TIME_TOLERANCE_SECONDS,
                        )
                except Exception as e:
                    # If time comparison fails, include meeting anyway
                    logger.debug(
                        "FANOUT_TIME_CHECK_ERROR: meeting=%s, error=%s, including anyway",
                        meeting_doc.id,
                        e,
                    )
                    matching_meetings.append(meeting_doc)
            else:
                # No time info available - include all URL matches
                matching_meetings.append(meeting_doc)
                logger.debug(
                    "FANOUT_NO_TIME_INFO: meeting=%s, including by URL only",
                    meeting_doc.id,
                )

        logger.info(
            "FANOUT_FINAL_MATCHES: source=%s, url_matches=%d, time_matches=%d",
            source_meeting_id,
            len(url_matching_meetings),
            len(matching_meetings),
        )

        source_prefix = f"recordings/{source_user_id}/{source_meeting_id}".rstrip("/")
        copied_count = 0
        skipped_count = 0

        # List source files once for all copies
        try:
            src_objects = self._list_gcs_prefix(source_prefix + "/")
            logger.info(
                "FANOUT_SOURCE_FILES: source=%s, file_count=%d, prefix=%s",
                source_meeting_id,
                len(src_objects),
                source_prefix,
            )
            for obj in src_objects:
                logger.debug("  - %s", obj)
        except Exception as e:
            logger.error(
                "FANOUT_FAILED: meeting=%s, error=list_source_files: %s",
                source_meeting_id,
                e,
            )
            return

        for meeting_doc in matching_meetings:
            if meeting_doc.id == source_meeting_id:
                continue  # Skip source meeting

            meeting_data = meeting_doc.to_dict() or {}
            dst_user_id = meeting_data.get("user_id") or meeting_data.get(
                "synced_by_user_id"
            )
            dst_meeting_id = meeting_doc.id

            if not dst_user_id:
                logger.info(
                    "FANOUT_SKIP: meeting=%s, reason=no_user_id", dst_meeting_id
                )
                skipped_count += 1
                continue

            # Skip if already copied
            if meeting_data.get("fanout_status") == "copied":
                logger.info(
                    "FANOUT_SKIP: meeting=%s, user=%s, reason=already_copied",
                    dst_meeting_id,
                    dst_user_id,
                )
                skipped_count += 1
                continue

            dst_prefix = f"recordings/{dst_user_id}/{dst_meeting_id}".rstrip("/")

            logger.info(
                "FANOUT_COPY_START: user=%s, meeting=%s, "
                "src=gs://%s/%s/, dst=gs://%s/%s/",
                dst_user_id,
                dst_meeting_id,
                self.gcs_bucket,
                source_prefix,
                self.gcs_bucket,
                dst_prefix,
            )

            # Copy artifacts
            try:
                files_copied = 0

                for src in src_objects:
                    if not src.startswith(source_prefix + "/"):
                        continue
                    rel = src[len(source_prefix) + 1 :]
                    dst = f"{dst_prefix}/{rel}"

                    # Check if destination already exists
                    if self._gcs_blob_exists(dst):
                        logger.info(
                            "FANOUT_FILE_SKIP: user=%s, file=%s, reason=exists",
                            dst_user_id,
                            rel,
                        )
                        continue

                    try:
                        logger.info(
                            "FANOUT_FILE_COPY: user=%s, file=%s, src=%s, dst=%s",
                            dst_user_id,
                            rel,
                            src,
                            dst,
                        )
                        self._copy_gcs_blob(src=src, dst=dst)
                        files_copied += 1
                    except Exception as e:
                        logger.warning(
                            "FANOUT_FILE_ERROR: user=%s, file=%s, error=%s",
                            dst_user_id,
                            rel,
                            e,
                        )

                # Rewrite artifact paths for destination
                dst_artifacts = {}
                for key, path in source_artifacts.items():
                    if source_prefix in str(path):
                        dst_artifacts[key] = str(path).replace(
                            source_prefix, dst_prefix
                        )
                    else:
                        dst_artifacts[key] = path

                # Update destination meeting with artifacts and transcription
                update_data = {
                    "recording_url": f"gs://{self.gcs_bucket}/{dst_prefix}/recording.webm",
                    "fanout_status": "copied",
                    "fanout_source": source_meeting_id,
                    "fanout_at": datetime.now(timezone.utc),
                    "updated_at": datetime.now(timezone.utc),
                    "recording_available": True,
                    "recording_status": "complete",
                }

                if source_transcription:
                    update_data["transcription"] = source_transcription

                if isinstance(source_transcription_metadata, dict):
                    update_data["transcription_metadata"] = source_transcription_metadata

                if dst_artifacts:
                    update_data["artifacts"] = dst_artifacts

                meeting_doc.reference.update(update_data)

                logger.info(
                    "FANOUT_COPY_COMPLETE: user=%s, meeting=%s, files_copied=%d, "
                    "has_transcription=%s, artifact_count=%d",
                    dst_user_id,
                    dst_meeting_id,
                    files_copied,
                    bool(source_transcription),
                    len(dst_artifacts),
                )
                copied_count += 1

            except Exception as e:
                logger.error(
                    "FANOUT_COPY_FAILED: user=%s, meeting=%s, error=%s",
                    dst_user_id,
                    dst_meeting_id,
                    e,
                )
                skipped_count += 1

        # Mark source meeting fanout complete
        source_meeting_doc.reference.update(
            {
                "fanout_status": "complete",
                "fanout_copied_count": copied_count,
                "fanout_skipped_count": skipped_count,
                "fanout_completed_at": datetime.now(timezone.utc),
                "updated_at": datetime.now(timezone.utc),
            }
        )

        logger.info(
            "FANOUT_BY_URL_COMPLETE: source=%s, user=%s, copied=%d, skipped=%d",
            source_meeting_id,
            source_user_id,
            copied_count,
            skipped_count,
        )

    def _build_job_payload_from_meeting_session(
        self, session_doc: firestore.DocumentSnapshot
    ) -> Dict[str, Any]:
        data = session_doc.to_dict() or {}
        meeting_url = data.get("meeting_url")
        if not meeting_url:
            raise ValueError("meeting_session missing meeting_url")

        org_id = (data.get("org_id") or "").strip()
        occurrence_start_utc = data.get("occurrence_start_utc") or ""

        # Get the first subscriber to determine where to write files
        session_ref = session_doc.reference
        is_past_session, past_reason = self._is_session_past(
            data, session_ref=session_ref
        )
        if is_past_session:
            stale_reason = past_reason or "timing_threshold"
            raise ValueError(
                f"meeting_session {session_doc.id} is stale ({stale_reason})"
            )
        subscribers = list(session_ref.collection("subscribers").limit(1).stream())

        if not subscribers:
            raise ValueError(f"meeting_session {session_doc.id} has no subscribers")

        first_sub = subscribers[0]
        sub_data = first_sub.to_dict() or {}
        user_id = sub_data.get("user_id") or first_sub.id
        fs_meeting_id = sub_data.get("fs_meeting_id")

        if not user_id or not fs_meeting_id:
            raise ValueError(
                f"meeting_session {session_doc.id} subscriber missing user_id or fs_meeting_id"
            )

        # Write to the first subscriber's path
        gcs_path = f"recordings/{user_id}/{fs_meeting_id}"

        now = datetime.now(timezone.utc)

        payload: Dict[str, Any] = {
            "meeting_url": meeting_url,
            # meeting_id should be consistent hash for deduplication
            "meeting_id": self._meeting_session_id(
                org_id=org_id,
                meeting_url=meeting_url,
                occurrence_start_utc=occurrence_start_utc,
            ),
            "gcs_path": gcs_path,
            "fs_meeting_id": fs_meeting_id,
            "user_id": user_id,
            "teamId": org_id or session_doc.id,
            "org_id": org_id,  # Ensure org_id is always present for job naming
            "timezone": data.get("timezone") or "UTC",
            "initiated_at": data.get("initiated_at")
            or (now.isoformat().replace("+00:00", "Z")),
            "auto_joined": True,
            "meeting_session_id": session_doc.id,
            "occurrence_start_utc": occurrence_start_utc,
        }

        # Determine bot display name from org doc (same behavior as bot_instances path).
        bot_display_name = "AdviseWell"
        if org_id and getattr(self, "db", None) is not None:
            try:
                org_snap = self.db.collection("organizations").document(org_id).get()
                if org_snap.exists:
                    org_data = org_snap.to_dict() or {}
                    candidate = org_data.get("meeting_bot_name")
                    if isinstance(candidate, str) and candidate.strip():
                        bot_display_name = candidate.strip()
            except Exception:
                pass
        payload["name"] = bot_display_name

        return payload

    def _query_meetings_needing_bots(self) -> List[firestore.DocumentSnapshot]:
        """Discover meetings that need a bot instance created.

        This intentionally stays flexible because meeting schemas vary.

        Default behavior:
        - Read from flat `meetings` collection
        - Filter by status in MEETING_STATUS_VALUES (default: scheduled)
        - Require meeting_url
        - Skip if meeting already has bot_instance_id
        """

        logger.debug("=" * 80)
        logger.debug("SCHEDULED MEETING DISCOVERY")
        logger.debug("=" * 80)

        if self.meetings_query_mode == "collection_group":
            coll = self.db.collection_group(self.meetings_collection_path)
            logger.debug("Query mode: collection_group")
        else:
            coll = self.db.collection(self.meetings_collection_path)
            logger.debug("Query mode: collection")

        # Firestore doesn't support IN queries combined with some inequality
        # patterns consistently without composite indexes. Keep this simple:
        # if multiple statuses provided, just query the first one.
        status_value = (
            self.meeting_status_values[0] if self.meeting_status_values else "scheduled"
        )

        logger.debug(
            "Querying meetings: path=%s, status=%s",
            self.meetings_collection_path,
            status_value,
        )

        # Pagination loop to find meetings that actually need bots
        # (skipping those that already have bot_instance_id)
        candidates: List[firestore.DocumentSnapshot] = []
        last_doc = None
        page_size = 50  # Fetch larger batches to skip processed items efficiently
        max_scan = 500  # Safety limit to prevent infinite scanning

        scanned_count = 0

        logger.debug(
            "Starting pagination loop (max_scan=%d, page_size=%d)", max_scan, page_size
        )

        while len(candidates) < self.max_claim_per_poll and scanned_count < max_scan:
            q = coll.where(
                field_path=self.meeting_status_field,
                op_string="==",
                value=status_value,
            ).limit(page_size)

            if last_doc:
                q = q.start_after(last_doc)

            batch = list(q.stream())
            logger.debug("Fetched batch: %d documents", len(batch))

            if not batch:
                logger.debug("No more documents, ending pagination")
                break

            for doc in batch:
                scanned_count += 1
                last_doc = doc
                data = doc.to_dict() or {}

                logger.debug("Evaluating meeting %s:", doc.id)
                logger.debug(
                    "  Meeting data: %s", json.dumps(data, indent=2, default=str)
                )

                # Skip if already has bot instance
                if data.get(self.meeting_bot_instance_field):
                    logger.debug(
                        "  SKIP: Already has bot_instance_id=%s",
                        data.get(self.meeting_bot_instance_field),
                    )
                    continue

                # Skip if missing meeting_url (required to create bot)
                meeting_url = data.get("meeting_url") or data.get("meetingUrl")
                if not meeting_url:
                    logger.debug("  SKIP: Missing meeting_url")
                    continue

                logger.debug("  CANDIDATE: Meeting needs bot (url=%s)", meeting_url)
                candidates.append(doc)
                if len(candidates) >= self.max_claim_per_poll:
                    logger.debug(
                        "Reached max_claim_per_poll limit (%d)", self.max_claim_per_poll
                    )
                    break

            # If we got fewer docs than page_size, we reached the end
            if len(batch) < page_size:
                logger.debug("Fetched fewer than page_size, reached end of results")
                break

        if scanned_count >= max_scan:
            logger.warning(
                "Scanned %d meetings without finding enough candidates. "
                "Consider cleaning up old 'scheduled' meetings.",
                scanned_count,
            )

        logger.debug(
            "Discovery complete: scanned=%d, candidates=%d",
            scanned_count,
            len(candidates),
        )
        logger.debug("=" * 80)

        return candidates

    def _try_create_bot_instance_for_meeting(
        self,
        meeting_doc: firestore.DocumentSnapshot,
    ) -> Optional[str]:
        """Create a bot_instances document for a meeting (idempotent).

        Returns:
            bot_instance_id if created or already exists, else None.
        """

        meeting_data = meeting_doc.to_dict() or {}
        meeting_ref = meeting_doc.reference

        # Skip if meeting already linked.
        existing_bot_instance = meeting_data.get(self.meeting_bot_instance_field)
        if existing_bot_instance:
            return str(existing_bot_instance)

        meeting_url = (
            meeting_data.get("meeting_url")
            or meeting_data.get("meetingUrl")
            or meeting_data.get("join_url")
        )
        if not meeting_url:
            logger.warning(
                f"Meeting {meeting_doc.id} has no meeting_url, meetingUrl, "
                f"or join_url field. Available fields: {list(meeting_data.keys())}"
            )
            return None

        org_id = (
            meeting_data.get("organization_id")
            or meeting_data.get("organizationId")
            or meeting_data.get("teamId")
            or meeting_data.get("team_id")
            or ""
        )
        user_id = meeting_data.get("user_id") or meeting_data.get("userId") or ""

        now = datetime.now(timezone.utc)

        # Dedupe by meeting id: One bot instance per meeting doc.
        bot_ref = self.db.collection("bot_instances").document(meeting_doc.id)

        status_field = self.bot_instance_status_field
        queued_value = self.bot_instance_queued_value

        logger.debug(
            f"Creating bot_instance for meeting {meeting_doc.id}: "
            f"{status_field}={queued_value}"
        )

        transaction = self.db.transaction()

        @firestore.transactional
        def _txn(txn: firestore.Transaction) -> Optional[str]:
            fresh_meeting = meeting_ref.get(transaction=txn)
            if not fresh_meeting.exists:
                logger.warning(f"Meeting {meeting_doc.id} no longer exists")
                return None

            fresh_data = fresh_meeting.to_dict() or {}
            if fresh_data.get(self.meeting_bot_instance_field):
                logger.debug(
                    f"Meeting {meeting_doc.id} already has bot_instance: "
                    f"{fresh_data.get(self.meeting_bot_instance_field)}"
                )
                return str(fresh_data.get(self.meeting_bot_instance_field))

            bot_snap = bot_ref.get(transaction=txn)
            if bot_snap.exists:
                # Link meeting to existing bot instance.
                logger.debug(
                    f"Bot instance {bot_ref.id} already exists, linking to "
                    f"meeting {meeting_doc.id}"
                )
                txn.update(
                    meeting_ref,
                    {
                        self.meeting_bot_instance_field: bot_ref.id,
                        "bot_status": "queued",
                        "bot_enqueued_at": now,
                    },
                )
                return bot_ref.id

            # Create bot instance.
            logger.debug(f"Creating new bot_instance {bot_ref.id}")
            txn.set(
                bot_ref,
                {
                    status_field: queued_value,
                    "meeting_url": meeting_url,
                    "meeting_id": meeting_doc.id,
                    "creator_user_id": user_id,
                    "creator_organization_id": org_id,
                    "bot_name": meeting_data.get("bot_name")
                    or meeting_data.get("name")
                    or "Meeting Bot",
                    "created_at": now,
                    "initial_linked_meeting": {
                        "meeting_id": meeting_doc.id,
                        "organization_id": org_id,
                        "user_id": user_id,
                    },
                },
            )

            # Link meeting to bot instance.
            txn.update(
                meeting_ref,
                {
                    self.meeting_bot_instance_field: bot_ref.id,
                    "bot_status": "queued",
                    "bot_enqueued_at": now,
                },
            )

            logger.info(
                f"Created bot_instance {bot_ref.id} with {status_field}="
                f"{queued_value}"
            )
            return bot_ref.id

        try:
            result = _txn(transaction)
            if result:
                logger.debug(f"Transaction successful: bot_instance {result}")
            return result
        except Exception as e:
            logger.error(
                f"Failed to create bot_instance for meeting {meeting_doc.id}: " f"{e}",
                exc_info=True,
            )
            return None

    def _try_claim_bot_instance(self, bot_ref: firestore.DocumentReference) -> bool:
        """Attempt to claim a bot instance.

        We use a Firestore transaction to set claimed_* fields when the bot is still queued
        and either unclaimed or claim has expired.
        """

        claim_expires_at_field = "claim_expires_at"
        claimed_by_field = "claimed_by"
        claimed_at_field = "claimed_at"
        status_field = self.bot_instance_status_field
        queued_value = self.bot_instance_queued_value
        processing_value = os.getenv("BOT_INSTANCE_PROCESSING_VALUE", "processing")

        controller_id = (
            os.getenv("CONTROLLER_ID") or os.getenv("HOSTNAME") or "controller"
        )
        now = datetime.now(timezone.utc)
        expires = datetime.fromtimestamp(
            now.timestamp() + self.claim_ttl_seconds, tz=timezone.utc
        )

        transaction = self.db.transaction()

        @firestore.transactional
        def _txn(txn: firestore.Transaction) -> bool:
            snap = bot_ref.get(transaction=txn)
            if not snap.exists:
                return False

            data = snap.to_dict() or {}

            # Only claim queued items.
            if data.get(status_field) != queued_value:
                return False

            # Allow claim if unclaimed or expired.
            existing_exp = data.get(claim_expires_at_field)
            if existing_exp is not None:
                try:
                    exp_dt = (
                        existing_exp.replace(tzinfo=timezone.utc)
                        if getattr(existing_exp, "tzinfo", None) is None
                        else existing_exp
                    )
                except Exception:
                    exp_dt = None
                if exp_dt and exp_dt > now:
                    return False

            txn.update(
                bot_ref,
                {
                    claimed_by_field: controller_id,
                    claimed_at_field: now,
                    claim_expires_at_field: expires,
                    status_field: processing_value,
                },
            )
            return True

        return bool(_txn(transaction))

    def _mark_bot_instance_done(
        self, bot_ref: firestore.DocumentReference, ok: bool
    ) -> None:
        done_value = os.getenv("BOT_INSTANCE_DONE_VALUE", "done")
        failed_value = os.getenv("BOT_INSTANCE_FAILED_VALUE", "failed")
        status_field = self.bot_instance_status_field
        bot_ref.update(
            {
                status_field: done_value if ok else failed_value,
                "processed_at": datetime.now(timezone.utc),
            }
        )

    def _try_acquire_leadership(self) -> bool:
        """Try to acquire or renew leadership lease.

        Returns:
            True if this instance is the leader, False otherwise.
        """
        # Skip leader election for local development
        if self.skip_leader_election:
            if not self.is_leader:
                logger.info("👑 Skipping leader election (SKIP_LEADER_ELECTION=true)")
                self.is_leader = True
            return True

        leader_ref = self.db.collection(self.leader_collection_path).document(
            self.leader_doc_id
        )

        @firestore.transactional
        def update_in_transaction(transaction, ref):
            snapshot = ref.get(transaction=transaction)
            now = datetime.now(timezone.utc)
            expires_at = now + timedelta(seconds=self.leader_lease_seconds)

            new_data = {
                "leader_id": self.instance_id,
                "lease_expires_at": expires_at,
                "last_renewed_at": now,
            }

            if not snapshot.exists:
                transaction.set(ref, new_data)
                return True

            data = snapshot.to_dict()
            current_leader = data.get("leader_id")
            lease_expires = data.get("lease_expires_at")

            # If lease is valid and held by someone else
            if (
                current_leader != self.instance_id
                and lease_expires
                and lease_expires > now
            ):
                return False

            # Otherwise (expired or held by me), claim/renew it
            transaction.set(ref, new_data)
            return True

        try:
            transaction = self.db.transaction()
            is_leader = update_in_transaction(transaction, leader_ref)

            if is_leader and not self.is_leader:
                logger.info("👑 Acquired leadership (instance: %s)", self.instance_id)
            elif not is_leader and self.is_leader:
                logger.info("Lost leadership")

            self.is_leader = is_leader
            return is_leader
        except Exception as e:
            logger.error("Error during leadership election: %s", e)
            # If we can't talk to Firestore, assume we lost leadership to be safe
            self.is_leader = False
            return False

    def _parse_start_time(self, start_value) -> Optional[datetime]:
        """Parse a start time value that may be a datetime, timestamp, or ISO string.

        Calendar sync systems may store 'start' as an ISO string instead of a
        Firestore Timestamp. This helper normalizes both formats.

        Returns:
            datetime object in UTC, or None if parsing fails.
        """
        if start_value is None:
            return None

        # Already a datetime
        if isinstance(start_value, datetime):
            if start_value.tzinfo is None:
                return start_value.replace(tzinfo=timezone.utc)
            return start_value

        # Firestore DatetimeWithNanoseconds (has .timestamp() method)
        if hasattr(start_value, "timestamp"):
            return datetime.fromtimestamp(start_value.timestamp(), tz=timezone.utc)

        # ISO string format (e.g., "2026-01-12T22:15:00+00:00")
        if isinstance(start_value, str):
            try:
                # Handle both "Z" and "+00:00" suffixes
                parsed = datetime.fromisoformat(start_value.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return parsed
            except ValueError:
                logger.warning(f"Could not parse start time string: {start_value}")
                return None

        logger.warning(f"Unknown start time type: {type(start_value)}")
        return None

    def _past_meeting_threshold(self, *, now: Optional[datetime] = None) -> datetime:
        reference_now = now or datetime.now(timezone.utc)
        grace_minutes = max(0, int(getattr(self, "past_meeting_grace_minutes", 30)))
        return reference_now - timedelta(minutes=grace_minutes)

    def _is_meeting_payload_past(
        self, meeting_data: Dict[str, Any], *, now: Optional[datetime] = None
    ) -> Tuple[bool, str]:
        """Return True when meeting timing metadata is older than the stale threshold."""
        threshold = self._past_meeting_threshold(now=now)
        candidates = [
            ("end", meeting_data.get("end")),
            ("end_time", meeting_data.get("end_time")),
            ("occurrence_start_utc", meeting_data.get("occurrence_start_utc")),
            ("OCCURRENCE_START_UTC", meeting_data.get("OCCURRENCE_START_UTC")),
            ("start", meeting_data.get("start")),
            ("start_time", meeting_data.get("start_time")),
            ("MEETING_START_TIME", meeting_data.get("MEETING_START_TIME")),
        ]

        for field_name, candidate in candidates:
            if candidate in (None, ""):
                continue
            parsed = self._parse_start_time(candidate)
            if parsed is None:
                continue
            if parsed <= threshold:
                if field_name.startswith("end"):
                    return True, "end_before_grace_threshold"
                if "occurrence" in field_name.lower():
                    return True, "occurrence_before_grace_threshold"
                return True, "start_before_grace_threshold"

        return False, ""

    def _is_session_past(
        self,
        session_data: Dict[str, Any],
        *,
        session_ref: Optional[firestore.DocumentReference] = None,
    ) -> Tuple[bool, str]:
        """Return True when a session maps to a meeting that is already in the past."""
        is_past, reason = self._is_meeting_payload_past(session_data)
        if is_past:
            return True, reason

        if session_ref is None or not hasattr(session_ref, "collection"):
            return False, ""

        org_id = (session_data.get("org_id") or "").strip()
        if not org_id:
            return False, ""

        subscribers = list(session_ref.collection("subscribers").limit(1).stream())
        if not subscribers:
            return False, ""

        first_sub = subscribers[0]
        sub_data = first_sub.to_dict() or {}
        fs_meeting_id = sub_data.get("fs_meeting_id")
        if not fs_meeting_id:
            return False, ""

        meeting_ref = (
            self.db.collection("organizations")
            .document(org_id)
            .collection("meetings")
            .document(str(fs_meeting_id))
        )
        meeting_doc = meeting_ref.get()
        if not meeting_doc.exists:
            return False, ""

        meeting_data = meeting_doc.to_dict() or {}
        is_past, reason = self._is_meeting_payload_past(meeting_data)
        if is_past:
            return True, f"meeting_doc_{reason}"

        return False, ""

    def _scan_upcoming_meetings(self):
        """Scan for meetings starting soon (or recently missed) and enqueue them.

        The window covers both the 8-minute lookahead and a backward window equal
        to PAST_MEETING_GRACE_MINUTES, so meetings that were synced to Firestore
        just before (or after) their start time are still picked up.  Deduplication
        is handled by the existing bot_instance_id check and the Kubernetes
        _is_bot_already_assigned() annotation check, ensuring no meeting gets a
        second bot.

        Note: This method handles both Firestore Timestamp and ISO string formats
        for the 'start' field, as calendar sync systems may use either format.
        """
        now = datetime.now(timezone.utc)
        window_start = now - timedelta(minutes=self.past_meeting_grace_minutes)
        window_end = now + timedelta(minutes=8, seconds=30)

        logger.info(f"Scanning meetings: {window_start} to {window_end}")

        if self.meetings_query_mode == "collection_group":
            coll = self.db.collection_group(self.meetings_collection_path)
        else:
            coll = self.db.collection(self.meetings_collection_path)

        # Query by time window using Firestore Timestamp comparison.
        # This works for documents where 'start' is stored as a Timestamp.
        query = coll.where("start", ">=", window_start).where("start", "<=", window_end)

        try:
            docs = list(query.stream())

            # Also query for meetings with ISO string 'start' fields.
            # Calendar sync systems may store 'start' as a string like
            # "2026-01-12T22:15:00+00:00" instead of a Firestore Timestamp.
            # These won't be found by the timestamp query above.
            window_start_iso = window_start.isoformat()
            window_end_iso = window_end.isoformat()

            string_query = coll.where("start", ">=", window_start_iso).where(
                "start", "<=", window_end_iso
            )
            string_docs = list(string_query.stream())

            # Merge results, avoiding duplicates by document ID
            seen_ids = {doc.id for doc in docs}
            for doc in string_docs:
                if doc.id not in seen_ids:
                    docs.append(doc)
                    seen_ids.add(doc.id)

            logger.info(f"Found {len(docs)} meetings in time window")

            for doc in docs:
                data = doc.to_dict()

                # Parse and validate the start time
                start_time = self._parse_start_time(data.get("start"))
                if start_time is None:
                    logger.warning(f"Skipping {doc.id}: could not parse 'start' field")
                    continue

                # Double-check the start time is in our window
                # (needed for string queries which may have edge cases)
                if not (window_start <= start_time <= window_end):
                    logger.debug(
                        f"Skipping {doc.id}: start time {start_time} "
                        f"outside window after parsing"
                    )
                    continue

                is_past_meeting, past_reason = self._is_meeting_payload_past(
                    data, now=now
                )
                if is_past_meeting:
                    stale_reason = f"stale_{past_reason or 'timing_threshold'}"
                    logger.info(
                        "MEETING_SCHEDULE_SKIP_STALE: meeting_id=%s, reason=%s",
                        doc.id,
                        stale_reason,
                    )
                    try:
                        doc.reference.update(
                            {
                                "session_status": "cancelled",
                                "session_cancelled_at": now,
                                "session_cancel_reason": stale_reason,
                                "updated_at": now,
                            }
                        )
                    except Exception as stale_update_error:
                        logger.warning(
                            "Failed to update stale meeting %s: %s",
                            doc.id,
                            stale_update_error,
                        )
                    continue

                logger.debug(
                    f"Evaluating meeting {doc.id}: "
                    f"status={data.get(self.meeting_status_field)}, "
                    f"bot_instance_id={data.get(self.meeting_bot_instance_field)}, "
                    f"join_url={data.get('join_url', '')[:50]}"
                )

                # Filter by status
                status = data.get(self.meeting_status_field)
                if (
                    self.meeting_status_values
                    and status not in self.meeting_status_values
                ):
                    # Check if meeting was already queued by another system
                    # (e.g., calendar sync, API, etc.) even if status changed
                    bot_status = data.get("bot_status")
                    session_status = data.get("session_status")
                    if bot_status == "queued" or session_status == "queued":
                        logger.info(
                            f"Meeting {doc.id} status='{status}' not in "
                            f"{self.meeting_status_values} but bot_status='{bot_status}' "
                            f"or session_status='{session_status}' is queued - "
                            f"processing anyway"
                        )
                        # Continue processing this meeting
                    else:
                        logger.debug(
                            f"Skipping {doc.id}: status '{status}' not in "
                            f"{self.meeting_status_values}"
                        )
                        continue

                # Check if bot already exists
                if data.get(self.meeting_bot_instance_field):
                    logger.debug(f"Skipping {doc.id}: bot_instance already exists")
                    continue

                # Check user and meeting settings for auto-join/AI assistant
                user_id = data.get("user_id") or data.get("created_by")
                ai_enabled = data.get("ai_assistant_enabled", False)
                auto_join = False

                if user_id:
                    user_ref = self.db.collection("users").document(user_id)
                    user_doc = user_ref.get()
                    if user_doc.exists:
                        user_data = user_doc.to_dict()
                        auto_join = user_data.get("auto_join_meetings", False)

                        # ADV-648: Calendar Disconnect Protection (FR-002)
                        # If user has disconnected their calendar, skip their meetings
                        calendar_connected = user_data.get("calendar_connected", False)
                        if not calendar_connected:
                            logger.debug(
                                f"Skipping {doc.id}: user {user_id} calendar disconnected"
                            )
                            continue

                logger.debug(
                    f"Meeting {doc.id}: ai_enabled={ai_enabled}, "
                    f"auto_join={auto_join}"
                )

                if not (ai_enabled or auto_join):
                    logger.debug(f"Skipping {doc.id}: neither ai_enabled nor auto_join")
                    continue

                # Check if Teams meeting
                join_url = data.get("join_url") or ""
                if "teams.microsoft.com" not in join_url:
                    logger.debug(f"Skipping {doc.id}: not a Teams meeting")
                    continue

                org_id = (
                    data.get("organization_id")
                    or data.get("organizationId")
                    or data.get("teamId")
                    or data.get("team_id")
                )

                # K8s-based deduplication: Check if a bot is already assigned
                # to this org+URL combination by querying active K8s jobs.
                is_assigned, existing_job = self._is_bot_already_assigned(
                    org_id, join_url
                )

                if is_assigned:
                    # Bot already exists - link this meeting to it for fanout
                    logger.info(
                        "BOT_ALREADY_EXISTS: meeting=%s, org=%s, job=%s",
                        doc.id,
                        org_id,
                        existing_job,
                    )
                    self._link_meeting_to_existing_bot(doc, existing_job)
                else:
                    # No active bot - create new job directly
                    if start_time < now:
                        logger.info(
                            "LATE_SYNC_JOIN: meeting=%s, start=%s, lag_seconds=%.0f",
                            doc.id,
                            start_time,
                            (now - start_time).total_seconds(),
                        )
                    logger.info(f"Creating bot for meeting {doc.id}")
                    success = self._create_bot_for_meeting(
                        doc, org_id, join_url, user_id
                    )
                    if success:
                        logger.info(
                            "BOT_JOB_CREATED_FOR_MEETING: meeting=%s, org=%s",
                            doc.id,
                            org_id,
                        )
                    else:
                        logger.warning(
                            "Failed to create bot job for meeting %s", doc.id
                        )
        except Exception as e:
            logger.error(f"Error scanning upcoming meetings: {e}", exc_info=True)

    def _pubsub_callback(self, message: pubsub_v1.subscriber.message.Message):
        """Handle incoming Pub/Sub messages."""
        try:
            data = json.loads(message.data.decode("utf-8"))
            meeting_id = data.get("meeting_id")
            # Use same comprehensive org_id extraction as create_manager_job
            org_id = (
                data.get("team_id") or data.get("teamId") or data.get("org_id") or ""
            )

            # Compute meeting_session_id for fanout marking if not already present
            meeting_url = data.get("meeting_url") or data.get("meetingUrl") or ""
            occurrence_start_utc = data.get("occurrence_start_utc") or ""
            if not data.get("meeting_session_id") and org_id and meeting_url:
                data["meeting_session_id"] = self._meeting_session_id(
                    org_id=org_id,
                    meeting_url=meeting_url,
                    occurrence_start_utc=occurrence_start_utc,
                )

            logger.debug("=" * 80)
            logger.debug("PUB/SUB MESSAGE RECEIVED")
            logger.debug("=" * 80)
            logger.debug("Message ID: %s", message.message_id)
            logger.debug(
                "Full message data: %s", json.dumps(data, indent=2, default=str)
            )
            logger.debug("Meeting ID: %s", meeting_id)
            logger.debug("Organization ID: %s", org_id)
            logger.debug("=" * 80)

            logger.info(f"Received Pub/Sub message for meeting: {meeting_id}")

            if not meeting_id:
                logger.error("Message missing meeting_id")
                logger.debug("Acknowledging invalid message (missing meeting_id)")
                message.ack()  # Ack invalid messages to remove them
                return

            payload_is_past, payload_past_reason = self._is_meeting_payload_past(data)
            if payload_is_past:
                stale_reason = f"stale_{payload_past_reason or 'timing_threshold'}"
                logger.info(
                    "PUBSUB_SKIP_STALE_PAYLOAD: meeting_id=%s, org_id=%s, reason=%s",
                    meeting_id,
                    org_id,
                    stale_reason,
                )
                message.ack()
                return

            logger.debug("Checking for known meeting document in Firestore...")
            # Unified Path: Check if this corresponds to a known meeting document
            # If so, delegate to the session dedupe logic used by the poller.
            # This prevents duplicate bots if Poller and Pub/Sub Trigger both fire.
            meeting_doc = None
            if org_id:
                logger.debug(
                    "Organization ID present, attempting to fetch meeting document..."
                )
                try:
                    meeting_ref = (
                        self.db.collection("organizations")
                        .document(org_id)
                        .collection("meetings")
                        .document(meeting_id)
                    )
                    meeting_doc = meeting_ref.get()
                    logger.debug(
                        "Meeting document fetch result: exists=%s",
                        meeting_doc.exists if meeting_doc else False,
                    )
                except Exception as fetch_err:
                    logger.warning(
                        f"Could not fetch meeting doc for {meeting_id}: {fetch_err}"
                    )
            else:
                logger.debug(
                    "No organization ID in message, skipping meeting document lookup"
                )

            if meeting_doc and meeting_doc.exists:
                logger.debug("Meeting document found, validating user ownership...")
                # Verify the meeting belongs to the user before using the existing record
                m_data = meeting_doc.to_dict() or {}
                logger.debug(
                    "Meeting document data: %s",
                    json.dumps(m_data, indent=2, default=str),
                )
                payload_user_id = data.get("user_id") or data.get("userId")
                valid_owners = {
                    m_data.get("user_id"),
                    m_data.get("userId"),
                    m_data.get("created_by"),
                    m_data.get("synced_by_user_id"),
                }
                # Filter out None/Empty
                valid_owners = {u for u in valid_owners if u}

                logger.debug("Payload user ID: %s", payload_user_id)
                logger.debug("Valid owner IDs: %s", valid_owners)

                if payload_user_id and payload_user_id in valid_owners:
                    doc_is_past, doc_past_reason = self._is_meeting_payload_past(m_data)
                    if doc_is_past:
                        stale_reason = f"stale_{doc_past_reason or 'timing_threshold'}"
                        logger.info(
                            "PUBSUB_SKIP_STALE_MEETING: meeting_id=%s, org_id=%s, reason=%s",
                            meeting_id,
                            org_id,
                            stale_reason,
                        )
                        try:
                            meeting_doc.reference.update(
                                {
                                    "session_status": "cancelled",
                                    "session_cancelled_at": datetime.now(timezone.utc),
                                    "session_cancel_reason": stale_reason,
                                    "updated_at": datetime.now(timezone.utc),
                                }
                            )
                        except Exception as stale_update_error:
                            logger.warning(
                                "Failed to update stale meeting %s from Pub/Sub: %s",
                                meeting_id,
                                stale_update_error,
                            )
                        message.ack()
                        return

                    logger.info(
                        f"Found scheduled meeting {meeting_id}, delegating to session manager"
                    )
                    logger.debug(
                        "Creating or updating session for scheduled meeting..."
                    )
                    session_id = self._try_create_or_update_session_for_meeting(
                        meeting_doc
                    )
                    if session_id:
                        logger.info(
                            f"Successfully enqueued session {session_id} for "
                            f"meeting {meeting_id}"
                        )
                        logger.debug(
                            "Session enqueued successfully, acknowledging Pub/Sub message"
                        )
                        message.ack()
                        return
                    else:
                        logger.warning(
                            f"Failed to enqueue session for {meeting_id}, "
                            "falling back to legacy launch"
                        )
                else:
                    logger.warning(
                        f"Meeting {meeting_id} exists but user verification failed "
                        f"(Payload: {payload_user_id}, Valid: {valid_owners}). Treating as ad-hoc."
                    )
                    logger.debug(
                        "User verification failed, falling through to legacy behavior"
                    )
                    # Fall through to legacy behavior if session creation fails
            else:
                logger.debug(
                    "No meeting document found or doesn't exist, proceeding with legacy flow"
                )

            # Try to find the bot instance to claim it
            logger.debug("Attempting to find or create bot instance for legacy flow...")
            bot_instance_id = None

            # 1. Check if meeting doc has bot_instance_id
            if org_id:
                logger.debug(
                    "Checking meeting document for existing bot_instance_id..."
                )
                meeting_ref = (
                    self.db.collection("organizations")
                    .document(org_id)
                    .collection("meetings")
                    .document(meeting_id)
                )
                meeting_doc = meeting_ref.get()
                if meeting_doc.exists:
                    meeting_data = meeting_doc.to_dict() or {}
                    bot_instance_id = meeting_data.get(self.meeting_bot_instance_field)
                    logger.debug(
                        "Bot instance ID from meeting doc: %s", bot_instance_id
                    )
                else:
                    logger.debug("Meeting document does not exist")

            # 2. If not found, try the default ID convention (meeting_id)
            if not bot_instance_id:
                logger.debug(
                    "No bot_instance_id found, using meeting_id as default: %s",
                    meeting_id,
                )
                bot_instance_id = meeting_id

            # 3. Try to claim the bot instance
            logger.debug("Attempting to claim bot_instance: %s", bot_instance_id)
            bot_ref = self.db.collection("bot_instances").document(str(bot_instance_id))

            # If bot instance doesn't exist, launch anyway
            # Risk: double-launching if Poller picks it up
            # Mitigation: claim atomically prevents double-launch

            claimed = self._try_claim_bot_instance(bot_ref)

            if claimed:
                logger.info(f"Claimed bot instance {bot_instance_id} via Pub/Sub")
                logger.debug("Creating Kubernetes job for claimed bot instance...")
                if self.create_manager_job(data, message.message_id):
                    logger.debug(
                        "Job created successfully, marking bot instance as done"
                    )
                    self._mark_bot_instance_done(bot_ref, ok=True)
                    message.ack()
                else:
                    logger.error(
                        "Failed to create job for bot instance %s", bot_instance_id
                    )
                    self._mark_bot_instance_done(bot_ref, ok=False)
                    message.nack()
            else:
                # Could not claim. Check if it exists
                # If missing, launch without state tracking
                # If exists, someone else is handling it
                logger.debug("Failed to claim bot instance, checking if it exists...")
                bot_doc = bot_ref.get()
                if not bot_doc.exists:
                    logger.warning(
                        f"Bot instance {bot_instance_id} not found. "
                        f"Launching without state tracking."
                    )
                    logger.debug("Creating job without state tracking...")
                    if self.create_manager_job(data, message.message_id):
                        logger.debug("Job created successfully without state tracking")
                        message.ack()
                    else:
                        logger.error("Failed to create job without state tracking")
                        message.nack()
                else:
                    logger.info(f"Bot instance {bot_instance_id} already processing")
                    logger.debug(
                        "Bot instance already claimed/processing, acknowledging message"
                    )
                    message.ack()  # Ack: someone else handling it

        except Exception as e:
            logger.error(f"Error processing Pub/Sub message: {e}", exc_info=True)
            logger.debug("Exception occurred, nacking message")
            message.nack()

    def _start_pubsub_listener(self):
        """Start the Pub/Sub subscriber in a background thread."""
        if not self.pubsub_subscription:
            logger.warning("No PUBSUB_SUBSCRIPTION configured. Skipping listener.")
            return

        try:
            subscriber = pubsub_v1.SubscriberClient()
            self.subscriber = subscriber
            self.streaming_pull_future = subscriber.subscribe(
                self.pubsub_subscription, callback=self._pubsub_callback
            )
            logger.info(f"Listening on {self.pubsub_subscription}")
        except Exception as e:
            logger.error(f"Failed to start Pub/Sub listener: {e}")

    def run(self):
        """Main run loop - continuously process queued Firestore work"""
        logger.info("=" * 50)
        logger.info("🚀 Meeting Bot Controller starting...")
        logger.info("=" * 50)
        logger.info(f"📡 Project ID: {self.project_id}")
        logger.info(f"�️  Firestore DB: {self.firestore_database}")
        logger.info(f"📁 Namespace: {self.k8s_namespace}")
        logger.info(f"🐳 Manager Image: {self.manager_image}")
        logger.info(f"🐳 Meeting Bot Image: {self.meeting_bot_image}")
        logger.info("=" * 50)

        # Start health check server
        health_server = HealthCheckServer()
        health_server.start()

        logger.info(f"Polling interval: {self.poll_interval}s")

        # Start the Pub/Sub listener
        self._start_pubsub_listener()

        while True:
            try:
                # Check leadership
                if not self._try_acquire_leadership():
                    logger.debug("Not leader, sleeping...")
                    time.sleep(self.poll_interval)
                    continue

                logger.debug("Starting poll cycle...")

                # Step 0: discover meetings starting soon (2min window)
                self._scan_upcoming_meetings()

                # Step 0.5: validate claimed sessions have jobs (periodic check)
                self._validate_claimed_sessions_have_jobs()

                # Step 1: process queued meeting sessions (org+meeting_url dedupe).
                session_docs = self._query_queued_meeting_sessions()

                # LLM-FRIENDLY: Periodic status summary
                logger.info(
                    "POLL_CYCLE_STATUS: queued_sessions=%d, timestamp=%s",
                    len(session_docs),
                    datetime.now(timezone.utc).isoformat(),
                )

                if not session_docs:
                    logger.info(
                        "No queued sessions found. Waiting %ss...",
                        self.poll_interval,
                    )
                    time.sleep(self.poll_interval)
                    continue

                logger.info("Found %s queued meeting session(s)", len(session_docs))

                for session_doc in session_docs:
                    session_ref = session_doc.reference
                    session_data = session_doc.to_dict() or {}
                    session_id_short = session_doc.id[:16]
                    session_org = session_data.get("org_id", "unknown")
                    session_url = session_data.get("meeting_url", "")[:50]

                    try:
                        if not self._try_claim_meeting_session(session_ref):
                            # LLM-FRIENDLY: Log why we didn't claim
                            logger.info(
                                "SESSION_CLAIM_SKIPPED: session_id=%s, org_id=%s, "
                                "reason=already_claimed_or_conflict",
                                session_id_short,
                                session_org,
                            )
                            continue

                        payload = self._build_job_payload_from_meeting_session(
                            session_doc
                        )
                        ok = self.create_manager_job(payload, session_doc.id)

                        if ok:
                            # LLM-FRIENDLY: Successful job creation for session
                            logger.info(
                                "SESSION_JOB_SUCCESS: session_id=%s, org_id=%s, "
                                "meeting_url=%s, status=job_created",
                                session_id_short,
                                session_org,
                                session_url,
                            )
                        else:
                            # LLM-FRIENDLY: Job creation failed - this is a problem!
                            logger.error(
                                "SESSION_JOB_FAILED: session_id=%s, org_id=%s, "
                                "meeting_url=%s, status=job_creation_failed",
                                session_id_short,
                                session_org,
                                session_url,
                            )
                            logger.error(
                                "LLM_CONTEXT: Session %s was claimed but job creation "
                                "failed. The session will be marked as failed. "
                                "Check BOT_JOB_BLOCKED or BOT_JOB_FAILED logs above "
                                "for the specific reason. Common causes: missing user_id, "
                                "missing meeting_url, K8s quota, or API errors.",
                                session_id_short,
                            )
                            # Only mark failed if job creation failed.
                            # Manager is responsible for marking complete after artifacts upload.
                            self._mark_meeting_session_done(session_ref, ok=False)
                    except Exception as e:
                        logger.error(
                            "SESSION_PROCESSING_ERROR: session_id=%s, org_id=%s, "
                            "error_type=%s, error=%s",
                            session_id_short,
                            session_org,
                            type(e).__name__,
                            str(e)[:200],
                        )
                        logger.error(
                            "Failed processing meeting session %s: %s",
                            session_doc.id,
                            e,
                            exc_info=True,
                        )
                        try:
                            self._mark_meeting_session_done(session_ref, ok=False)
                        except Exception:
                            pass

                # Step 2: fan-out completed sessions (legacy session-based approach).
                completed = self._query_completed_sessions_needing_fanout()
                for sess in completed:
                    data = sess.to_dict() or {}
                    org_id = data.get("org_id") or ""
                    if not org_id:
                        continue
                    self._fanout_meeting_session_artifacts(
                        org_id=org_id, session_id=sess.id
                    )

                # Step 3: fan-out completed meetings (new URL-based approach).
                # This handles meetings created with K8s-based deduplication.
                completed_meetings = self._query_completed_meetings_needing_fanout()
                for meeting_doc in completed_meetings:
                    self._fanout_completed_meeting_by_url(meeting_doc)

            except KeyboardInterrupt:
                logger.info("👋 Received shutdown signal")
                break
            except Exception as e:
                logger.error(f"❌ Error in main loop: {e}", exc_info=True)
                time.sleep(self.poll_interval)


def main():
    """Entry point"""
    try:
        controller = MeetingController()
        controller.run()
    except KeyboardInterrupt:
        logger.info("👋 Shutting down controller")
        flush_sentry()
        sys.exit(0)
    except Exception as e:
        logger.error(f"💥 Fatal error: {e}", exc_info=True)
        capture_error_safe(
            e, component="controller", feature="main", action="fatal_error"
        )
        flush_sentry()
        sys.exit(1)


if __name__ == "__main__":
    main()
