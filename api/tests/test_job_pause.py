"""Cooperative pause/resume for TC generate jobs."""

from __future__ import annotations

from app.services.job_pause import (
    clear_job_control,
    clear_pause_request,
    is_pause_requested,
    load_checkpoint,
    pending_modules_after_claim,
    remaining_modules,
    request_pause,
    save_checkpoint,
)


def test_pause_request_flag():
    jid = "job-pause-1"
    clear_job_control(jid)
    assert not is_pause_requested(jid)
    request_pause(jid)
    assert is_pause_requested(jid)
    clear_pause_request(jid)
    assert not is_pause_requested(jid)


def test_checkpoint_roundtrip_for_resume():
    jid = "job-pause-2"
    clear_job_control(jid)
    save_checkpoint(
        jid,
        {
            "pendingModules": ["Auth", "Billing"],
            "doneModules": ["Login"],
            "allModules": ["Login", "Auth", "Billing"],
            "engineHint": {"preferredEngine": "unit"},
            "savedCount": 12,
            "mode": "append",
        },
    )
    cp = load_checkpoint(jid)
    assert cp is not None
    assert cp["pendingModules"] == ["Auth", "Billing"]
    assert cp["savedCount"] == 12
    assert cp["engineHint"]["preferredEngine"] == "unit"
    assert cp["allModules"][0] == "Login"
    # Resume must not wipe done / pending until clear
    assert load_checkpoint(jid)["pendingModules"] == ["Auth", "Billing"]
    clear_job_control(jid)
    assert load_checkpoint(jid) is None


def test_checkpoint_survives_memory_clear_via_disk():
    """API reload: memory empty but disk checkpoint still loads for continue."""
    jid = "job-pause-disk"
    clear_job_control(jid)
    save_checkpoint(
        jid,
        {
            "pendingModules": ["Reports"],
            "doneModules": ["A", "B"],
            "allModules": ["A", "B", "Reports"],
            "savedCount": 8,
        },
    )
    # Simulate process memory loss
    from app.services import job_pause as jp

    with jp._lock:
        jp._checkpoints.pop(str(jid), None)
    cp = load_checkpoint(jid)
    assert cp is not None
    assert cp["pendingModules"] == ["Reports"]
    assert "A" in cp["doneModules"]
    clear_job_control(jid)


def test_pause_preserves_saved_count_semantics():
    """Resume continues append — checkpoint carries savedCount for progress continuity."""
    jid = "job-pause-3"
    clear_job_control(jid)
    save_checkpoint(
        jid,
        {
            "pendingModules": ["Reports"],
            "doneModules": ["A", "B"],
            "savedCount": 20,
            "engineHint": {},
        },
    )
    cp = load_checkpoint(jid)
    assert cp["savedCount"] == 20
    assert "Reports" in cp["pendingModules"]
    assert "A" in cp["doneModules"]
    clear_job_control(jid)


def test_pending_modules_after_claim_leaves_unclaimed():
    """Claim-index pause: only titles beyond next_claim stay pending."""
    titles = ["A", "B", "C", "D", "E"]
    # concurrency=2 claimed A,B → next_claim=2 → pending C,D,E
    assert pending_modules_after_claim(titles, 2, done=["A"]) == ["C", "D", "E"]
    # all claimed → nothing pending
    assert pending_modules_after_claim(titles, 5, done=titles) == []
    # pause before any claim
    assert pending_modules_after_claim(titles, 0) == titles


def test_remaining_modules_preserves_order_skips_done():
    titles = ["A", "B", "C", "D"]
    assert remaining_modules(titles, ["B", "A"]) == ["C", "D"]
    assert remaining_modules(titles, titles) == []
    # Resume must not put done modules back into the queue
    pending = remaining_modules(titles, ["A", "B"])
    assert "A" not in pending and "B" not in pending
