#!/usr/bin/env python3
"""Offline transcription + diarization (CPU) using whisper.cpp.

This script is intended for local/VM usage (not Docker yet).

Pipeline:
1) Accept an input audio/video source (local path or gs:// URI)
2) If gs://, download locally via GCS APIs (no signed URL needed)
3) Convert to 16kHz mono WAV for whisper.cpp
4) Run whisper.cpp to produce a timestamped transcript
5) Run offline diarization by clustering speaker embeddings and label speakers
   as Speaker A/B/C...

Notes:
- This is designed to be fully offline once you have:
  - whisper.cpp binary built locally
  - a ggml whisper model downloaded (e.g. ggml-base.en.bin)
  - embedding model weights cached (SpeechBrain) if you enable diarization
"""

# pyright: reportMissingTypeStubs=false

# type: ignore

from __future__ import annotations

# ---------------------------------------------------------------------------
# Compatibility shims (torchaudio / SpeechBrain / huggingface_hub)
# ---------------------------------------------------------------------------
# Some torchaudio builds (e.g. 2.9.x wheels) removed backend APIs like
# `list_audio_backends`, which SpeechBrain calls at import time.
#
# IMPORTANT: Do not import SpeechBrain at module import-time in this script.
# Apply the shim via `_ensure_torchaudio_compat()` immediately before importing
# SpeechBrain.


# Older SpeechBrain versions can call `huggingface_hub.hf_hub_download` with
# removed kwargs (e.g. `use_auth_token`). We patch hf_hub_download to be
# tolerant of those kwargs.
try:  # pragma: no cover
    import huggingface_hub  # type: ignore

    _orig_hf_hub_download = getattr(huggingface_hub, "hf_hub_download", None)

    if _orig_hf_hub_download is not None:

        def _hf_hub_download_compat(*args, **kwargs):
            kwargs.pop("use_auth_token", None)
            return _orig_hf_hub_download(*args, **kwargs)

        huggingface_hub.hf_hub_download = _hf_hub_download_compat  # type: ignore
except Exception:
    pass

import argparse
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import datetime as _datetime
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Reuse the production pipeline implementation.
from manager.offline_pipeline import (  # type: ignore
    Segment,
    diarize_segments_offline,
    ffmpeg_to_wav16k_mono as _ffmpeg_to_wav16k_mono,
    resolve_whisper_paths,
    run_whisper_cpp,
)


def _ensure_torchaudio_compat() -> None:
    """Ensure torchaudio exposes legacy backend APIs SpeechBrain expects."""

    try:  # pragma: no cover
        import torchaudio  # type: ignore

        if not hasattr(torchaudio, "list_audio_backends"):
            torchaudio.list_audio_backends = lambda: []  # type: ignore[attr-defined]
        if not hasattr(torchaudio, "get_audio_backend"):
            torchaudio.get_audio_backend = lambda: None  # type: ignore[attr-defined]
        if not hasattr(torchaudio, "set_audio_backend"):
            torchaudio.set_audio_backend = (  # type: ignore[attr-defined]
                lambda _backend=None: None
            )
    except Exception:
        pass


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("whisper_diarize")

# Python 3.11+ has `datetime.UTC`. Support older runtimes (e.g. Ubuntu 20.04
# ships Python 3.8) by using `timezone.utc`.
UTC = getattr(_datetime, "UTC", timezone.utc)


SPEAKER_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WHISPER_DIR = REPO_ROOT / "tools" / "whisper.cpp"
DEFAULT_WHISPER_BIN = DEFAULT_WHISPER_DIR / "build" / "bin" / "whisper-cli"
DEFAULT_WHISPER_MODEL = DEFAULT_WHISPER_DIR / "models" / "ggml-base.en.bin"

"""NOTE: the Segment dataclass and core pipeline functions now live in
`manager/offline_pipeline.py` to be callable from production code.
"""


