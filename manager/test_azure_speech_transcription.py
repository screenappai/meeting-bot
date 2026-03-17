import os
import unittest
from unittest.mock import patch

from azure_speech_transcription import load_azure_speech_config_from_env


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


if __name__ == "__main__":
    unittest.main()
