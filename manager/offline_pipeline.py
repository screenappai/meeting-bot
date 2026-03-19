"""Offline transcription + diarization pipeline used by the manager.

This module is the production-friendly counterpart to
`scripts/whisper_diarize.py`.

Contract
- Input: local media file path (webm/mp4/m4a/wav/etc)
- Output: ``(txt_path, json_path)`` containing speaker-labelled segments when
    diarization is enabled.

Notes
- whisper.cpp binary and model are expected to exist in the container.
- SpeechBrain model directory is expected to be available locally to keep this
    fully offline.
"""

# pyright: reportMissingTypeStubs=false

# type: ignore

from __future__ import annotations

import datetime as _datetime
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


def _normalize_text_for_dedupe(text: str) -> str:
    """Normalize transcription text for de-duplication comparisons."""

    return " ".join(text.strip().split()).lower()


def _dedupe_repeated_segments(
    segments: List[Segment],
    *,
    lookback: int = 80,
) -> List[Segment]:
    """Drop repeated segments that often show up at the end of transcripts.

    We've seen a whisper.cpp/SRT edge case where trailing subtitle entries are
    duplicated many times. We keep the first (oldest) occurrence and drop later
    duplicates, preserving original ordering.

    The `lookback` limit keeps this linear-time and focused on the common tail
    repetition pattern, while still being safe for long meetings.
    """

    if len(segments) < 2:
        return segments

    # 1) First, remove *consecutive* duplicates (common when SRT repeats tail
    #    lines over and over). This is order-preserving and keeps the earliest.
    collapsed: List[Segment] = []
    prev_key: Optional[tuple[str, Optional[str]]] = None
    for s in segments:
        key = (_normalize_text_for_dedupe(s.text), s.speaker)
        if prev_key is not None and key == prev_key:
            continue
        collapsed.append(s)
        prev_key = key

    if len(collapsed) < 2:
        return collapsed

    # 2) Then, within a limited lookback window, drop re-occurrences of the
    #    same (speaker,text). This catches cases where multiple tail blocks
    #    repeat.
    start_idx = max(0, len(collapsed) - lookback)
    seen: set[tuple[str, Optional[str]]] = set()
    out: List[Segment] = []

    for i, s in enumerate(collapsed):
        if i < start_idx:
            out.append(s)
            continue

        key = (_normalize_text_for_dedupe(s.text), s.speaker)
        if key in seen:
            continue
        seen.add(key)
        out.append(s)

    return out


def _segments_to_markdown(segments: List[Segment]) -> str:
    """Convert segments into speaker-grouped markdown.

    Output format (blank line between speakers blocks):

      **Speaker A:** first sentence. second sentence.

      **Speaker B:** ...
    """

    lines: List[str] = []

    cur_speaker: Optional[str] = None
    cur_text: List[str] = []

    def _flush():
        nonlocal cur_speaker, cur_text
        if not cur_text:
            return
        speaker = cur_speaker or "Unknown"
        text = " ".join(t.strip() for t in cur_text if t.strip()).strip()
        if text:
            lines.append(f"**{speaker}:** {text}")
        cur_text = []

    for s in segments:
        speaker = s.speaker or "Unknown"
        if cur_speaker is None:
            cur_speaker = speaker
        if speaker != cur_speaker:
            _flush()
            lines.append("")
            cur_speaker = speaker

        cur_text.append(s.text)

    _flush()

    return "\n".join(lines).strip() + "\n"


def _format_vtt_timestamp(seconds: float) -> str:
    """Format seconds as a WebVTT timestamp (HH:MM:SS.mmm)."""

    if seconds < 0:
        seconds = 0.0
    millis = int(round(seconds * 1000.0))
    hrs, rem = divmod(millis, 3600 * 1000)
    mins, rem = divmod(rem, 60 * 1000)
    secs, ms = divmod(rem, 1000)
    return f"{hrs:02d}:{mins:02d}:{secs:02d}.{ms:03d}"