def _merge_segments_for_diarization(
    segments: List[Segment],
    min_seconds: float = 2.5,
    max_seconds: float = 12.0,
    max_gap_seconds: float = 0.8,
) -> List[Tuple[float, float, List[int]]]:
    """Merge short whisper segments into embedding windows.

    Returns windows as (start, end, segment_indexes).
    """
    if not segments:
        return []

    windows: List[Tuple[float, float, List[int]]] = []
    cur_start = segments[0].start
    cur_end = segments[0].end
    cur_idxs: List[int] = [0]

    for idx in range(1, len(segments)):
        s = segments[idx]
        gap = max(0.0, s.start - cur_end)
        proposed_end = max(cur_end, s.end)
        proposed_dur = proposed_end - cur_start

        should_break = False
        if gap > max_gap_seconds:
            should_break = True
        elif proposed_dur > max_seconds and (cur_end - cur_start) >= min_seconds:
            should_break = True

        if should_break:
            windows.append((cur_start, cur_end, cur_idxs))
            cur_start, cur_end, cur_idxs = s.start, s.end, [idx]
        else:
            cur_end = proposed_end
            cur_idxs.append(idx)

    windows.append((cur_start, cur_end, cur_idxs))

    # Ensure minimum duration by merging tiny trailing windows backward.
    merged: List[Tuple[float, float, List[int]]] = []
    for w in windows:
        if merged and (w[1] - w[0]) < min_seconds:
            ps, pe, pidxs = merged[-1]
            merged[-1] = (ps, w[1], pidxs + w[2])
        else:
            merged.append(w)

    return merged


def _extract_wav_window(src_wav: Path, start: float, end: float) -> Path:
    """Extract [start,end] from a WAV into a temp file using ffmpeg."""
    if end <= start:
        raise ValueError("Invalid window")
    out_path = Path(tempfile.mkstemp(prefix="spkwin_", suffix=".wav")[1])
    cmd = [
        "ffmpeg",
        "-y",
        "-ss",
        f"{start:.3f}",
        "-to",
        f"{end:.3f}",
        "-i",
        str(src_wav),
        "-ac",
        "1",
        "-ar",
        "16000",
        str(out_path),
    ]
    _run(cmd)
    return out_path


def _cluster_speakers(embeddings, max_speakers: int) -> Tuple[int, List[int]]:
    """Choose k via silhouette score and cluster into labels.

    Returns (k, labels_per_embedding)
    """
    from sklearn.cluster import AgglomerativeClustering
    from sklearn.metrics import silhouette_score
    import numpy as np

    X = np.asarray(embeddings, dtype=np.float32)
    if X.ndim != 2 or X.shape[0] < 2:
        return 1, [0] * int(X.shape[0])

    best_k = 1
    best_score = -1.0
    best_labels = [0] * X.shape[0]

    upper = min(max_speakers, X.shape[0])
    # With meetings mostly 2-4, we search small k first.
    for k in range(2, upper + 1):
        try:
            clustering = AgglomerativeClustering(n_clusters=k)
            labels = clustering.fit_predict(X)
            # Silhouette requires >1 cluster and no empty clusters.
            score = silhouette_score(X, labels)
            if score > best_score:
                best_score = float(score)
                best_k = k
                best_labels = labels.tolist()
        except Exception:
            continue

    if best_k == 1:
        return 1, [0] * X.shape[0]
    return best_k, best_labels


# Core diarization implementation moved to manager/offline_pipeline.py


def _run(cmd: List[str]) -> None:
    logger.debug("Running: %s", " ".join(cmd))
    subprocess.run(cmd, check=True)


def _which(binary: str) -> Optional[str]:
    return shutil.which(binary)


