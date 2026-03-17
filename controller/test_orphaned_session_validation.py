from __future__ import annotations

from datetime import datetime, timedelta, timezone


class _FakeSessionDoc:
    def __init__(self, doc_id: str, data: dict):
        self.id = doc_id
        self._data = data
        self.reference = object()

    def to_dict(self):
        return self._data


class _FakeQuery:
    def __init__(self, docs):
        self._docs = docs

    def where(self, **kwargs):
        return self

    def limit(self, _limit):
        return self

    def stream(self):
        return iter(self._docs)


class _FakeDB:
    def __init__(self, docs):
        self._docs = docs

    def collection_group(self, _name):
        return _FakeQuery(self._docs)


class _FakeBatchV1:
    def __init__(self, jobs):
        self._jobs = jobs

    def list_namespaced_job(self, namespace, label_selector):
        return type("JobList", (), {"items": self._jobs})()


class _FakeCondition:
    def __init__(self, cond_type: str, status: str):
        self.type = cond_type
        self.status = status


class _FakeJob:
    def __init__(self, *, name: str, labels: dict, conditions=None):
        self.metadata = type("Meta", (), {"name": name, "labels": labels})()
        self.status = type("Status", (), {"conditions": conditions or []})()


def _import_controller():
    import importlib.util
    import sys
    import types
    from pathlib import Path

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

    k8s_rest = sys.modules["kubernetes.client.rest"]
    k8s_rest.ApiException = Exception  # type: ignore[attr-defined]

    firestore_mod = sys.modules["google.cloud.firestore"]
    firestore_mod.DocumentSnapshot = object  # type: ignore[attr-defined]
    firestore_mod.DocumentReference = object  # type: ignore[attr-defined]
    firestore_mod.Transaction = object  # type: ignore[attr-defined]
    firestore_mod.transactional = lambda f: f  # type: ignore[attr-defined]

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


def _build_controller(*, docs, jobs):
    MeetingController = _import_controller()
    controller = MeetingController.__new__(MeetingController)
    controller.db = _FakeDB(docs)
    controller.batch_v1 = _FakeBatchV1(jobs)
    controller.k8s_namespace = "default"
    controller.orphaned_session_validation_limit = 50
    controller.orphaned_session_remediation_enabled = True
    controller.orphaned_session_remediation_min_age_minutes = 10
    controller.orphaned_session_remediation_max_per_cycle = 5
    controller.orphaned_session_remediation_action = "requeue"
    return controller


def test_validate_claimed_sessions_remediates_old_orphans():
    claimed_at = datetime.now(timezone.utc) - timedelta(minutes=30)
    session = _FakeSessionDoc(
        "session-old",
        {
            "status": "processing",
            "org_id": "org-1",
            "meeting_url": "https://teams.microsoft.com/l/meeting-join/abc",
            "claimed_at": claimed_at,
        },
    )
    controller = _build_controller(docs=[session], jobs=[])

    remediation_calls = []

    def _record_remediation(*args, **kwargs):
        remediation_calls.append(kwargs)
        return True

    controller._remediate_orphaned_session = _record_remediation  # noqa: SLF001
    controller._validate_claimed_sessions_have_jobs()  # noqa: SLF001

    assert len(remediation_calls) == 1
    assert remediation_calls[0]["session_id"] == "session-old"
    assert remediation_calls[0]["previous_status"] == "processing"


def test_validate_claimed_sessions_skips_young_orphans():
    claimed_at = datetime.now(timezone.utc) - timedelta(minutes=2)
    session = _FakeSessionDoc(
        "session-young",
        {
            "status": "processing",
            "org_id": "org-1",
            "meeting_url": "https://teams.microsoft.com/l/meeting-join/abc",
            "claimed_at": claimed_at,
        },
    )
    controller = _build_controller(docs=[session], jobs=[])

    remediation_calls = []

    def _record_remediation(*args, **kwargs):
        remediation_calls.append(kwargs)
        return True

    controller._remediate_orphaned_session = _record_remediation  # noqa: SLF001
    controller._validate_claimed_sessions_have_jobs()  # noqa: SLF001

    assert remediation_calls == []


def test_validate_claimed_sessions_ignores_active_matching_job():
    meeting_url = "https://teams.microsoft.com/l/meeting-join/abc"
    claimed_at = datetime.now(timezone.utc) - timedelta(minutes=30)
    session = _FakeSessionDoc(
        "session-has-job",
        {
            "status": "processing",
            "org_id": "org-1",
            "meeting_url": meeting_url,
            "claimed_at": claimed_at,
        },
    )
    controller = _build_controller(docs=[session], jobs=[])
    org_hash = controller._org_id_hash("org-1")  # noqa: SLF001
    url_hash = controller._meeting_url_hash(meeting_url)  # noqa: SLF001
    active_job = _FakeJob(
        name="meeting-bot-active",
        labels={"org_id_hash": org_hash, "meeting_url_hash": url_hash},
        conditions=[_FakeCondition("Complete", "False")],
    )
    controller.batch_v1 = _FakeBatchV1([active_job])

    remediation_calls = []

    def _record_remediation(*args, **kwargs):
        remediation_calls.append(kwargs)
        return True

    controller._remediate_orphaned_session = _record_remediation  # noqa: SLF001
    controller._validate_claimed_sessions_have_jobs()  # noqa: SLF001

    assert remediation_calls == []