def _escape_vtt_text(text: str) -> str:
    """Escape text for safe WebVTT cues.

    WebVTT cue payload is text; the only strict requirement we enforce is that
    it must not contain blank lines inside a cue.
    """

    # Collapse internal whitespace/newlines to keep one cue = one paragraph.
    return " ".join(text.strip().split())


def _segments_to_webvtt(segments: List[Segment]) -> str:
    """Convert segments into a WebVTT file content."""

    out: List[str] = ["WEBVTT", ""]
    cue_idx = 1
    for s in segments:
        text = _escape_vtt_text(s.text)
        if not text:
            continue

        start = _format_vtt_timestamp(s.start)
        end = _format_vtt_timestamp(s.end)
        speaker = (s.speaker or "").strip()
        prefix = f"{speaker}: " if speaker else ""

        out.append(str(cue_idx))
        out.append(f"{start} --> {end}")
        out.append(prefix + text)
        out.append("")
        cue_idx += 1

    return "\n".join(out).rstrip() + "\n"


def _patch_speechbrain_hyperparams_for_local_model(model_dir: Path) -> None:
    """Make SpeechBrain hyperparams.yaml use local files instead of HF hub.

    The upstream SpeechBrain model ships with:
      pretrained_path: speechbrain/spkrec-ecapa-voxceleb

    When we call EncoderClassifier.from_hparams(source=<local dir>),
    SpeechBrain still uses `pretrained_path` to resolve files, and if it's a HF
    repo id it will try hf_hub_download even when the files exist locally.

    We patch `pretrained_path` to point at `model_dir` so all assets resolve
    locally and offline runs don't touch the network.
    """

    hp = model_dir / "hyperparams.yaml"
    if not hp.exists():
        return

    txt = hp.read_text(encoding="utf-8")

    # Only patch when the hyperparams are still pointing at the HF repo id.
    # Keep this conservative to avoid surprising edits.
    if "pretrained_path: speechbrain/spkrec-ecapa-voxceleb" not in txt:
        return

    patched = txt.replace(
        "pretrained_path: speechbrain/spkrec-ecapa-voxceleb",
        f"pretrained_path: {model_dir}",
    )
    hp.write_text(patched, encoding="utf-8")


def _make_writable_hyperparams_overlay(*, baked_model_dir: Path) -> Path:
    """Create a small writable 'overlay' dir for SpeechBrain hyperparams.

    Why: In k8s jobs with tight ephemeral storage, copying the whole
    SpeechBrain model directory (~tens of MB) into /tmp per run is wasteful.

    Approach: We only write a patched `hyperparams.yaml` into a temp directory,
    and point `pretrained_path` at the baked model directory so checkpoints
    resolve locally.

    Returns:
        overlay_dir
    """

    hp_src = baked_model_dir / "hyperparams.yaml"
    if not hp_src.exists():
        raise RuntimeError(f"Missing hyperparams.yaml at {hp_src}")

    overlay_dir = Path(tempfile.mkdtemp(prefix="speechbrain_hp_"))
    hp_dst = overlay_dir / "hyperparams.yaml"

    txt = hp_src.read_text(encoding="utf-8")
    # Patch only if still pointing to the HF repo id.
    if "pretrained_path: speechbrain/spkrec-ecapa-voxceleb" in txt:
        txt = txt.replace(
            "pretrained_path: speechbrain/spkrec-ecapa-voxceleb",
            f"pretrained_path: {baked_model_dir}",
        )
    hp_dst.write_text(txt, encoding="utf-8")
    return overlay_dir


UTC = getattr(_datetime, "UTC", timezone.utc)
SPEAKER_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


