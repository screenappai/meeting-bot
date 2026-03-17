from __future__ import annotations

import os
import unittest

from test_manager_requires_user_id import _import_meeting_manager
from unittest.mock import patch


def _base_env():
    return {
        "MEETING_URL": "https://meet.google.com/abc-defg-hij",
        "MEETING_ID": "meeting-1",
        "USER_ID": "user-1",
        "GCS_BUCKET": "bucket-1",
        "GCS_PATH": "recordings/user-1/meeting-1",
        "MEETING_BOT_API_URL": "http://localhost:3000",
        "FIRESTORE_DATABASE": "(default)",
    }


class TestMeetingManagerTranscriptionModes(unittest.TestCase):
    def test_online_mode_maps_to_gemini(self):
        with patch.dict(os.environ, {"LOG_FORMAT": "text"}, clear=False):
            MeetingManager = _import_meeting_manager()
        env = _base_env()
        env["TRANSCRIPTION_MODE"] = "online"
        with patch.dict(os.environ, env, clear=True):
            mgr = MeetingManager()

        self.assertEqual(mgr.transcription_mode, "gemini")

    def test_invalid_transcription_mode_rejected(self):
        with patch.dict(os.environ, {"LOG_FORMAT": "text"}, clear=False):
            MeetingManager = _import_meeting_manager()
        env = _base_env()
        env["TRANSCRIPTION_MODE"] = "not-a-mode"
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaises(ValueError) as ctx:
                MeetingManager()

        self.assertIn("Invalid TRANSCRIPTION_MODE", str(ctx.exception))

    def test_azure_mode_requires_strict_config(self):
        with patch.dict(os.environ, {"LOG_FORMAT": "text"}, clear=False):
            MeetingManager = _import_meeting_manager()
        env = _base_env()
        env["TRANSCRIPTION_MODE"] = "azure"
        with patch.dict(os.environ, env, clear=True):
            with self.assertRaises(ValueError) as ctx:
                MeetingManager()

        self.assertIn("AZURE_SPEECH_ENDPOINT", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
