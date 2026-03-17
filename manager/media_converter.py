"""# noqa: E501
Media Converter - Convert recordings to MP4 and extract M4A audio
"""

# NOTE: This module intentionally contains very long ffmpeg filter strings and
# command lines, so we ignore E501 (line length) at the file level.
# flake8: noqa: E501

import os
import subprocess
import logging
from typing import Optional, Tuple

logger = logging.getLogger(__name__)


def get_recording_duration_seconds(file_path: str) -> Optional[float]:
    """
    Get the duration of a media file in seconds using ffprobe.

    Args:
        file_path: Path to the media file

    Returns:
        Duration in seconds, or None if unable to determine
    """
    if not os.path.exists(file_path):
        logger.warning(f"File not found for duration check: {file_path}")
        return None

    try:
        cmd = [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            file_path,
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=10,
            stdin=subprocess.DEVNULL,
        )

        if result.returncode == 0:
            duration_str = result.stdout.strip()
            if duration_str:
                duration = float(duration_str)
                logger.info(
                    f"Recording duration: {duration:.2f} seconds ({duration/60:.2f} minutes)"
                )
                return duration
        else:
            logger.warning(f"ffprobe failed: {result.stderr}")

    except subprocess.TimeoutExpired:
        logger.warning("ffprobe timeout while checking duration")
    except ValueError as e:
        logger.warning(f"Invalid duration value from ffprobe: {e}")
    except Exception as e:
        logger.warning(f"Error getting recording duration: {e}")

    return None