def _download_gcs_uri(gcs_uri: str, out_path: Path) -> None:
    # Import lazily so users without GCS needs don't require deps.
    from google.cloud import storage

    if not gcs_uri.startswith("gs://"):
        raise ValueError("Expected gs:// URI")

    without_scheme = gcs_uri[len("gs://") :]
    bucket_name, _, blob_path = without_scheme.partition("/")
    if not bucket_name or not blob_path:
        raise ValueError("Invalid gs:// URI")

    client = storage.Client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(blob_path)

    logger.info("Downloading %s -> %s", gcs_uri, out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    blob.download_to_filename(str(out_path))


# Core pipeline functions were moved to manager/offline_pipeline.py


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Offline transcription + diarization using whisper.cpp"
    )
    parser.add_argument(
        "--input",
        required=True,
        help="Local path or gs:// URI to the recording (webm/mp4/wav/etc)",
    )
    parser.add_argument(
        "--out-dir",
        default=str(Path.cwd() / "test-results" / "local-transcripts"),
        help="Directory to write outputs",
    )

    parser.add_argument(
        "--whisper-bin",
        default=os.getenv(
            "WHISPER_CPP_BIN",
            str(DEFAULT_WHISPER_BIN) if DEFAULT_WHISPER_BIN.exists() else "whisper",
        ),
        help="Path to whisper.cpp binary (env: WHISPER_CPP_BIN)",
    )
    parser.add_argument(
        "--model",
        default=os.getenv(
            "WHISPER_CPP_MODEL",
            (str(DEFAULT_WHISPER_MODEL) if DEFAULT_WHISPER_MODEL.exists() else ""),
        ),
        help="Path to ggml model file (env: WHISPER_CPP_MODEL)",
    )
    parser.add_argument("--language", default="en")

    parser.add_argument(
        "--skip-transcribe",
        action="store_true",
        help=(
            "Skip whisper.cpp and only run diarization/output generation "
            "using the cached SRT in the temp workspace (useful for dev/debug)"
        ),
    )

    # Diarization controls (implemented next)
    parser.add_argument(
        "--diarize",
        action="store_true",
        help="Enable offline speaker diarization (Speaker A/B/C...)",
    )
    parser.add_argument(
        "--max-speakers",
        type=int,
        default=6,
        help="Upper bound for auto-detected speakers",
    )

    args = parser.parse_args()

    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        whisper_bin, model_path = resolve_whisper_paths(
            whisper_bin=args.whisper_bin,
            model_path=args.model,
        )
    except Exception as e:
        raise SystemExit(str(e))

    tmp_root = Path(tempfile.mkdtemp(prefix="whisper_diarize_"))
    try:
        src_path = tmp_root / "input"
        if args.input.startswith("gs://"):
            # Keep original filename if possible
            name = Path(args.input.split("/")[-1]).name or "recording"
            src_path = tmp_root / name
            _download_gcs_uri(args.input, src_path)
        else:
            src_path = Path(args.input).expanduser().resolve()
            if not src_path.exists():
                raise SystemExit(f"Input file not found: {src_path}")

        wav_path = tmp_root / "audio_16k_mono.wav"
        logger.info("Converting to 16kHz mono WAV for whisper.cpp...")
        try:
            _ffmpeg_to_wav16k_mono(src_path, wav_path)
        except RuntimeError as e:
            logger.error(str(e))
            return 2

        # Use a stable id for filenames
        meeting_id = src_path.stem
        timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        base_name = f"{meeting_id}_{timestamp}_whispercpp"

        whisper_out_dir = tmp_root / "whisper"
        if args.skip_transcribe:
            srt_path = whisper_out_dir / "audio_16k_mono.srt"
            if not srt_path.exists():
                raise SystemExit(
                    "--skip-transcribe was set but no cached SRT was found at "
                    f"{srt_path}. Re-run once without --skip-transcribe first."
                )
            # Re-parse cached SRT via the shared parser.
            from manager.offline_pipeline import (  # type: ignore
                _parse_whisper_srt,
            )

            segments = _parse_whisper_srt(srt_path)
        else:
            logger.info("Running whisper.cpp transcription...")
            _, segments, _ = run_whisper_cpp(
                whisper_bin=whisper_bin,
                model_path=model_path,
                wav_path=wav_path,
                out_dir=whisper_out_dir,
                language=args.language,
            )

        diarization_info: Dict[str, Any] = {
            "enabled": bool(args.diarize),
            "max_speakers": args.max_speakers,
            "detected_speakers": None,
        }
        if args.diarize:
            try:
                detected, segments = diarize_segments_offline(
                    wav_path=wav_path,
                    segments=segments,
                    max_speakers=args.max_speakers,
                    model_dir=(
                        REPO_ROOT / "tools" / "speechbrain" / "spkrec-ecapa-voxceleb"
                    ),
                )
                diarization_info["detected_speakers"] = detected
            except Exception as e:
                logger.warning(
                    "Diarization failed; continuing without it: %s",
                    e,
                )
                diarization_info["enabled"] = False

        # Write outputs
        txt_path = out_dir / f"{base_name}.txt"
        json_path = out_dir / f"{base_name}.json"

        transcript_lines: List[str] = []
        for s in segments:
            speaker_prefix = f"{s.speaker}: " if s.speaker else ""
            transcript_lines.append(
                f"[{s.start:0.2f}-{s.end:0.2f}] {speaker_prefix}{s.text}"
            )
        transcript_text = "\n".join(transcript_lines)
        txt_path.write_text(transcript_text, encoding="utf-8")

        payload: Dict[str, Any] = {
            "engine": "whisper.cpp",
            "model": str(model_path),
            "language": args.language,
            "diarization": diarization_info,
            "segments": [
                {
                    "start": s.start,
                    "end": s.end,
                    "speaker": s.speaker,
                    "text": s.text,
                }
                for s in segments
            ],
            "transcript": " ".join([s.text for s in segments]).strip(),
        }
        json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

        logger.info("Wrote %s", txt_path)
        logger.info("Wrote %s", json_path)
        return 0
    finally:
        # Keep temp dir if debugging is needed.
        # shutil.rmtree(tmp_root, ignore_errors=True)
        pass


if __name__ == "__main__":
    raise SystemExit(main())
