# Transcription Benchmark Findings (Largest Recording)

## Scope

This report covers:

- largest recording selection in GCS,
- baseline short-run comparison (Whisper CPU vs Azure AU),
- strict 8-hour three-way comparison (Whisper CPU vs Azure AU vs Whisper GPU strict),
- speed and transcript-quality proxy analysis.

## Dataset selected

| Field | Value |
| --- | --- |
| Bucket | `gs://advisewell-firebase-development` |
| Object | `recordings/ad-hoc/advisewell/2025/12/29/teams-6ppZ3l6bmJrxsigBWTTt/recording.webm` |
| Size | `2,503,226,615` bytes (`2.33 GiB`) |
| Decoded audio duration (ffmpeg) | `08:53:22.35` |

## Environment

- Cluster: dev AKS (`aks-development`)
- Region constraints: Azure Speech AU endpoint (`australiaeast`)
- Job SA/auth: `meeting-bot-job` + mounted GCP ADC secret
- Images:
  - historical CPU/Azure 8h runs: `manager:sha-410db37`
  - strict GPU rerun: `manager:sha-6381418`

## 180-second comparison (parallel sanity check)

| Metric | Whisper CPU | Azure Speech AU |
| --- | --- | --- |
| Clip length | `180s` | `180s` |
| Wall time | `166.72s` | `7.72s` |
| Real-time factor | `0.926x` | `0.043x` |
| Relative speed | baseline | `21.6x` faster |
| Segment count | `44` | `40` |
| Speakers (diarized) | `3` | `2` |
| Word count | `281` | `283` |

## 8-hour strict three-way comparison

### Run IDs

- Whisper CPU: `mb-whisper-cpu-8h-1773873129`
- Azure AU chunked: `mb-azure-8h-v3-1773880032`
- Whisper GPU strict: `mb-whisper-gpu-8h-v5-1773966225`
- GPU strict smoke (pre-gate): `mb-whisper-gpu-smoke-6381-1773965143`

### Strict GPU proof

- Job requested and limited GPU: `nvidia.com/gpu: 1`
- Pod scheduled on GPU node: `aks-gpubot-15592575-vmss000000`
- Runtime flags: `WHISPER_CPP_USE_GPU=true`, `WHISPER_CPP_REQUIRE_GPU=true`
- Result payload: `gpu_used=true`, `gpu_required=true`

### Runtime results (8h / 28,800s audio)

| Metric | Whisper CPU | Azure Speech AU | Whisper GPU (strict) |
| --- | --- | --- | --- |
| Wall time | `31,767.35s` (`08:49:27`) | `621.19s` (`00:10:21`) | `535.65s` (`00:08:55`) |
| Real-time factor (`wall/clip`) | `1.1030x` | `0.0216x` | `0.0186x` |
| Audio min processed per wall min | `0.91` | `46.36` | `53.77` |
| Speedup vs CPU | baseline | `51.14x` | `59.31x` |
| Speedup vs Azure | `0.02x` | baseline | `1.16x` |
| Word count | `79,154` | `79,149` | `80,054` |
| Transcript chars | `431,784` | `434,118` | `436,667` |
| Segment count | `10,224` | `5,795` | `3,940` |
| Transcript SHA256 | `3af4393e...` | `adb7b3b1...` | `2276362c...` |

## Quality observations (proxy-level)

- All three transcripts are similar in scale (word counts close), but hashes differ.
- Preview similarity (head+tail snippets):
  - CPU vs GPU: `0.4044`
  - CPU vs Azure: `0.2729`
  - GPU vs Azure: `0.6215`
- Proper noun handling still varies (e.g. `Noland Arbaugh` vs `Nolan Arba`) across engines/runs.

## Important limitations

1. CPU/Azure and strict-GPU runs used different manager image versions (`sha-410db37` vs `sha-6381418`).
2. Completed pods did not retain `/tmp/benchmark-result/*` for direct copy; comparison used `RESULT_JSON` and transcript previews from pod logs.
3. The 8h three-way jobs were run with diarization disabled, so this section compares speed/transcript proxies, not diarization quality.

## Conclusion

- A true GPU Whisper baseline is now validated in-cluster (strict mode enforced, `gpu_used=true`).
- For this 8h sample, both Azure AU and Whisper GPU are dramatically faster than Whisper CPU.
- In this run, strict Whisper GPU was slightly faster than Azure AU (`~1.16x`), with broadly comparable transcript scale.
- Azure AU remains a strong primary path; GPU Whisper is now a credible high-speed fallback when GPU capacity exists.
