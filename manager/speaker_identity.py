from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence
from urllib.parse import urlparse

import requests


SELF_INTRO_RE = re.compile(
    r"\b(?:i am|i'm|this is|my name is)\s+([A-Za-z][A-Za-z'’\-]+(?:\s+[A-Za-z][A-Za-z'’\-]+)?)\b",
    re.IGNORECASE,
)


def _normalize_name(name: str) -> str:
    lowered = re.sub(r"[^a-z0-9\s]", " ", name.lower())
    return re.sub(r"\s+", " ", lowered).strip()


def _first_name(name: str) -> str:
    norm = _normalize_name(name)
    return norm.split(" ")[0] if norm else ""


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _load_json(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        payload = json.load(f)
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object in {path}, got {type(payload).__name__}")
    return payload


def load_transcript_payload(path: str) -> Dict[str, Any]:
    """Load transcript JSON payload from disk."""
    return _load_json(path)


def _normalize_segments(payload: Mapping[str, Any]) -> List[Dict[str, Any]]:
    raw_segments = payload.get("segments") or []
    if not isinstance(raw_segments, list):
        return []

    normalized: List[Dict[str, Any]] = []
    for raw in raw_segments:
        if not isinstance(raw, Mapping):
            continue

        speaker = str(raw.get("speaker") or "").strip() or "Unknown"
        text = str(raw.get("text") or "").strip()
        start = _to_float(raw.get("start"), 0.0)
        end = _to_float(raw.get("end"), start)
        if end < start:
            end = start

        normalized.append(
            {
                "speaker": speaker,
                "text": text,
                "start": start,
                "end": end,
                "duration": max(0.0, end - start),
            }
        )

    return normalized


def _candidate_key(candidate: Mapping[str, Any]) -> str:
    user_id = str(candidate.get("user_id") or "").strip()
    if user_id:
        return f"user:{user_id}"

    email = str(candidate.get("email") or "").strip().lower()
    if email:
        return f"email:{email}"

    name = _normalize_name(str(candidate.get("name") or ""))
    return f"name:{name}"


def _build_name_indexes(
    attendee_candidates: Sequence[Mapping[str, Any]],
) -> tuple[Dict[str, List[Mapping[str, Any]]], Dict[str, List[Mapping[str, Any]]]]:
    full_name_index: Dict[str, List[Mapping[str, Any]]] = {}
    first_name_index: Dict[str, List[Mapping[str, Any]]] = {}

    for candidate in attendee_candidates:
        name = str(candidate.get("name") or "").strip()
        if not name:
            continue

        full = _normalize_name(name)
        first = _first_name(name)

        if full:
            full_name_index.setdefault(full, []).append(candidate)

        if first:
            first_name_index.setdefault(first, []).append(candidate)

    return full_name_index, first_name_index


def _resolve_name_to_candidate(
    raw_name: str,
    full_name_index: Mapping[str, Sequence[Mapping[str, Any]]],
    first_name_index: Mapping[str, Sequence[Mapping[str, Any]]],
) -> Optional[Mapping[str, Any]]:
    full = _normalize_name(raw_name)
    if not full:
        return None

    direct = list(full_name_index.get(full, []))
    if len(direct) == 1:
        return direct[0]

    first = full.split(" ")[0]
    first_matches = list(first_name_index.get(first, []))
    if len(first_matches) == 1:
        return first_matches[0]

    return None


def _collect_text_values(obj: Any) -> List[str]:
    collected: List[str] = []

    if isinstance(obj, Mapping):
        for key, value in obj.items():
            if isinstance(value, str) and key.lower() in {"text", "content"}:
                stripped = value.strip()
                if stripped:
                    collected.append(stripped)
            else:
                collected.extend(_collect_text_values(value))
    elif isinstance(obj, list):
        for item in obj:
            collected.extend(_collect_text_values(item))

    return collected


def _extract_frame_to_jpeg(
    *,
    input_media: str,
    timestamp_seconds: float,
    output_jpeg: Path,
) -> None:
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{max(timestamp_seconds, 0.0):.3f}",
        "-i",
        input_media,
        "-frames:v",
        "1",
        "-q:v",
        "2",
        str(output_jpeg),
    ]
    subprocess.run(cmd, check=True)


