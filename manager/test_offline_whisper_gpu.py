import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from offline_pipeline import (
    _compose_whisper_ld_library_path,
    _detect_whisper_gpu_backend_init,
    resolve_whisper_gpu_settings,
    run_whisper_cpp,
)


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

    def test_gpu_required_without_runtime_raises(self):
        with patch.dict(
            os.environ,
            {"WHISPER_CPP_USE_GPU": "true", "WHISPER_CPP_REQUIRE_GPU": "true"},
            clear=True,
        ):
            with patch("offline_pipeline._is_gpu_runtime_available", return_value=False):
                with self.assertRaises(RuntimeError):
                    resolve_whisper_gpu_settings()

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

    def test_compose_whisper_ld_library_path_prioritizes_whisper_and_system_cuda(self):
        with patch("offline_pipeline.Path.exists", return_value=True):
            composed = _compose_whisper_ld_library_path(
                "/usr/lib/x86_64-linux-gnu:/custom/path:/usr/lib/x86_64-linux-gnu"
            )

        entries = composed.split(":")
        self.assertGreaterEqual(len(entries), 5)
        self.assertEqual(entries[0], "/app/tools/whisper.cpp/build/src")
        self.assertEqual(entries[1], "/app/tools/whisper.cpp/build/ggml/src")
        self.assertEqual(entries[2], "/usr/local/nvidia/lib64")
        self.assertEqual(entries[3], "/usr/lib/x86_64-linux-gnu")
        self.assertEqual(entries[4], "/lib/x86_64-linux-gnu")
        self.assertIn("/custom/path", entries)
        self.assertEqual(entries.count("/usr/lib/x86_64-linux-gnu"), 1)


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

            gpu_calls = []
            cpu_calls = []

            def _fake_run_capture(cmd):
                gpu_calls.append(list(cmd))
                raise subprocess.CalledProcessError(
                    returncode=1, cmd=cmd, output="simulated gpu failure"
                )

            def _fake_run(cmd):
                cpu_calls.append(list(cmd))

            with patch(
                "offline_pipeline._run_capture_output",
                side_effect=_fake_run_capture,
            ), patch("offline_pipeline._run", side_effect=_fake_run), patch(
                "offline_pipeline._resolve_whisper_gpu_layers_flag", return_value="-ngl"
            ):
                _, segments, gpu_used = run_whisper_cpp(
                    whisper_bin=tmp_path / "whisper-cli",
                    model_path=tmp_path / "model.bin",
                    wav_path=wav_path,
                    out_dir=out_dir,
                    language="en",
                    use_gpu=True,
                    gpu_layers=12,
                )

            self.assertEqual(len(gpu_calls), 1)
            self.assertIn("-ngl", gpu_calls[0])
            self.assertNotIn("-ng", gpu_calls[0])
            self.assertEqual(len(cpu_calls), 1)
            self.assertIn("-ng", cpu_calls[0])
            self.assertEqual(len(segments), 1)
            self.assertEqual(segments[0].text, "hello world")
            self.assertFalse(gpu_used)

    def test_run_whisper_gpu_required_does_not_retry_cpu(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            wav_path = tmp_path / "audio.wav"
            wav_path.write_bytes(b"fake")

            out_dir = tmp_path / "out"
            out_dir.mkdir()

            gpu_calls = []
            cpu_calls = []

            def _fake_run_capture(cmd):
                gpu_calls.append(list(cmd))
                raise subprocess.CalledProcessError(
                    returncode=1, cmd=cmd, output="simulated gpu failure"
                )

            def _fake_run(cmd):
                cpu_calls.append(list(cmd))

            with patch(
                "offline_pipeline._run_capture_output",
                side_effect=_fake_run_capture,
            ), patch("offline_pipeline._run", side_effect=_fake_run), patch(
                "offline_pipeline._resolve_whisper_gpu_layers_flag", return_value="-ngl"
            ):
                with self.assertRaises(RuntimeError):
                    run_whisper_cpp(
                        whisper_bin=tmp_path / "whisper-cli",
                        model_path=tmp_path / "model.bin",
                        wav_path=wav_path,
                        out_dir=out_dir,
                        language="en",
                        use_gpu=True,
                        gpu_layers=12,
                        require_gpu=True,
                    )

            self.assertEqual(len(gpu_calls), 1)
            self.assertIn("-ngl", gpu_calls[0])
            self.assertNotIn("-ng", gpu_calls[0])
            self.assertEqual(len(cpu_calls), 0)

    def test_run_whisper_gpu_uses_long_flag_when_supported(self):
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

            gpu_calls = []

            def _fake_run_capture(cmd):
                gpu_calls.append(list(cmd))
                return "whisper_backend_init_gpu: device 0: NVIDIA T4 (type: 2)\n"

            with patch("offline_pipeline._run_capture_output", side_effect=_fake_run_capture), patch(
                "offline_pipeline._resolve_whisper_gpu_layers_flag",
                return_value="--gpu-layers",
            ):
                _, _, gpu_used = run_whisper_cpp(
                    whisper_bin=tmp_path / "whisper-cli",
                    model_path=tmp_path / "model.bin",
                    wav_path=wav_path,
                    out_dir=out_dir,
                    language="en",
                    use_gpu=True,
                    gpu_layers=10,
                )

            self.assertEqual(len(gpu_calls), 1)
            self.assertIn("--gpu-layers", gpu_calls[0])
            self.assertNotIn("-ngl", gpu_calls[0])
            self.assertTrue(gpu_used)

    def test_run_whisper_gpu_skips_layers_when_unsupported(self):
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

            gpu_calls = []

            def _fake_run_capture(cmd):
                gpu_calls.append(list(cmd))
                return "whisper_backend_init_gpu: device 0: NVIDIA T4 (type: 2)\n"

            with patch("offline_pipeline._run_capture_output", side_effect=_fake_run_capture), patch(
                "offline_pipeline._resolve_whisper_gpu_layers_flag", return_value=None
            ):
                _, _, gpu_used = run_whisper_cpp(
                    whisper_bin=tmp_path / "whisper-cli",
                    model_path=tmp_path / "model.bin",
                    wav_path=wav_path,
                    out_dir=out_dir,
                    language="en",
                    use_gpu=True,
                    gpu_layers=10,
                )

            self.assertEqual(len(gpu_calls), 1)
            self.assertNotIn("-ngl", gpu_calls[0])
            self.assertNotIn("--gpu-layers", gpu_calls[0])
            self.assertTrue(gpu_used)

    def test_run_whisper_gpu_detects_actual_gpu_backend(self):
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

            with patch(
                "offline_pipeline._run_capture_output",
                return_value=(
                    "whisper_backend_init_gpu: device 0: NVIDIA T4 (type: 2)\n"
                ),
            ), patch("offline_pipeline._resolve_whisper_gpu_layers_flag", return_value="-ngl"):
                _, _, gpu_used = run_whisper_cpp(
                    whisper_bin=tmp_path / "whisper-cli",
                    model_path=tmp_path / "model.bin",
                    wav_path=wav_path,
                    out_dir=out_dir,
                    language="en",
                    use_gpu=True,
                    gpu_layers=10,
                    require_gpu=True,
                )

            self.assertTrue(gpu_used)

    def test_run_whisper_gpu_required_fails_on_cpu_backend_banner(self):
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

            with patch(
                "offline_pipeline._run_capture_output",
                return_value=(
                    "whisper_backend_init_gpu: device 0: CPU (type: 0)\n"
                    "whisper_backend_init_gpu: no GPU found\n"
                ),
            ), patch("offline_pipeline._resolve_whisper_gpu_layers_flag", return_value="-ngl"):
                with self.assertRaises(RuntimeError):
                    run_whisper_cpp(
                        whisper_bin=tmp_path / "whisper-cli",
                        model_path=tmp_path / "model.bin",
                        wav_path=wav_path,
                        out_dir=out_dir,
                        language="en",
                        use_gpu=True,
                        gpu_layers=10,
                        require_gpu=True,
                    )


class TestWhisperGpuBackendDetection(unittest.TestCase):
    def test_detect_gpu_backend_cpu_only(self):
        text = "whisper_backend_init_gpu: device 0: CPU (type: 0)"
        self.assertFalse(_detect_whisper_gpu_backend_init(text))

    def test_detect_gpu_backend_no_gpu_found(self):
        text = "whisper_backend_init_gpu: no GPU found"
        self.assertFalse(_detect_whisper_gpu_backend_init(text))

    def test_detect_gpu_backend_real_gpu(self):
        text = "whisper_backend_init_gpu: device 0: NVIDIA T4 (type: 2)"
        self.assertTrue(_detect_whisper_gpu_backend_init(text))

    def test_detect_gpu_backend_unknown(self):
        text = "random log output without backend banner"
        self.assertIsNone(_detect_whisper_gpu_backend_init(text))


if __name__ == "__main__":
    unittest.main()
