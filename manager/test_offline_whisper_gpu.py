import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from offline_pipeline import resolve_whisper_gpu_settings, run_whisper_cpp


class TestWhisperGpuSettings(unittest.TestCase):
    def test_gpu_disabled_by_default(self):
        with patch.dict(os.environ, {}, clear=True):
            use_gpu, layers = resolve_whisper_gpu_settings()
        self.assertFalse(use_gpu)
        self.assertIsNone(layers)

    def test_gpu_requested_without_runtime_falls_back_to_cpu(self):
        with patch.dict(os.environ, {"WHISPER_CPP_USE_GPU": "true"}, clear=True):
            with patch("offline_pipeline._is_gpu_runtime_available", return_value=False):
                use_gpu, layers = resolve_whisper_gpu_settings()
        self.assertFalse(use_gpu)
        self.assertIsNone(layers)

    def test_gpu_requested_with_runtime_uses_layers(self):
        with patch.dict(
            os.environ,
            {"WHISPER_CPP_USE_GPU": "true", "WHISPER_CPP_GPU_LAYERS": "28"},
            clear=True,
        ):
            with patch("offline_pipeline._is_gpu_runtime_available", return_value=True):
                use_gpu, layers = resolve_whisper_gpu_settings()
        self.assertTrue(use_gpu)
        self.assertEqual(layers, 28)


class TestRunWhisperGpuFallback(unittest.TestCase):
    def test_run_whisper_gpu_retries_cpu_on_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            wav_path = tmp_path / "audio.wav"
            wav_path.write_bytes(b"fake")

            out_dir = tmp_path / "out"
            out_dir.mkdir()
            srt_path = out_dir / "audio.srt"
            srt_path.write_text(
                "1\n00:00:00,000 --> 00:00:01,000\nhello world\n", encoding="utf-8"
            )

            calls = []

            def _fake_run(cmd):
                calls.append(list(cmd))
                if len(calls) == 1:
                    raise subprocess.CalledProcessError(returncode=1, cmd=cmd)

            with patch("offline_pipeline._run", side_effect=_fake_run):
                _, segments = run_whisper_cpp(
                    whisper_bin=tmp_path / "whisper-cli",
                    model_path=tmp_path / "model.bin",
                    wav_path=wav_path,
                    out_dir=out_dir,
                    language="en",
                    use_gpu=True,
                    gpu_layers=12,
                )

            self.assertEqual(len(calls), 2)
            self.assertIn("-ngl", calls[0])
            self.assertNotIn("-ng", calls[0])
            self.assertIn("-ng", calls[1])
            self.assertEqual(len(segments), 1)
            self.assertEqual(segments[0].text, "hello world")


if __name__ == "__main__":
    unittest.main()