def _run_azure_ocr(
    *,
    endpoint: str,
    api_key: str,
    image_path: Path,
    timeout_seconds: int,
) -> List[str]:
    url = endpoint.rstrip("/") + "/computervision/imageanalysis:analyze"
    params = {"api-version": "2023-10-01", "features": "read", "language": "en"}
    headers = {
        "Ocp-Apim-Subscription-Key": api_key,
        "Content-Type": "application/octet-stream",
    }

    with open(image_path, "rb") as f:
        response = requests.post(
            url,
            params=params,
            headers=headers,
            data=f.read(),
            timeout=timeout_seconds,
        )
    response.raise_for_status()

    payload = response.json()
    return _collect_text_values(payload)


def _match_names_from_texts(
    *,
    texts: Sequence[str],
    attendee_candidates: Sequence[Mapping[str, Any]],
) -> List[str]:
    matches: List[str] = []
    seen: set[str] = set()

    normalized_texts = [_normalize_name(text) for text in texts if text]
    for candidate in attendee_candidates:
        display_name = str(candidate.get("name") or "").strip()
        if not display_name:
            continue

        full = _normalize_name(display_name)
        first = _first_name(display_name)
        if not full:
            continue

        matched = False
        for text in normalized_texts:
            if not text:
                continue
            if full in text:
                matched = True
                break

            if first and len(first) >= 3 and re.search(rf"\b{re.escape(first)}\b", text):
                matched = True
                break

        if matched and display_name not in seen:
            seen.add(display_name)
            matches.append(display_name)

    return matches


def _dedupe_keep_order(values: Iterable[str]) -> List[str]:
    deduped: List[str] = []
    seen: set[str] = set()
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        deduped.append(value)
    return deduped