# When running in-repo, this file lives at "manager/offline_pipeline.py" and
# repo root is parents[1]. In the Docker image, we COPY manager/ into /app, so
# this file becomes "/app/offline_pipeline.py" and repo root is the file's
# parent directory.
_this_file = Path(__file__).resolve()
REPO_ROOT = (
    _this_file.parents[1] if _this_file.parent.name == "manager" else _this_file.parent
)
DEFAULT_WHISPER_DIR = REPO_ROOT / "tools" / "whisper.cpp"
DEFAULT_WHISPER_BIN = DEFAULT_WHISPER_DIR / "build" / "bin" / "whisper-cli"
DEFAULT_WHISPER_MODEL = DEFAULT_WHISPER_DIR / "models" / "ggml-base.en.bin"
DEFAULT_SPEECHBRAIN_MODEL_DIR = (
    REPO_ROOT / "tools" / "speechbrain" / "spkrec-ecapa-voxceleb"
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


@dataclass
class Segment:
    start: float
    end: float
    text: str
    speaker: Optional[str] = None


def _run(cmd: List[str]) -> None:
    logger.debug("Running: %s", " ".join(cmd))
    subprocess.run(cmd, check=True)


def _run_capture_output(cmd: List[str]) -> str:
    logger.debug("Running (capture): %s", " ".join(cmd))
    completed = subprocess.run(
        cmd,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    output = completed.stdout or ""
    if completed.returncode != 0:
        raise subprocess.CalledProcessError(
            returncode=completed.returncode,
            cmd=cmd,
            output=output,
        )
    return output


def _compose_whisper_ld_library_path(existing: Optional[str]) -> str:
    """Build an LD_LIBRARY_PATH that prioritizes whisper + system CUDA paths.

    AKS GPU workloads can inject a default LD_LIBRARY_PATH that prefers Mesa paths.
    For whisper.cpp CUDA runs we explicitly prioritize whisper's shared libraries
    and system CUDA loader directories first, while preserving any existing entries.
    """

    preferred_paths = [
        "/app/tools/whisper.cpp/build/src",
        "/app/tools/whisper.cpp/build/ggml/src",
        "/usr/local/nvidia/lib64",
        "/usr/lib/x86_64-linux-gnu",
        "/lib/x86_64-linux-gnu",
        "/usr/lib/aarch64-linux-gnu",
        "/lib/aarch64-linux-gnu",
        "/usr/lib64",
        "/lib64",
    ]

    ordered: List[str] = []
    seen: set[str] = set()

    for path in preferred_paths:
        if not Path(path).exists() or path in seen:
            continue
        seen.add(path)
        ordered.append(path)

    if existing:
        for path in existing.split(":"):
            candidate = path.strip()
            if not candidate or candidate in seen:
                continue
            seen.add(candidate)
            ordered.append(candidate)

    return ":".join(ordered)


@contextmanager
def _temporary_env(updates: Dict[str, str]):
    previous: Dict[str, Optional[str]] = {}
    for key, value in updates.items():
        previous[key] = os.environ.get(key)
        os.environ[key] = value
    try:
        yield
    finally:
        for key, prior in previous.items():
            if prior is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = prior


def _which(binary: str) -> Optional[str]:
    return shutil.which(binary)


@lru_cache(maxsize=8)
def _whisper_cli_help(whisper_bin: str) -> str:
    """Return whisper-cli help output for runtime flag compatibility checks."""

    try:
        completed = subprocess.run(
            [whisper_bin, "--help"],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except Exception as exc:
        logger.debug("Unable to inspect whisper-cli flags for %s: %s", whisper_bin, exc)
        return ""

    return f"{completed.stdout}\n{completed.stderr}".lower()


def _whisper_cli_supports_flag(whisper_bin: Path, flag: str) -> bool:
    return flag.lower() in _whisper_cli_help(str(whisper_bin))


def _resolve_whisper_gpu_layers_flag(whisper_bin: Path) -> Optional[str]:
    if _whisper_cli_supports_flag(whisper_bin, "-ngl"):
        return "-ngl"
    if _whisper_cli_supports_flag(whisper_bin, "--gpu-layers"):
        return "--gpu-layers"
    return None


def _detect_whisper_gpu_backend_init(output: str) -> Optional[bool]:
    """Detect whether whisper.cpp initialized a real GPU backend.

    Returns:
    - True: output indicates non-CPU GPU backend initialization.
    - False: output indicates CPU/no-GPU initialization.
    - None: unknown (could not confidently detect from output).
    """

    if not output:
        return None

    lowered = output.lower()
    if "whisper_backend_init_gpu: no gpu found" in lowered:
        return False

    if re.search(
        r"whisper_backend_init_gpu:\s*device\s+\d+:\s*cpu\s*\(type:\s*0\)",
        output,
        flags=re.IGNORECASE,
    ):
        return False

    if re.search(
        r"whisper_backend_init_gpu:\s*device\s+\d+:\s*(?!cpu\b).+\(type:\s*[1-9]\d*\)",
        output,
        flags=re.IGNORECASE,
    ):
        return True

    return None


def _parse_bool_env(var_name: str, default: bool) -> bool:
    raw = os.getenv(var_name)
    if raw is None or raw.strip() == "":
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False
    logger.warning(
        "Invalid %s=%r; expected boolean value. Falling back to default=%s",
        var_name,
        raw,
        default,
    )
    return default


def _is_gpu_runtime_available() -> bool:
    """Best-effort check for CUDA runtime availability."""

    cuda_visible_devices = os.getenv("CUDA_VISIBLE_DEVICES")
    if cuda_visible_devices is not None and cuda_visible_devices.strip() in {
        "",
        "-1",
        "none",
    }:
        return False

    if Path("/dev/nvidiactl").exists():
        return True

    nvidia_smi = _which("nvidia-smi")
    if not nvidia_smi:
        return False

    try:
        subprocess.run(
            [nvidia_smi, "-L"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True
    except Exception:
        return False


def resolve_whisper_gpu_settings(
    *,
    use_gpu: Optional[bool] = None,
    gpu_layers: Optional[int] = None,
    require_gpu: Optional[bool] = None,
) -> Tuple[bool, Optional[int]]:
    """Resolve GPU settings for whisper.cpp with safe CPU fallback defaults."""

    gpu_requested = (
        use_gpu
        if use_gpu is not None
        else _parse_bool_env("WHISPER_CPP_USE_GPU", default=False)
    )
    gpu_required = (
        require_gpu
        if require_gpu is not None
        else _parse_bool_env("WHISPER_CPP_REQUIRE_GPU", default=False)
    )
    if not gpu_requested:
        return False, None

    if not _is_gpu_runtime_available():
        if gpu_required:
            raise RuntimeError(
                "WHISPER_CPP_REQUIRE_GPU=true but no GPU runtime detected. "
                "Refusing CPU fallback."
            )
        logger.warning(
            "WHISPER_CPP_USE_GPU=true but no GPU runtime detected; using CPU mode."
        )
        return False, None

    resolved_layers = gpu_layers
    if resolved_layers is None:
        raw_layers = os.getenv("WHISPER_CPP_GPU_LAYERS")
        if raw_layers and raw_layers.strip():
            try:
                resolved_layers = int(raw_layers)
            except ValueError:
                logger.warning(
                    "Invalid WHISPER_CPP_GPU_LAYERS=%r; defaulting to 35",
                    raw_layers,
                )
                resolved_layers = 35
        else:
            resolved_layers = 35

    if resolved_layers is not None and resolved_layers <= 0:
        logger.warning(
            "Non-positive GPU layer count (%s); using whisper.cpp default GPU layers.",
            resolved_layers,
        )
        resolved_layers = None

    return True, resolved_layers


def ffmpeg_to_wav16k_mono(src: Path, dst: Path) -> None:
    if not _which("ffmpeg"):
        raise RuntimeError("ffmpeg is required but not found on PATH")

    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-ac",
        "1",
        "-ar",
        "16000",
        "-vn",
        str(dst),
    ]
    try:
        _run(cmd)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            "ffmpeg failed converting input to WAV (is "
            f"'{src}' an audio/video file with an audio stream?)"
        ) from e


def _parse_whisper_srt(path: Path) -> List[Segment]:
    def _ts_to_seconds(ts: str) -> float:
        hh, mm, rest = ts.split(":")
        ss, ms = rest.split(",")
        return int(hh) * 3600 + int(mm) * 60 + int(ss) + int(ms) / 1000.0

    segments: List[Segment] = []
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    i = 0
    while i < len(lines):
        while i < len(lines) and not lines[i].strip():
            i += 1
        if i >= len(lines):
            break
        if lines[i].strip().isdigit():
            i += 1
        if i >= len(lines):
            break
        if "-->" not in lines[i]:
            i += 1
            continue

        start_s, end_s = [p.strip() for p in lines[i].split("-->")]
        i += 1
        text_lines = []
        while i < len(lines) and lines[i].strip():
            text_lines.append(lines[i].strip())
            i += 1

        text = " ".join(text_lines).strip()
        if text:
            segments.append(
                Segment(
                    start=_ts_to_seconds(start_s),
                    end=_ts_to_seconds(end_s),
                    text=text,
                )
            )

    return segments


def run_whisper_cpp(
    *,
    whisper_bin: Path,
    model_path: Path,
    wav_path: Path,
    out_dir: Path,
    language: str,
    use_gpu: bool = False,
    gpu_layers: Optional[int] = None,
    require_gpu: bool = False,
) -> Tuple[Path, List[Segment], bool]:
    out_dir.mkdir(parents=True, exist_ok=True)
    base = wav_path.stem
    out_prefix = out_dir / base

    base_cmd = [
        str(whisper_bin),
        "-m",
        str(model_path),
        "-f",
        str(wav_path),
        "-l",
        language,
        "-osrt",
        "-of",
        str(out_prefix),
    ]

    gpu_cmd = list(base_cmd)
    if use_gpu:
        if gpu_layers is not None:
            gpu_layers_flag = _resolve_whisper_gpu_layers_flag(whisper_bin)
            if gpu_layers_flag is not None:
                gpu_cmd.extend([gpu_layers_flag, str(gpu_layers)])
            else:
                logger.warning(
                    "WHISPER_CPP_GPU_LAYERS=%s requested but whisper-cli does not "
                    "support -ngl/--gpu-layers; using binary default GPU layering.",
                    gpu_layers,
                )
    else:
        gpu_cmd.append("-ng")

    actual_gpu_used = False
    whisper_ld_library_path = _compose_whisper_ld_library_path(
        os.getenv("LD_LIBRARY_PATH")
    )
    whisper_env = {"LD_LIBRARY_PATH": whisper_ld_library_path}
    try:
        with _temporary_env(whisper_env):
            if use_gpu:
                gpu_output = _run_capture_output(gpu_cmd)
                gpu_backend_init = _detect_whisper_gpu_backend_init(gpu_output)
                if gpu_backend_init is True:
                    actual_gpu_used = True
                elif gpu_backend_init is False:
                    logger.warning(
                        "whisper.cpp was asked to use GPU but initialized CPU/no-GPU backend."
                    )
                else:
                    logger.warning(
                        "Could not confirm whisper.cpp GPU backend initialization from output."
                    )

                if require_gpu and gpu_backend_init is not True:
                    raise RuntimeError(
                        "WHISPER_CPP_REQUIRE_GPU=true but whisper.cpp did not initialize a "
                        "non-CPU GPU backend."
                    )
            else:
                _run(gpu_cmd)
    except Exception as gpu_err:
        if not use_gpu:
            raise
        if require_gpu:
            raise RuntimeError(
                "whisper.cpp GPU execution failed with WHISPER_CPP_REQUIRE_GPU=true; "
                "refusing CPU fallback."
            ) from gpu_err
        logger.warning(
            "whisper.cpp GPU run failed; retrying on CPU. Error: %s",
            gpu_err,
        )
        cpu_cmd = list(base_cmd)
        cpu_cmd.append("-ng")
        with _temporary_env(whisper_env):
            _run(cpu_cmd)
        actual_gpu_used = False

    srt_path = out_dir / f"{base}.srt"
    if not srt_path.exists():
        raise RuntimeError(f"Expected whisper.cpp SRT not found: {srt_path}")

    return srt_path, _parse_whisper_srt(srt_path), actual_gpu_used


def _merge_segments_for_diarization(
    segments: List[Segment],
    min_seconds: float = 1.5,
    max_seconds: float = 12.0,
    max_gap_seconds: float = 0.8,
) -> List[Tuple[float, float, List[int]]]:
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
        elif proposed_dur > max_seconds and ((cur_end - cur_start) >= min_seconds):
            should_break = True

        if should_break:
            windows.append((cur_start, cur_end, cur_idxs))
            cur_start, cur_end, cur_idxs = s.start, s.end, [idx]
        else:
            cur_end = proposed_end
            cur_idxs.append(idx)

    windows.append((cur_start, cur_end, cur_idxs))

    merged: List[Tuple[float, float, List[int]]] = []
    for w in windows:
        if merged and (w[1] - w[0]) < min_seconds:
            ps, _, pidxs = merged[-1]
            merged[-1] = (ps, w[1], pidxs + w[2])
        else:
            merged.append(w)

    return merged


def _extract_wav_window(src_wav: Path, start: float, end: float) -> Path:
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
    # scikit-learn has no typing stubs.
    from sklearn.cluster import AgglomerativeClustering  # type: ignore
    from sklearn.metrics import silhouette_score  # type: ignore
    import numpy as np

    X = np.asarray(embeddings, dtype=np.float32)
    if X.ndim != 2 or X.shape[0] < 2:
        return 1, [0] * int(X.shape[0])

    best_k = 1
    best_score = -1.0
    best_labels = [0] * X.shape[0]

    upper = min(max_speakers, X.shape[0])
    for k in range(2, upper + 1):
        try:
            clustering = AgglomerativeClustering(n_clusters=k)
            labels = clustering.fit_predict(X)
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


def diarize_segments_offline(
    *,
    wav_path: Path,
    segments: List[Segment],
    max_speakers: int,
    model_dir: Path,
) -> Tuple[int, List[Segment]]:
    import numpy as np
    import torch

    device = "cpu"

    _ensure_torchaudio_compat()

    try:
        from speechbrain.inference.speaker import (  # type: ignore
            EncoderClassifier,
        )
    except Exception as e:  # pragma: no cover
        raise RuntimeError(
            "Offline diarization requires SpeechBrain + PyTorch. "
            "Install offline diarization deps."
        ) from e

    if not segments:
        return 0, segments

    if not model_dir.exists():
        raise RuntimeError(
            "Missing local diarization modeldir. Expected: "
            f"{model_dir}.\n"
            "Bake the SpeechBrain ECAPA model artifacts into the image at "
            "that path."
        )

    # SpeechBrain will attempt to download missing files via HF Hub.
    # In offline/locked-down runtimes this can fail (and can also try to write
    # to an unwritable cache like '/.cache'). We therefore require *all*
    # diarization assets we rely on to be present locally.
    required_files = [
        "hyperparams.yaml",
        "embedding_model.ckpt",
        "mean_var_norm_emb.ckpt",
        "classifier.ckpt",
        # Required by SpeechBrain's pretrained interface for this model.
        "label_encoder.txt",
    ]

    missing_files = [f for f in required_files if not (model_dir / f).exists()]
    if missing_files:
        raise RuntimeError(
            "Missing offline diarization assets in "
            f"{model_dir}: {', '.join(missing_files)}. "
            "Either prebake them for fully offline diarization, or run with "
            "diarization disabled."
        )

    windows = _merge_segments_for_diarization(segments)
    if len(windows) < 2:
        for s in segments:
            s.speaker = "Speaker A"
        return 1, segments

    logger.info(
        "Diarization: computing embeddings for %d windows",
        len(windows),
    )

    # IMPORTANT (non-root containers): the baked model directory under /app is
    # often read-only for the runtime user, so we cannot edit hyperparams.yaml
    # in place. Also, copying the whole model directory per job can add up and
    # exceed k8s ephemeral storage limits.
    overlay_dir = _make_writable_hyperparams_overlay(baked_model_dir=model_dir)
    try:
        classifier: Any = EncoderClassifier.from_hparams(
            source=str(overlay_dir),
            savedir=str(overlay_dir),
            run_opts={"device": device},
        )

        embeddings: List[List[float]] = []
        win_tmp_files: List[Path] = []
        try:
            for ws, we, _ in windows:
                wpath = _extract_wav_window(wav_path, ws, we)
                win_tmp_files.append(wpath)

                cmd = [
                    "ffmpeg",
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(wpath),
                    "-f",
                    "s16le",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-",
                ]
                raw = subprocess.check_output(cmd)
                audio_i16 = np.frombuffer(raw, dtype=np.int16)
                audio_f32 = (audio_i16.astype(np.float32) / 32768.0).reshape(1, -1)
                wav = torch.from_numpy(audio_f32)
                with torch.inference_mode():
                    emb_tensor = classifier.encode_batch(wav)
                emb_np = (
                    (emb_tensor.squeeze(0).squeeze(0).detach().cpu().numpy())
                    .astype(np.float32)
                    .reshape(-1)
                )
                embeddings.append(emb_np.tolist())
        finally:
            for p in win_tmp_files:
                try:
                    p.unlink(missing_ok=True)
                except Exception:
                    pass

        k, labels = _cluster_speakers(embeddings, max_speakers=max_speakers)
    finally:
        shutil.rmtree(overlay_dir, ignore_errors=True)

    logger.info("Diarization: selected %d speakers", k)

    label_map: Dict[int, str] = {}
    next_label_idx = 0
    for lab in labels:
        if lab not in label_map:
            label_map[lab] = f"Speaker {SPEAKER_LABELS[next_label_idx]}"
            next_label_idx += 1

    for w, lab in zip(windows, labels):
        speaker = label_map.get(lab, "Speaker A")
        for idx in w[2]:
            segments[idx].speaker = speaker

    return k, segments


def resolve_whisper_paths(
    *,
    whisper_bin: Optional[str] = None,
    model_path: Optional[str] = None,
) -> Tuple[Path, Path]:
    # IMPORTANT: Path("") becomes Path(".") which is truthy as a string.
    # Treat empty / unset env the same as "not provided".
    env_bin = os.getenv("WHISPER_CPP_BIN")
    bin_path = Path(whisper_bin) if whisper_bin else Path(env_bin or "")
    if bin_path in (Path("."), Path("")):
        bin_path = DEFAULT_WHISPER_BIN

    if not bin_path.is_file():
        resolved = _which(str(bin_path)) if str(bin_path) else None
        if resolved:
            bin_path = Path(resolved)

    env_model = os.getenv("WHISPER_CPP_MODEL")
    model = Path(model_path) if model_path else Path(env_model or "")
    if model in (Path("."), Path("")):
        model = DEFAULT_WHISPER_MODEL

    if not bin_path.is_file():
        raise RuntimeError(
            "whisper.cpp binary not found. Provide WHISPER_CPP_BIN or bake it "
            f"into the image. Tried: {bin_path}"
        )

    if not model.exists():
        raise RuntimeError(
            "whisper.cpp model not found. Provide WHISPER_CPP_MODEL or bake "
            f"it into the image. Tried: {model}"
        )

    return bin_path, model


def transcribe_and_diarize_local_media(
    *,
    input_path: Path,
    out_dir: Path,
    meeting_id: str,
    language: str = "en",
    diarize: bool = True,
    max_speakers: int = 6,
    whisper_bin: Optional[str] = None,
    whisper_model: Optional[str] = None,
    speechbrain_model_dir: Optional[str] = None,
    use_gpu: Optional[bool] = None,
    whisper_gpu_layers: Optional[int] = None,
) -> Tuple[Path, Path]:
    """Run whisper.cpp + (optional) diarization on a local file."""

    if not input_path.exists():
        raise FileNotFoundError(str(input_path))

    out_dir.mkdir(parents=True, exist_ok=True)

    whisper_bin_path, whisper_model_path = resolve_whisper_paths(
        whisper_bin=whisper_bin, model_path=whisper_model
    )
    whisper_require_gpu = _parse_bool_env("WHISPER_CPP_REQUIRE_GPU", default=False)
    whisper_use_gpu, whisper_resolved_gpu_layers = resolve_whisper_gpu_settings(
        use_gpu=use_gpu,
        gpu_layers=whisper_gpu_layers,
        require_gpu=whisper_require_gpu,
    )
    logger.info(
        "whisper.cpp execution mode: %s",
        "gpu" if whisper_use_gpu else "cpu",
    )
    if whisper_use_gpu and whisper_resolved_gpu_layers is not None:
        logger.info("whisper.cpp GPU layers: %d", whisper_resolved_gpu_layers)

    sb_model_dir_str: str = (
        speechbrain_model_dir
        or os.getenv("SPEECHBRAIN_MODEL_DIR")
        or str(DEFAULT_SPEECHBRAIN_MODEL_DIR)
    )
    sb_model_dir = Path(sb_model_dir_str)

    tmp_root = Path(tempfile.mkdtemp(prefix="offline_transcribe_"))
    try:
        wav_path = tmp_root / "audio_16k_mono.wav"
        ffmpeg_to_wav16k_mono(input_path, wav_path)

        whisper_out_dir = tmp_root / "whisper"
        _, segments, whisper_actual_gpu_used = run_whisper_cpp(
            whisper_bin=whisper_bin_path,
            model_path=whisper_model_path,
            wav_path=wav_path,
            out_dir=whisper_out_dir,
            language=language,
            use_gpu=whisper_use_gpu,
            gpu_layers=whisper_resolved_gpu_layers,
            require_gpu=whisper_require_gpu and whisper_use_gpu,
        )

        diarization_info: Dict[str, Any] = {
            "enabled": bool(diarize),
            "max_speakers": max_speakers,
            "detected_speakers": None,
        }

        if diarize:
            detected, segments = diarize_segments_offline(
                wav_path=wav_path,
                segments=segments,
                max_speakers=max_speakers,
                model_dir=sb_model_dir,
            )
            diarization_info["detected_speakers"] = detected

        # Remove repeated trailing segments (keep the oldest occurrence).
        segments = _dedupe_repeated_segments(segments)

        timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        base_name = f"{meeting_id}_{timestamp}_whispercpp"

        txt_path = out_dir / f"{base_name}.txt"
        json_path = out_dir / f"{base_name}.json"
        md_path = out_dir / f"{base_name}.md"
        vtt_path = out_dir / f"{base_name}.vtt"

        transcript_lines: List[str] = []
        for s in segments:
            speaker_prefix = f"{s.speaker}: " if s.speaker else ""
            transcript_lines.append(
                f"[{s.start:0.2f}-{s.end:0.2f}] {speaker_prefix}{s.text}"
            )
        txt_path.write_text("\n".join(transcript_lines), encoding="utf-8")

        md_path.write_text(_segments_to_markdown(segments), encoding="utf-8")

        vtt_path.write_text(_segments_to_webvtt(segments), encoding="utf-8")

        payload: Dict[str, Any] = {
            "engine": "whisper.cpp",
            "model": str(whisper_model_path),
            "language": language,
            "runtime": {
                "gpu_requested": bool(
                    use_gpu
                    if use_gpu is not None
                    else _parse_bool_env("WHISPER_CPP_USE_GPU", default=False)
                ),
                "gpu_required": whisper_require_gpu,
                "gpu_used": whisper_actual_gpu_used,
                "gpu_layers": whisper_resolved_gpu_layers,
            },
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

        return txt_path, json_path
    finally:
        # Keep temp dir for debugging when needed.
        if os.getenv("OFFLINE_PIPELINE_KEEP_TMP"):
            logger.info("Keeping temp dir: %s", tmp_root)
        else:
            shutil.rmtree(tmp_root, ignore_errors=True)
