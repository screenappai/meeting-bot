from __future__ import annotations

from speaker_identity import build_speaker_metadata


def test_build_speaker_metadata_counts_and_stats() -> None:
    payload = {
        "engine": "azure-speech-fast-transcription",
        "segments": [
            {"speaker": "Speaker 1", "start": 0.0, "end": 2.0, "text": "Hello team"},
            {"speaker": "Speaker 2", "start": 2.0, "end": 5.5, "text": "Good morning"},
            {"speaker": "Speaker 1", "start": 5.5, "end": 8.0, "text": "Let's begin"},
        ],
    }

    metadata = build_speaker_metadata(
        transcript_payload=payload,
        attendee_candidates=[],
    )

    assert metadata["speaker_count"] == 2
    speakers = {row["label"]: row for row in metadata["speakers"]}
    assert speakers["Speaker 1"]["utterance_count"] == 2
    assert speakers["Speaker 1"]["speaking_seconds"] == 4.5
    assert speakers["Speaker 2"]["utterance_count"] == 1
    assert "Speaker 1" in metadata["unresolved_speakers"]
    assert "Speaker 2" in metadata["unresolved_speakers"]


def test_self_identification_maps_unique_attendee_name() -> None:
    payload = {
        "segments": [
            {
                "speaker": "Speaker 1",
                "start": 0.0,
                "end": 2.5,
                "text": "Hi everyone, I'm Alice and I'll run through the update.",
            },
            {
                "speaker": "Speaker 2",
                "start": 2.5,
                "end": 6.0,
                "text": "Thanks Alice, this is Bob.",
            },
        ]
    }
    attendees = [
        {"name": "Alice Nguyen", "email": "alice@example.com", "user_id": "u-alice"},
        {"name": "Bob Lee", "email": "bob@example.com", "user_id": "u-bob"},
    ]

    metadata = build_speaker_metadata(
        transcript_payload=payload,
        attendee_candidates=attendees,
        min_confidence=0.85,
    )

    speaker_1 = next(item for item in metadata["speakers"] if item["label"] == "Speaker 1")
    assert speaker_1["identity"]["display_name"] == "Alice Nguyen"
    assert speaker_1["identity"]["confidence"] >= 0.85
    assert "self_identification" in speaker_1["identity"]["evidence"]


def test_visual_evidence_can_resolve_without_self_intro() -> None:
    payload = {
        "segments": [
            {"speaker": "Speaker 1", "start": 0.0, "end": 2.0, "text": "Can we ship this?"},
            {"speaker": "Speaker 2", "start": 2.0, "end": 4.0, "text": "I need one day."},
        ]
    }
    attendees = [
        {"name": "Alice Nguyen", "email": "alice@example.com", "user_id": "u-alice"},
        {"name": "Bob Lee", "email": "bob@example.com", "user_id": "u-bob"},
    ]
    visual = {
        "Speaker 1": ["Alice Nguyen", "Alice Nguyen", "Alice Nguyen", "Alice Nguyen"]
    }

    metadata = build_speaker_metadata(
        transcript_payload=payload,
        attendee_candidates=attendees,
        visual_name_evidence=visual,
        min_confidence=0.85,
    )

    speaker_1 = next(item for item in metadata["speakers"] if item["label"] == "Speaker 1")
    assert speaker_1["identity"]["display_name"] == "Alice Nguyen"
    assert "visual_ocr" in speaker_1["identity"]["evidence"]


def test_ambiguous_first_name_stays_unresolved() -> None:
    payload = {
        "segments": [
            {
                "speaker": "Speaker 1",
                "start": 0.0,
                "end": 2.0,
                "text": "Morning, I'm Alice and I handle support.",
            }
        ]
    }
    attendees = [
        {"name": "Alice Nguyen", "email": "alice@example.com", "user_id": "u-a1"},
        {"name": "Alice Johnson", "email": "alice.j@example.com", "user_id": "u-a2"},
    ]

    metadata = build_speaker_metadata(
        transcript_payload=payload,
        attendee_candidates=attendees,
        min_confidence=0.85,
    )

    speaker_1 = metadata["speakers"][0]
    assert "identity" not in speaker_1
    assert metadata["unresolved_speakers"] == ["Speaker 1"]


if __name__ == "__main__":
    tests = [
        test_build_speaker_metadata_counts_and_stats,
        test_self_identification_maps_unique_attendee_name,
        test_visual_evidence_can_resolve_without_self_intro,
        test_ambiguous_first_name_stays_unresolved,
    ]

    failures = 0
    for test in tests:
        try:
            test()
            print(f"PASS: {test.__name__}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"FAIL: {test.__name__}: {exc}")

    if failures:
        raise SystemExit(1)