def _select_frame_samples(
    *,
    segments: Sequence[Mapping[str, Any]],
    max_frames: int,
    min_segment_seconds: float,
) -> List[Dict[str, Any]]:
    candidates: List[Dict[str, Any]] = []
    for segment in segments:
        speaker = str(segment.get("speaker") or "").strip()
        if not speaker:
            continue
        start = _to_float(segment.get("start"), 0.0)
        end = _to_float(segment.get("end"), start)
        if end < start:
            end = start
        duration = max(0.0, end - start)
        if duration < min_segment_seconds:
            continue
        midpoint = start + duration / 2.0
        candidates.append(
            {
                "speaker": speaker,
                "timestamp": midpoint,
                "duration": duration,
            }
        )

    if not candidates:
        return []

    # Favor longer segments first for cleaner active-speaker overlays.
    candidates.sort(key=lambda item: item["duration"], reverse=True)

    selected: List[Dict[str, Any]] = []
    per_speaker_counts: Dict[str, int] = {}
    unique_speakers = {item["speaker"] for item in candidates}
    per_speaker_cap = max(1, max_frames // max(1, len(unique_speakers)))

    for item in candidates:
        if len(selected) >= max_frames:
            break
        speaker = item["speaker"]
        if per_speaker_counts.get(speaker, 0) >= per_speaker_cap:
            continue
        per_speaker_counts[speaker] = per_speaker_counts.get(speaker, 0) + 1
        selected.append(item)

    return selected


@dataclass(frozen=True)
class VisualAugmentationConfig:
    enabled: bool
    endpoint: Optional[str] = None
    api_key: Optional[str] = None
    max_frames: int = 12
    min_segment_seconds: float = 2.0
    timeout_seconds: int = 20


def _is_au_endpoint(endpoint: str) -> bool:
    hostname = (urlparse(endpoint).hostname or "").lower()
    return "australiaeast" in hostname or "australiasoutheast" in hostname


def load_visual_augmentation_config_from_env(*, logger=None) -> VisualAugmentationConfig:
    def _log_warning(msg: str, *args: Any) -> None:
        if logger is not None:
            logger.warning(msg, *args)

    def _parse_int(name: str, default: int, min_value: int) -> int:
        raw = os.getenv(name)
        if raw is None or raw.strip() == "":
            return default
        try:
            value = int(raw)
        except ValueError:
            _log_warning("Invalid %s=%r; using default=%s", name, raw, default)
            return default
        if value < min_value:
            _log_warning(
                "%s=%s below minimum %s; using default=%s",
                name,
                value,
                min_value,
                default,
            )
            return default
        return value

    def _parse_float(name: str, default: float, min_value: float) -> float:
        raw = os.getenv(name)
        if raw is None or raw.strip() == "":
            return default
        try:
            value = float(raw)
        except ValueError:
            _log_warning("Invalid %s=%r; using default=%s", name, raw, default)
            return default
        if value < min_value:
            _log_warning(
                "%s=%s below minimum %s; using default=%s",
                name,
                value,
                min_value,
                default,
            )
            return default
        return value

    enabled_raw = os.getenv("SPEAKER_VISUAL_AUGMENTATION_ENABLED", "false").strip().lower()
    enabled = enabled_raw in {"1", "true", "yes", "y", "on"}
    if not enabled:
        return VisualAugmentationConfig(enabled=False)

    endpoint = (os.getenv("AZURE_VISION_ENDPOINT") or "").strip()
    api_key = (os.getenv("AZURE_VISION_KEY") or "").strip()
    if not endpoint or not api_key:
        _log_warning(
            "Visual speaker augmentation disabled: AZURE_VISION_ENDPOINT/AZURE_VISION_KEY missing"
        )
        return VisualAugmentationConfig(enabled=False)

    if not _is_au_endpoint(endpoint):
        _log_warning(
            "Visual speaker augmentation disabled: AZURE_VISION_ENDPOINT must be AU regional"
        )
        return VisualAugmentationConfig(enabled=False)

    max_frames = _parse_int("SPEAKER_VISUAL_MAX_FRAMES", 12, 1)
    min_segment_seconds = _parse_float("SPEAKER_VISUAL_MIN_SEGMENT_SECONDS", 2.0, 0.2)
    timeout_seconds = _parse_int("SPEAKER_VISUAL_OCR_TIMEOUT_SECONDS", 20, 5)

    return VisualAugmentationConfig(
        enabled=True,
        endpoint=endpoint,
        api_key=api_key,
        max_frames=max_frames,
        min_segment_seconds=min_segment_seconds,
        timeout_seconds=timeout_seconds,
    )


def collect_visual_name_evidence(
    *,
    recording_path: str,
    segments: Sequence[Mapping[str, Any]],
    attendee_candidates: Sequence[Mapping[str, Any]],
    config: VisualAugmentationConfig,
    logger=None,
) -> Dict[str, List[str]]:
    if not config.enabled:
        return {}
    if not recording_path or not os.path.exists(recording_path):
        return {}
    if not attendee_candidates:
        return {}
    if not segments:
        return {}

    samples = _select_frame_samples(
        segments=segments,
        max_frames=config.max_frames,
        min_segment_seconds=config.min_segment_seconds,
    )
    if not samples:
        return {}

    tmp_dir = Path(tempfile.mkdtemp(prefix="speaker_frames_"))
    evidence_by_speaker: Dict[str, List[str]] = {}

    try:
        for idx, sample in enumerate(samples):
            frame_path = tmp_dir / f"frame_{idx:03d}.jpg"
            speaker = str(sample.get("speaker") or "").strip()
            timestamp = _to_float(sample.get("timestamp"), 0.0)
            if not speaker:
                continue

            try:
                _extract_frame_to_jpeg(
                    input_media=recording_path,
                    timestamp_seconds=timestamp,
                    output_jpeg=frame_path,
                )
                texts = _run_azure_ocr(
                    endpoint=config.endpoint or "",
                    api_key=config.api_key or "",
                    image_path=frame_path,
                    timeout_seconds=config.timeout_seconds,
                )
                hits = _match_names_from_texts(
                    texts=texts,
                    attendee_candidates=attendee_candidates,
                )
                if hits:
                    evidence_by_speaker.setdefault(speaker, []).extend(hits)
            except (subprocess.CalledProcessError, requests.RequestException, ValueError) as exc:
                if logger is not None:
                    logger.warning(
                        "Visual speaker evidence sample failed: speaker=%s, ts=%.3f, error=%s",
                        speaker,
                        timestamp,
                        exc,
                    )
            finally:
                try:
                    frame_path.unlink(missing_ok=True)
                except OSError:
                    pass
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return {
        speaker: _dedupe_keep_order(names)
        for speaker, names in evidence_by_speaker.items()
    }


def build_speaker_metadata(
    *,
    transcript_payload: Mapping[str, Any],
    attendee_candidates: Sequence[Mapping[str, Any]],
    visual_name_evidence: Optional[Mapping[str, Sequence[str]]] = None,
    min_confidence: float = 0.85,
) -> Dict[str, Any]:
    segments = _normalize_segments(transcript_payload)
    speaker_stats: Dict[str, Dict[str, Any]] = {}

    for segment in segments:
        speaker = segment["speaker"]
        stat = speaker_stats.setdefault(
            speaker,
            {
                "label": speaker,
                "utterance_count": 0,
                "speaking_seconds": 0.0,
                "first_timestamp": None,
                "last_timestamp": None,
            },
        )
        stat["utterance_count"] += 1
        stat["speaking_seconds"] += float(segment["duration"])
        start = float(segment["start"])
        end = float(segment["end"])

        if stat["first_timestamp"] is None or start < stat["first_timestamp"]:
            stat["first_timestamp"] = start
        if stat["last_timestamp"] is None or end > stat["last_timestamp"]:
            stat["last_timestamp"] = end

    full_name_index, first_name_index = _build_name_indexes(attendee_candidates)
    scores_by_speaker: Dict[str, Dict[str, Dict[str, Any]]] = {
        speaker: {} for speaker in speaker_stats
    }

    def _add_evidence(
        *,
        speaker: str,
        candidate: Mapping[str, Any],
        score_delta: float,
        evidence_type: str,
    ) -> None:
        key = _candidate_key(candidate)
        entry = scores_by_speaker.setdefault(speaker, {}).setdefault(
            key,
            {
                "candidate": candidate,
                "score": 0.0,
                "evidence": [],
            },
        )
        entry["score"] = min(1.0, float(entry["score"]) + score_delta)
        entry["evidence"].append(evidence_type)

    for segment in segments:
        speaker = segment["speaker"]
        text = segment["text"]
        if not text:
            continue

        for match in SELF_INTRO_RE.finditer(text):
            candidate = _resolve_name_to_candidate(
                match.group(1),
                full_name_index=full_name_index,
                first_name_index=first_name_index,
            )
            if candidate is not None:
                _add_evidence(
                    speaker=speaker,
                    candidate=candidate,
                    score_delta=0.9,
                    evidence_type="self_identification",
                )

    for speaker, names in (visual_name_evidence or {}).items():
        if speaker not in speaker_stats:
            continue
        for raw_name in names:
            candidate = _resolve_name_to_candidate(
                raw_name,
                full_name_index=full_name_index,
                first_name_index=first_name_index,
            )
            if candidate is not None:
                _add_evidence(
                    speaker=speaker,
                    candidate=candidate,
                    score_delta=0.22,
                    evidence_type="visual_ocr",
                )

    speakers_output: List[Dict[str, Any]] = []
    unresolved: List[str] = []

    for speaker, stat in speaker_stats.items():
        speaker_row = {
            "label": stat["label"],
            "utterance_count": int(stat["utterance_count"]),
            "speaking_seconds": round(float(stat["speaking_seconds"]), 3),
            "first_timestamp": round(float(stat["first_timestamp"] or 0.0), 3),
            "last_timestamp": round(float(stat["last_timestamp"] or 0.0), 3),
        }

        candidates = list(scores_by_speaker.get(speaker, {}).values())
        candidates.sort(key=lambda item: float(item["score"]), reverse=True)
        if candidates:
            top = candidates[0]
            second_score = float(candidates[1]["score"]) if len(candidates) > 1 else 0.0
            top_score = float(top["score"])
            if top_score >= min_confidence and (top_score - second_score) >= 0.15:
                candidate = top["candidate"]
                speaker_row["identity"] = {
                    "display_name": str(candidate.get("name") or "").strip(),
                    "email": str(candidate.get("email") or "").strip() or None,
                    "user_id": str(candidate.get("user_id") or "").strip() or None,
                    "confidence": round(top_score, 3),
                    "evidence": _dedupe_keep_order(top.get("evidence", [])),
                }
            else:
                unresolved.append(speaker)
        else:
            unresolved.append(speaker)

        if speaker in (visual_name_evidence or {}):
            speaker_row["visual_name_candidates"] = _dedupe_keep_order(
                [str(name).strip() for name in (visual_name_evidence or {}).get(speaker, [])]
            )

        speakers_output.append(speaker_row)

    speakers_output.sort(key=lambda item: (item.get("first_timestamp", 0.0), item["label"]))

    return {
        "speaker_count": len(speaker_stats),
        "speakers": speakers_output,
        "unresolved_speakers": sorted(unresolved),
        "identity_confidence_threshold": min_confidence,
        "attendee_candidates_count": len(attendee_candidates),
        "visual_evidence_used": bool(visual_name_evidence),
        "engine": transcript_payload.get("engine") or transcript_payload.get("model"),
        "diarization": transcript_payload.get("diarization") or {},
    }