class MediaConverter:
    """Convert media files using ffmpeg"""

    def __init__(self):
        """Initialize media converter"""
        # Timeouts are intentionally configurable because long recordings can take
        # many hours to re-encode depending on CPU and filter complexity.
        #
        # Use 0 (or blank) to disable a timeout.
        self._mp4_timeout_seconds = self._read_timeout_env(
            "MEDIA_CONVERTER_MP4_TIMEOUT_SECONDS",
            default=None,  # No timeout by default; avoid long-meeting failures.
        )
        self._m4a_timeout_seconds = self._read_timeout_env(
            "MEDIA_CONVERTER_M4A_TIMEOUT_SECONDS",
            # No timeout by default; long meetings can take hours.
            default=None,
        )

        # Verify ffmpeg is available
        # Use a simple which/command check instead of running ffmpeg -version
        # which can hang in some Docker environments
        try:
            # First, check if ffmpeg exists in PATH using 'which'
            result = subprocess.run(
                ["which", "ffmpeg"], capture_output=True, text=True, timeout=2
            )
            if result.returncode == 0:
                logger.info(f"ffmpeg found at: {result.stdout.strip()}")
            else:
                logger.warning("ffmpeg not found in PATH")
                raise RuntimeError("ffmpeg is required but not available")
        except subprocess.TimeoutExpired:
            logger.error("Timeout while checking for ffmpeg")
            raise RuntimeError("ffmpeg check timed out")
        except FileNotFoundError:
            # 'which' command not available, try direct ffmpeg check with a
            # shorter timeout.
            try:
                result = subprocess.run(
                    ["ffmpeg", "-version"],
                    capture_output=True,
                    text=True,
                    timeout=2,
                    stdin=subprocess.DEVNULL,  # Prevent ffmpeg waiting for input
                )
                if result.returncode == 0:
                    logger.info("ffmpeg is available")
                else:
                    logger.warning("ffmpeg check returned non-zero exit code")
                    raise RuntimeError("ffmpeg is required but not available")
            except Exception as e:
                logger.error(f"ffmpeg not found or not working: {e}")
                raise RuntimeError("ffmpeg is required but not available")
        except Exception as e:
            logger.error(f"Error checking for ffmpeg: {e}")
            raise RuntimeError("ffmpeg is required but not available")

    @staticmethod
    def _read_timeout_env(
        var_name: str,
        default: Optional[int],
    ) -> Optional[int]:
        """Read a timeout env var as seconds.

        Accepted values:
          - unset: returns default
          - integer seconds (e.g. 3600)
          - 0 / negative: disable timeout (returns None)

        Returns:
            Timeout in seconds, or None for no timeout.
        """
        raw = os.environ.get(var_name)
        if raw is None or raw.strip() == "":
            return default

        try:
            value = int(raw)
        except ValueError:
            logger.warning(
                f"Invalid {var_name}={raw!r}; expected integer seconds. "
                f"Using default={default!r}."
            )
            return default

        if value <= 0:
            return None

        return value

    def convert(self, input_path: str) -> Tuple[Optional[str], Optional[str]]:
        """
        Convert recording to MP4 and extract M4A audio

        Args:
            input_path: Path to input recording file

        Returns:
            Tuple of (mp4_path, m4a_path) if successful, (None, None) otherwise
        """
        if not os.path.exists(input_path):
            logger.error(f"Input file not found: {input_path}")
            return None, None

        m4a_path = self.extract_audio(input_path)
        if not m4a_path:
            return None, None

        mp4_path = self.convert_to_mp4(input_path)
        if not mp4_path:
            return None, None

        return mp4_path, m4a_path

    def extract_audio(self, input_path: str) -> Optional[str]:
        """Extract an enhanced M4A file for transcription-friendly processing."""
        if not os.path.exists(input_path):
            logger.error(f"Input file not found: {input_path}")
            return None

        base_path = os.path.splitext(input_path)[0]
        m4a_path = f"{base_path}.m4a"

        if self._extract_m4a(input_path, m4a_path):
            return m4a_path

        return None

    def convert_to_mp4(self, input_path: str) -> Optional[str]:
        """Convert input recording into MP4 playback artifact."""
        if not os.path.exists(input_path):
            logger.error(f"Input file not found: {input_path}")
            return None

        base_path = os.path.splitext(input_path)[0]
        mp4_path = f"{base_path}.mp4"

        if self._convert_to_mp4(input_path, mp4_path):
            return mp4_path

        return None

    def _convert_to_mp4(self, input_path: str, output_path: str) -> bool:
        """
        Convert video to MP4 format

        Args:
            input_path: Input video file
            output_path: Output MP4 file path

        Returns:
            True if successful, False otherwise
        """
        try:
            logger.info(f"Converting to MP4: {input_path} -> {output_path}")

            # ffmpeg command for MP4 conversion
            # Using H.264 codec with ultra high quality settings
            # Audio filter chain optimized for speed with good quality:
            # 1. highpass: Remove low frequency rumble/noise below 80Hz
            # 2. lowpass: Remove high frequency hiss above 15kHz
            # 3. loudnorm: Professional loudness normalization (EBU R128)
            # Note: Removed afftdn for faster processing, loudnorm handles most issues
            audio_filters = (
                "highpass=f=80,"  # Remove rumble
                "lowpass=f=15000,"  # Remove hiss
                "loudnorm=I=-16:TP=-1.5:LRA=11"  # Normalize loudness
            )

            cmd = [
                "ffmpeg",
                "-i",
                input_path,
                "-c:v",
                "libx264",  # Video codec
                "-preset",
                "medium",  # Balanced quality/speed (was "slow")
                "-crf",
                "23",  # Quality (lower = better, 23 is high quality, was 18)
                "-af",
                audio_filters,  # Audio filter chain
                "-c:a",
                "aac",  # Audio codec
                "-b:a",
                "192k",  # Audio bitrate (was 384k, 192k is still excellent)
                "-ar",
                "48000",  # 48 kHz sample rate
                "-movflags",
                "+faststart",  # Enable streaming
                "-y",  # Overwrite output file
                output_path,
            ]

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=self._mp4_timeout_seconds,
                stdin=subprocess.DEVNULL,  # Prevent ffmpeg from waiting for input
            )

            if result.returncode == 0:
                logger.info(f"Successfully converted to MP4: {output_path}")
                return True
            else:
                logger.error(f"MP4 conversion failed: {result.stderr}")
                return False

        except subprocess.TimeoutExpired:
            logger.error("MP4 conversion timed out")
            return False
        except Exception as e:
            logger.exception(f"Error during MP4 conversion: {e}")
            return False

    def _extract_m4a(self, input_path: str, output_path: str) -> bool:
        """
        Extract audio as M4A with advanced speech enhancement

        Args:
            input_path: Input video file
            output_path: Output M4A file path

        Returns:
            True if successful, False otherwise
        """
        try:
            logger.info(f"Extracting M4A audio: {input_path} -> {output_path}")

            # Advanced audio filter chain optimized for speech/meetings:
            # 1. arnndn: AI-based noise reduction using RNNoise (trained on speech)
            # 2. highpass: Remove low frequency rumble/noise below 80Hz
            # 3. lowpass: Remove high frequency noise above 12kHz (speech focused)
            # 4. equalizer: Boost speech frequencies (200-4000Hz)
            # 5. afftdn: Additional FFT-based noise reduction
            # 6. speechnorm: Speech-specific normalization (better than loudnorm for voice)
            # 7. compand: Multi-band compression for clearer speech
            # Note: silenceremove disabled to prevent audio truncation issues
            audio_filters = (
                "arnndn=m=/usr/share/rnnoise/models/rnnoise.rnnn,"  # AI noise reduction
                "highpass=f=80,"  # Remove rumble
                "lowpass=f=12000,"  # Remove high-freq noise (speech is <8kHz)
                "equalizer=f=300:width_type=o:width=2:g=3,"  # Boost low speech frequencies
                "equalizer=f=2000:width_type=o:width=2:g=2,"  # Boost mid speech frequencies
                "afftdn=nf=-25:tn=1,"  # Additional noise reduction with tracking
                "speechnorm=e=50:r=0.0005:l=1,"  # Speech normalization
                "compand=attacks=0.1:decays=0.2:points=-80/-80|-50/-40|-30/-20|0/-10"  # Compression
            )

            cmd = [
                "ffmpeg",
                "-i",
                input_path,
                "-vn",  # No video
                "-af",
                audio_filters,  # Audio filter chain
                "-c:a",
                "aac",  # Audio codec (AAC in M4A container)
                "-b:a",
                "256k",  # High quality audio bitrate
                "-ar",
                "48000",  # 48 kHz sample rate
                "-ac",
                "1",  # Mono (meetings typically don't need stereo)
                "-y",  # Overwrite output file
                output_path,
            ]

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=self._m4a_timeout_seconds,
                stdin=subprocess.DEVNULL,  # Prevent ffmpeg from waiting for input
            )

            if result.returncode == 0:
                logger.info(f"Successfully extracted M4A audio: {output_path}")
                return True
            else:
                # If arnndn fails (RNNoise not available), fall back to simpler chain
                if "arnndn" in result.stderr or "rnnoise" in result.stderr.lower():
                    logger.warning("RNNoise not available, using fallback filter chain")
                    return self._extract_m4a_fallback(input_path, output_path)
                # If speechnorm is missing in the ffmpeg build, retry with a
                # chain that omits it. Some distro ffmpeg builds don't ship
                # speechnorm.
                if "No such filter: 'speechnorm'" in result.stderr or (
                    "no such filter" in result.stderr.lower()
                    and "speechnorm" in result.stderr.lower()
                ):
                    logger.warning(
                        "ffmpeg filter 'speechnorm' not available; retrying without it"
                    )
                    return self._extract_m4a_without_speechnorm(input_path, output_path)
                else:
                    logger.error(f"M4A extraction failed: {result.stderr}")
                    return False

        except subprocess.TimeoutExpired:
            logger.error("M4A extraction timed out")
            return False
        except Exception as e:
            logger.exception(f"Error during M4A extraction: {e}")
            return False

    def _extract_m4a_fallback(self, input_path: str, output_path: str) -> bool:
        """
        Fallback M4A extraction without RNNoise (for environments without it)

        Args:
            input_path: Input video file
            output_path: Output M4A file path

        Returns:
            True if successful, False otherwise
        """
        try:
            logger.info("Using fallback audio extraction (no RNNoise)")

            # Optimized filter chain without RNNoise
            # Note: silenceremove disabled to prevent audio truncation issues
            audio_filters = (
                "highpass=f=80,"  # Remove rumble
                "lowpass=f=12000,"  # Remove high-freq noise
                "equalizer=f=300:width_type=o:width=2:g=3,"  # Boost low speech
                "equalizer=f=2000:width_type=o:width=2:g=2,"  # Boost mid speech
                "afftdn=nf=-25:tn=1,"  # Noise reduction with tracking
                "speechnorm=e=50:r=0.0005:l=1,"  # Speech normalization
                "compand=attacks=0.1:decays=0.2:points=-80/-80|-50/-40|-30/-20|0/-10"
            )

            cmd = [
                "ffmpeg",
                "-i",
                input_path,
                "-vn",
                "-af",
                audio_filters,
                "-c:a",
                "aac",
                "-b:a",
                "256k",
                "-ar",
                "48000",
                "-ac",
                "1",  # Mono
                "-y",
                output_path,
            ]

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=self._m4a_timeout_seconds,
                stdin=subprocess.DEVNULL,
            )

            if result.returncode == 0:
                logger.info(
                    f"Successfully extracted M4A audio (fallback): {output_path}"
                )
                return True
            else:
                # If speechnorm is missing here too, degrade further.
                if "No such filter: 'speechnorm'" in result.stderr or (
                    "no such filter" in result.stderr.lower()
                    and "speechnorm" in result.stderr.lower()
                ):
                    logger.warning(
                        "ffmpeg filter 'speechnorm' not available in fallback; "
                        "retrying with minimal filter chain"
                    )
                    return self._extract_m4a_minimal(input_path, output_path)

                logger.error(f"M4A extraction failed (fallback): {result.stderr}")
                return False

        except Exception as e:
            logger.exception(f"Error during fallback M4A extraction: {e}")
            return False

    def _extract_m4a_without_speechnorm(
        self, input_path: str, output_path: str
    ) -> bool:
        """Retry extraction with the same 'fallback' chain but without speechnorm.

        This keeps most enhancement while remaining compatible with older
        ffmpeg builds.
        """

        try:
            logger.info("Retrying audio extraction without speechnorm")

            audio_filters = (
                "highpass=f=80,"
                "lowpass=f=12000,"
                "equalizer=f=300:width_type=o:width=2:g=3,"
                "equalizer=f=2000:width_type=o:width=2:g=2,"
                "afftdn=nf=-25:tn=1,"
                "compand=attacks=0.1:decays=0.2:points=-80/-80|-50/-40|-30/-20|0/-10"
            )

            cmd = [
                "ffmpeg",
                "-i",
                input_path,
                "-vn",
                "-af",
                audio_filters,
                "-c:a",
                "aac",
                "-b:a",
                "256k",
                "-ar",
                "48000",
                "-ac",
                "1",
                "-y",
                output_path,
            ]

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=self._m4a_timeout_seconds,
                stdin=subprocess.DEVNULL,
            )

            if result.returncode == 0:
                logger.info(
                    "Successfully extracted M4A audio (no speechnorm): %s",
                    output_path,
                )
                return True

            logger.error(
                "M4A extraction failed (no speechnorm): %s",
                result.stderr,
            )
            return False

        except Exception as e:
            logger.exception("Error during no-speechnorm extraction: %s", e)
            return False

    def _extract_m4a_minimal(self, input_path: str, output_path: str) -> bool:
        """Last-resort extraction that should work on almost any ffmpeg build."""

        try:
            logger.info("Retrying audio extraction with minimal filter chain")

            # Keep it very conservative: basic band-pass-ish cleanup.
            audio_filters = "highpass=f=80,lowpass=f=12000"

            cmd = [
                "ffmpeg",
                "-i",
                input_path,
                "-vn",
                "-af",
                audio_filters,
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-ar",
                "48000",
                "-ac",
                "1",
                "-y",
                output_path,
            ]

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=self._m4a_timeout_seconds,
                stdin=subprocess.DEVNULL,
            )

            if result.returncode == 0:
                logger.info(
                    "Successfully extracted M4A audio (minimal): %s",
                    output_path,
                )
                return True

            logger.error(
                "M4A extraction failed (minimal): %s",
                result.stderr,
            )
            return False

        except Exception as e:
            logger.exception("Error during minimal extraction: %s", e)
            return False

    def cleanup(self, *file_paths: str):
        """
        Clean up temporary files

        Args:
            *file_paths: File paths to delete
        """
        for file_path in file_paths:
            try:
                if os.path.exists(file_path):
                    os.remove(file_path)
                    logger.info(f"Cleaned up file: {file_path}")
            except Exception as e:
                logger.warning(f"Failed to cleanup file {file_path}: {e}")
