from __future__ import annotations


def _import_controller():
    # Import controller/main.py directly with dependency stubs.
    import sys
    import types
    from pathlib import Path
    import importlib.util

    controller_dir = Path(__file__).resolve().parent

    for mod in [
        "google",
        "google.cloud",
        "google.cloud.firestore",
        "google.cloud.storage",
        "google.cloud.pubsub_v1",
        "google.cloud.pubsub_v1.subscriber",
        "google.cloud.pubsub_v1.subscriber.message",
        "kubernetes",
        "kubernetes.client",
        "kubernetes.config",
        "kubernetes.client.rest",
    ]:
        sys.modules.setdefault(mod, types.ModuleType(mod))

    # Minimal types referenced in annotations.
    firestore_mod = sys.modules["google.cloud.firestore"]
    firestore_mod.DocumentSnapshot = object  # type: ignore[attr-defined]
    firestore_mod.DocumentReference = object  # type: ignore[attr-defined]
    firestore_mod.Transaction = object  # type: ignore[attr-defined]

    # Provide decorator used in controller code.
    transactional = lambda f: f  # noqa: E731
    firestore_mod.transactional = transactional  # type: ignore[attr-defined]

    k8s_rest = sys.modules["kubernetes.client.rest"]
    k8s_rest.ApiException = Exception  # type: ignore[attr-defined]

    sys.modules["google.cloud.pubsub_v1"].subscriber = sys.modules[
        "google.cloud.pubsub_v1.subscriber"
    ]  # type: ignore[attr-defined]
    sys.modules["google.cloud.pubsub_v1.subscriber"].message = sys.modules[
        "google.cloud.pubsub_v1.subscriber.message"
    ]  # type: ignore[attr-defined]
    sys.modules["google.cloud.pubsub_v1.subscriber.message"].Message = (
        object  # type: ignore[attr-defined]
    )

    spec = importlib.util.spec_from_file_location(
        "controller_main", controller_dir / "main.py"
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod.MeetingController


class _FakeSnap:
    def __init__(self, doc_id: str, data: dict, exists: bool = True):
        self.id = doc_id
        self._data = data
        self.exists = exists

    def to_dict(self):
        return self._data


class _FakeBlob:
    def __init__(self, *, name: str, exists: bool = False, text: str = ""):
        self.name = name
        self._exists = exists
        self._text = text

    def exists(self):
        return self._exists

    def download_as_text(self):
        return self._text


class _FakeBucket:
    def __init__(self, blobs: dict[str, _FakeBlob]):
        self._blobs = blobs

    def blob(self, name: str):
        return self._blobs.setdefault(name, _FakeBlob(name=name, exists=False))

    def copy_blob(self, src_blob, dst_bucket, new_name: str):
        # For this unit test, copying is irrelevant.
        return None


class _FakeDocRef:
    def __init__(self, path: str, store: list[tuple[str, dict]]):
        self.path = path
        self._store = store

    def set(self, payload: dict, merge: bool = True):
        self._store.append((self.path, payload))

    def get(self):
        """Return a fake snapshot for document reads."""
        return _FakeSnap(self.path.split("/")[-1], {}, exists=False)


class _FakeMeetingsCollection:
    def __init__(self, org_id: str, store: list[tuple[str, dict]]):
        self._org_id = org_id
        self._store = store

    def document(self, meeting_doc_id: str):
        path = f"organizations/{self._org_id}/meetings/{meeting_doc_id}"
        return _FakeDocRef(path, self._store)


class _FakeOrgDoc:
    def __init__(self, org_id: str, store: list[tuple[str, dict]]):
        self._org_id = org_id
        self._store = store

    def collection(self, name: str):
        assert name == "meetings"
        return _FakeMeetingsCollection(self._org_id, self._store)


class _FakeOrgsCollection:
    def __init__(self, store: list[tuple[str, dict]]):
        self._store = store

    def document(self, org_id: str):
        return _FakeOrgDoc(org_id, self._store)


class _FakeFirestore:
    def __init__(self, store: list[tuple[str, dict]]):
        self._store = store

    def collection(self, name: str):
        if name == "organizations":
            return _FakeOrgsCollection(self._store)
        elif name == "users":
            return _FakeUsersCollection()
        # Handle path-style collection access like "organizations/org1/meetings"
        if "/" in name:
            return _FakePathCollection(name, self._store)
        return _FakeOrgsCollection(self._store)

    def document(self, path: str):
        """Handle document path lookups."""
        return _FakeDocRef(path, self._store)


class _FakeUsersCollection:
    """Fake users collection for email lookups."""

    def where(self, **kwargs):
        return self

    def limit(self, n):
        return self

    def stream(self):
        return []  # No users found


class _FakePathCollection:
    """Fake collection for path-style access."""

    def __init__(self, path: str, store: list[tuple[str, dict]]):
        self._path = path
        self._store = store

    def where(self, **kwargs):
        return self

    def limit(self, n):
        return self

    def stream(self):
        return []

    def document(self, doc_id: str = None):
        if doc_id:
            return _FakeDocRef(f"{self._path}/{doc_id}", self._store)
        return _FakeDocRef(f"{self._path}/new_doc", self._store)


class _FakeSessionRef:
    def __init__(self, *, session_data: dict, subscribers: list[dict], store: list):
        self._session_data = session_data
        self._subscribers = subscribers
        self._store = store

    def get(self):
        return _FakeSnap("sess", self._session_data, exists=True)

    def collection(self, name: str):
        assert name == "subscribers"
        return self

    def stream(self):
        # Return fake subscriber snapshots.
        subs = []
        for s in self._subscribers:
            snap = _FakeSnap(s.get("user_id") or "user", s, exists=True)
            # Provide a reference with .set for status updates.
            snap.reference = _FakeDocRef(
                f"subscribers/{snap.id}",
                self._store,  # type: ignore[attr-defined]
            )
            subs.append(snap)
        return subs

    def set(self, payload: dict, merge: bool = True):
        self._store.append(("session", payload))


def test_fanout_writes_transcription_to_meeting_doc_id():
    MeetingController = _import_controller()
    c = MeetingController.__new__(MeetingController)

    writes: list[tuple[str, dict]] = []

    # Patch minimal dependencies used by fanout.
    c.db = _FakeFirestore(writes)
    c.gcs_bucket = "bucket"
    # The source path is derived from first subscriber: recordings/{user_id}/{meeting_id}
    c.gcs_bucket_client = _FakeBucket(
        {
            "recordings/u1/meetingDocA/transcript.txt": _FakeBlob(
                name="recordings/u1/meetingDocA/transcript.txt",
                exists=True,
                text="hello world",
            ),
            "recordings/u1/meetingDocA/transcript.json": _FakeBlob(
                name="recordings/u1/meetingDocA/transcript.json",
                exists=True,
                text='{"transcription_metadata":{"speaker_count":2,"speakers":[{"label":"Speaker 1"}]}}',
            ),
        }
    )

    c._list_gcs_prefix = lambda prefix: [
        "recordings/u1/meetingDocA/recording.webm",
        "recordings/u1/meetingDocA/transcript.txt",
        "recordings/u1/meetingDocA/transcript.json",
    ]
    c._gcs_blob_exists = lambda name: True
    c._copy_gcs_blob = lambda **kwargs: None

    # Mock new attendee fanout methods - return empty to skip attendee logic
    c._get_fresh_meeting_attendees = lambda org_id, meeting_id: []
    c._get_org_user_ids_for_attendees = lambda org_id, emails: {}
    c._validate_fanout_results = lambda **kwargs: {
        "success": True,
        "total_subscribers": 2,
        "validated": 2,
        "errors": [],
    }

    # Fake session ref returned by helper.
    session_ref = _FakeSessionRef(
        session_data={"canonical_gcs_path": "recordings/u1/meetingDocA"},
        subscribers=[
            {
                "user_id": "u1",
                "fs_meeting_id": "meetingDocA",
                "meeting_path": "organizations/org1/meetings/meetingDocA",
            },
            {
                "user_id": "u2",
                "fs_meeting_id": "meetingDocB",
                "meeting_path": "organizations/org1/meetings/meetingDocB",
            },
        ],
        store=writes,
    )
    c._meeting_session_ref = lambda **kwargs: session_ref

    # Execute.
    c._fanout_meeting_session_artifacts(org_id="org1", session_id="sess123")

    # Assert we wrote the transcription to the per-user meeting doc ids.
    meeting_writes = [
        w for w in writes if w[0].startswith("organizations/org1/meetings/")
    ]
    paths = {p for p, _ in meeting_writes}

    assert "organizations/org1/meetings/meetingDocA" in paths
    assert "organizations/org1/meetings/meetingDocB" in paths

    for path, payload in meeting_writes:
        assert payload.get("transcription") == "hello world"
        assert payload.get("transcription_metadata", {}).get("speaker_count") == 2


if __name__ == "__main__":
    test_fanout_writes_transcription_to_meeting_doc_id()
    print("PASS: test_fanout_writes_transcription_to_meeting_doc_id")
