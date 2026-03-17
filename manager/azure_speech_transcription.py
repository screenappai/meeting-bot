"""Azure Speech fast-transcription adapter for manager pipeline."""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import requests

logger = logging.getLogger(__name__)

_AU_REGIONS = {"australiaeast", "australiasoutheast"}
_TRUE_VALUES = {"1", "true", "yes", "y", "on"}
_FALSE_VALUES = {"0", "false", "no", "n", "off"}


def _parse_bool_env(var_name: str, default: bool) -> bool:
    raw = os.getenv(var_name)
    if raw is None or raw.strip() == "":
        return default

    normalized = raw.strip().lower()
    if normalized in _TRUE_VALUES:
        return True
    if normalized in _FALSE_VALUES:
        return False

    raise ValueError(
        f"Invalid {var_name} value {raw!r}; expected one of "
        f"{sorted(_TRUE_VALUES | _FALSE_VALUES)}"
    )


def _parse_positive_int_env(var_name: str, default: int) -> int:
    raw = os.getenv(var_name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(
            f"Invalid {var_name} value {raw!r}; expected positive integer"
        ) from exc
    if value <= 0:
        raise ValueError(f"Invalid {var_name} value {raw!r}; must be > 0")
    return value


@dataclass(frozen=True)
class AzureSpeechConfig:
    endpoint: str
    region: str
    key: str
    api_version: str
    locale: str
    diarization_enabled: bool
    diarization_max_speakers: int
    request_timeout_seconds: int


def load_azure_speech_config_from_env() -> AzureSpeechConfig:
    """Load and validate Azure Speech config with strict AU checks."""

    endpoint_raw = (os.getenv("AZURE_SPEECH_ENDPOINT") or "").strip()
    region_raw = (os.getenv("AZURE_SPEECH_REGION") or "").strip().lower()
    key_raw = (os.getenv("AZURE_SPEECH_KEY") or "").strip()

    missing = []
    if not endpoint_raw:
        missing.append("AZURE_SPEECH_ENDPOINT")
    if not region_raw:
        missing.append("AZURE_SPEECH_REGION")
    if not key_raw:
        missing.append("AZURE_SPEECH_KEY")
    if missing:
        raise ValueError(
            "Missing required Azure Speech environment variables: "
            + ", ".join(missing)
        )

    if region_raw not in _AU_REGIONS:
        raise ValueError(
            "AZURE_SPEECH_REGION must be an AU region "
            f"({', '.join(sorted(_AU_REGIONS))}); got {region_raw!r}"
        )

    endpoint = endpoint_raw.rstrip("/")
    parsed = urlparse(endpoint)
    if parsed.scheme.lower() != "https":
        raise ValueError(
            f"AZURE_SPEECH_ENDPOINT must use https://, got {endpoint_raw!r}"
        )
    if parsed.path not in ("", "/"):
        raise ValueError(
            "AZURE_SPEECH_ENDPOINT must be a root endpoint without path, "
            f"got {endpoint_raw!r}"
        )

    expected_host = f"{region_raw}.api.cognitive.microsoft.com"
    if parsed.netloc.lower() != expected_host:
        raise ValueError(
            "AZURE_SPEECH_ENDPOINT must match AZURE_SPEECH_REGION and stay on "
            f"regional endpoint. Expected https://{expected_host}, got {endpoint_raw!r}"
        )

    api_version = (os.getenv("AZURE_SPEECH_API_VERSION") or "2025-10-15").strip()
    locale = (os.getenv("AZURE_SPEECH_LOCALE") or "en-AU").strip()
    if not locale:
        raise ValueError("AZURE_SPEECH_LOCALE must not be empty")

    diarization_enabled = _parse_bool_env("AZURE_SPEECH_ENABLE_DIARIZATION", True)
    diarization_max_speakers = _parse_positive_int_env(
        "AZURE_SPEECH_DIARIZATION_MAX_SPEAKERS", 6
    )
    if diarization_enabled and diarization_max_speakers < 2:
        raise ValueError(
            "AZURE_SPEECH_DIARIZATION_MAX_SPEAKERS must be >= 2 when "
            "AZURE_SPEECH_ENABLE_DIARIZATION=true"
        )
    if diarization_enabled and diarization_max_speakers > 35:
        raise ValueError(
            "AZURE_SPEECH_DIARIZATION_MAX_SPEAKERS must be <= 35 for Azure "
            "Speech fast transcription diarization"
        )

    timeout_seconds = _parse_positive_int_env(
        "AZURE_SPEECH_REQUEST_TIMEOUT_SECONDS",
        900,
    )

    return AzureSpeechConfig(
        endpoint=endpoint,
        region=region_raw,
        key=key_raw,
        api_version=api_version,
        locale=locale,
        diarization_enabled=diarization_enabled,
        diarization_max_speakers=diarization_max_speakers,
        request_timeout_seconds=timeout_seconds,
    )


class AzureSpeechTranscriptionAdapter:
    """Adapter for Azure Speech fast transcription REST API."""

    def __init__(
        self, config: AzureSpeechConfig, session: Optional[requests.Session] = None
    ):
        self.config = config
        self.session = session or requests.Session()

        if self.config.diarization_enabled:
            logger.info(
                "Azure Speech diarization enabled (max_speakers=%d)",
                self.config.diarization_max_speakers,
            )
        else:
            logger.warning(
                "Azure Speech diarization disabled via "
                "AZURE_SPEECH_ENABLE_DIARIZATION=false"
            )

    @property
    def _transcribe_url(self) -> str:
        return (
            f"{self.config.endpoint}/speechtotext/transcriptions:transcribe"
            f"?api-version={self.config.api_version}"
        )

    def transcribe_audio(
        self,
        audio_uri: str,
        language_code: str = "en-AU",
        enable_speaker_diarization: bool = True,
        enable_timestamps: bool = False,
        enable_action_items: bool = True,
    ) -> Optional[Dict[str, Any]]:
        del enable_action_items

        audio_path = Path(audio_uri)
        if not audio_path.exists():
            raise FileNotFoundError(str(audio_path))

        diarization_requested = (
            bool(enable_speaker_diarization) and self.config.diarization_enabled
        )
        if enable_speaker_diarization and not self.config.diarization_enabled:
            logger.warning(
                "Azure diarization requested but disabled by config; "
                "continuing without diarization."
            )

        definition: Dict[str, Any] = {"locales": [language_code or self.config.locale]}
        if diarization_requested:
            definition["diarization"] = {
                "enabled": True,
                "maxSpeakers": self.config.diarization_max_speakers,
            }
        if enable_timestamps:
            definition["wordLevelTimestampsEnabled"] = True

        mime = mimetypes.guess_type(str(audio_path))[0] or "application/octet-stream"
        headers = {"Ocp-Apim-Subscription-Key": self.config.key}

        logger.info(
            "Submitting Azure Speech fast transcription: endpoint=%s, locale=%s, diarization=%s",
            self.config.endpoint,
            definition["locales"][0],
            diarization_requested,
        )
        started = time.time()

        with audio_path.open("rb") as audio_file:
            files = {
                "audio": (audio_path.name, audio_file, mime),
                "definition": (None, json.dumps(definition), "application/json"),
            }
            response = self.session.post(
                self._transcribe_url,
                headers=headers,
                files=files,
                timeout=self.config.request_timeout_seconds,
            )

        if response.status_code != 200:
            raise RuntimeError(
                "Azure Speech transcription request failed "
                f"(status={response.status_code}): {response.text[:500]}"
            )

        payload = response.json()
        duration_ms = int((time.time() - started) * 1000)

        phrases = payload.get("phrases") or []
        combined = payload.get("combinedPhrases") or []

        transcript = " ".join(
            item.get("text", "").strip() for item in combined if item.get("text")
        ).strip()
        if not transcript:
            transcript = " ".join(
                item.get("text", "").strip() for item in phrases if item.get("text")
            ).strip()

        if not transcript:
            logger.warning("Azure Speech transcription returned empty transcript text")
            return None

        segments: List[Dict[str, Any]] = []
        diarization_lines: List[str] = []
        for phrase in phrases:
            text = (phrase.get("text") or "").strip()
            if not text:
                continue
            start_ms = int(phrase.get("offsetMilliseconds") or 0)
            phrase_duration_ms = int(phrase.get("durationMilliseconds") or 0)
            speaker_idx = phrase.get("speaker")
            speaker_label: Optional[str] = (
                f"Speaker {speaker_idx}" if speaker_idx is not None else None
            )
            segment = {
                "start": start_ms / 1000.0,
                "end": (start_ms + phrase_duration_ms) / 1000.0,
                "speaker": speaker_label,
                "text": text,
                "confidence": phrase.get("confidence"),
                "locale": phrase.get("locale"),
            }
            segments.append(segment)
            if speaker_label:
                diarization_lines.append(f"{speaker_label}: {text}")

        sections: Dict[str, Any] = {}
        if diarization_lines:
            sections["speakerDiarization"] = "\n".join(diarization_lines)

        return {
            "engine": "azure-speech-fast-transcription",
            "model": "azure-speech-fast-transcription",
            "locale": definition["locales"][0],
            "transcript": transcript,
            "segments": segments,
            "sections": sections,
            "word_count": len(transcript.split()),
            "processing_time_ms": duration_ms,
            "diarization": {
                "requested": bool(enable_speaker_diarization),
                "enabled": diarization_requested,
                "max_speakers": (
                    self.config.diarization_max_speakers if diarization_requested else 0
                ),
            },
            "raw_response": payload,
        }

    def save_transcript(
        self, transcript_data: Dict[str, Any], output_path: str, format: str = "txt"
    ) -> bool:
        try:
            if format == "txt":
                with open(output_path, "w", encoding="utf-8") as f:
                    f.write(transcript_data.get("transcript", "").strip())
                    f.write("\n\n")
                    f.write("--- Metadata ---\n")
                    f.write(f"Words: {transcript_data.get('word_count', 0)}\n")
                    f.write(
                        "Processing Time: "
                        f"{transcript_data.get('processing_time_ms', 0) / 1000:.2f}s\n"
                    )
                    f.write(f"Model: {transcript_data.get('model', 'N/A')}\n")
                    f.write(f"Locale: {transcript_data.get('locale', 'N/A')}\n")

                    segments = transcript_data.get("segments") or []
                    if segments:
                        f.write("\n\n--- Segments ---\n")
                        for seg in segments:
                            speaker = f"{seg['speaker']}: " if seg.get("speaker") else ""
                            f.write(
                                f"[{seg.get('start', 0):0.2f}-{seg.get('end', 0):0.2f}] "
                                f"{speaker}{seg.get('text', '')}\n"
                            )
            elif format == "json":
                with open(output_path, "w", encoding="utf-8") as f:
                    json.dump(transcript_data, f, indent=2, ensure_ascii=False)
            else:
                logger.error("Unsupported format: %s", format)
                return False

            logger.info("✅ Azure transcript saved: %s", output_path)
            return True
        except Exception as exc:
            logger.exception("Error saving Azure transcript: %s", exc)
            return False
