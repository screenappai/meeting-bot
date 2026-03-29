import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from azure_speech_transcription import (
    AzureSpeechConfig,
    AzureSpeechTranscriptionAdapter,
    load_azure_speech_config_from_env,
)
from offline_pipeline import Segment, _segments_to_markdown


class TestAzureSpeechConfigValidation(unittest.TestCase):
    def _load(self, overrides):
        base_env = {
            "AZURE_SPEECH_REGION": "australiaeast",
            "AZURE_SPEECH_ENDPOINT": "https://australiaeast.api.cognitive.microsoft.com",
            "AZURE_SPEECH_KEY": "test-key",
        }
        base_env.update(overrides)
        with patch.dict(os.environ, base_env, clear=True):
            return load_azure_speech_config_from_env()

    def test_valid_au_config_loads(self):
        cfg = self._load({})
        self.assertEqual(cfg.region, "australiaeast")
        self.assertEqual(
            cfg.endpoint, "https://australiaeast.api.cognitive.microsoft.com"
        )
        self.assertTrue(cfg.diarization_enabled)
        self.assertEqual(cfg.diarization_max_speakers, 6)

    def test_non_au_region_rejected(self):
        with self.assertRaises(ValueError) as ctx:
            self._load({"AZURE_SPEECH_REGION": "eastus"})
        self.assertIn("AU region", str(ctx.exception))

    def test_endpoint_region_mismatch_rejected(self):
        with self.assertRaises(ValueError) as ctx:
            self._load(
                {
                    "AZURE_SPEECH_REGION": "australiasoutheast",
                    "AZURE_SPEECH_ENDPOINT": "https://australiaeast.api.cognitive.microsoft.com",
                }
            )
        self.assertIn("must match AZURE_SPEECH_REGION", str(ctx.exception))

    def test_diarization_speaker_bounds_validated(self):
        with self.assertRaises(ValueError) as ctx:
            self._load(
                {
                    "AZURE_SPEECH_ENABLE_DIARIZATION": "true",
                    "AZURE_SPEECH_DIARIZATION_MAX_SPEAKERS": "1",
                }
            )
        self.assertIn("must be >= 2", str(ctx.exception))


class TestAzureSpeechSaveTranscript(unittest.TestCase):
    """Tests for save_transcript() txt formatting (speaker-grouped output)."""

    _DUMMY_CONFIG = AzureSpeechConfig(
        endpoint="https://australiaeast.api.cognitive.microsoft.com",
        region="australiaeast",
        key="dummy",
        api_version="2025-10-15",
        locale="en-AU",
        diarization_enabled=True,
        diarization_max_speakers=6,
        request_timeout_seconds=900,
    )

    def _adapter(self):
        return AzureSpeechTranscriptionAdapter(config=self._DUMMY_CONFIG)

    def _transcript_data(self, segments, transcript=None):
        text = transcript or " ".join(s["text"] for s in segments)
        return {
            "engine": "azure-speech-fast-transcription",
            "model": "azure-speech-fast-transcription",
            "locale": "en-AU",
            "transcript": text,
            "segments": segments,
            "sections": {},
            "word_count": len(text.split()),
            "processing_time_ms": 1000,
            "diarization": {"requested": True, "enabled": True, "max_speakers": 6},
            "raw_response": {},
        }

    def _save_and_read(self, data, fmt="txt"):
        adapter = self._adapter()
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=f".{fmt}", delete=False
        ) as f:
            path = f.name
        adapter.save_transcript(data, path, format=fmt)
        return Path(path).read_text(encoding="utf-8")

    def test_txt_groups_consecutive_same_speaker_segments(self):
        segments = [
            {"start": 0.0, "end": 1.0, "speaker": "Speaker 1", "text": "Hello."},
            {"start": 1.0, "end": 2.0, "speaker": "Speaker 1", "text": "World."},
            {"start": 2.0, "end": 3.0, "speaker": "Speaker 2", "text": "Hi there."},
        ]
        content = self._save_and_read(self._transcript_data(segments))
        self.assertIn("**Speaker 1:** Hello. World.", content)
        self.assertIn("**Speaker 2:** Hi there.", content)
        self.assertNotIn("--- Metadata ---", content)
        self.assertNotIn("--- Segments ---", content)

    def test_txt_handles_speaker_change_then_return(self):
        segments = [
            {"start": 0.0, "end": 1.0, "speaker": "Speaker A", "text": "First."},
            {"start": 1.0, "end": 2.0, "speaker": "Speaker B", "text": "Middle."},
            {"start": 2.0, "end": 3.0, "speaker": "Speaker A", "text": "Back."},
        ]
        content = self._save_and_read(self._transcript_data(segments))
        first_a = content.index("**Speaker A:** First.")
        b_block = content.index("**Speaker B:** Middle.")
        second_a = content.index("**Speaker A:** Back.")
        self.assertLess(first_a, b_block)
        self.assertLess(b_block, second_a)

    def test_txt_fallback_to_raw_transcript_when_no_segments(self):
        data = self._transcript_data([], transcript="some raw text")
        content = self._save_and_read(data)
        self.assertIn("some raw text", content)

    def test_txt_output_matches_offline_markdown_format(self):
        raw_segments = [
            {"start": 0.0, "end": 1.0, "speaker": "Speaker 1", "text": "Hello."},
            {"start": 1.0, "end": 2.0, "speaker": "Speaker 2", "text": "World."},
            {"start": 2.0, "end": 3.0, "speaker": "Speaker 1", "text": "Goodbye."},
        ]
        content = self._save_and_read(self._transcript_data(raw_segments))
        expected = _segments_to_markdown(
            [
                Segment(start=s["start"], end=s["end"], text=s["text"], speaker=s["speaker"])
                for s in raw_segments
            ]
        )
        self.assertEqual(content, expected)


if __name__ == "__main__":
    unittest.main()
