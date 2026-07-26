"""Optional filesystem watcher with debounce (Phase 5)."""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from pathlib import Path

logger = logging.getLogger(__name__)


class WorkspaceWatcher:
    """
    Lightweight poll-based watcher (no watchdog dependency).
    Debounces change notifications then invokes on_change(workspace_id).
    """

    def __init__(
        self,
        *,
        debounce_ms: int = 400,
        poll_interval_s: float = 2.0,
    ):
        self.debounce_ms = debounce_ms
        self.poll_interval_s = poll_interval_s
        self._threads: dict[str, threading.Thread] = {}
        self._stop = threading.Event()
        self._roots: dict[str, Path] = {}
        self._snapshots: dict[str, dict[str, tuple[int, float]]] = {}
        self._on_change: Callable[[str], None] | None = None
        self._pending: dict[str, float] = {}
        self._lock = threading.Lock()

    def start(
        self,
        workspace_id: str,
        root: Path,
        on_change: Callable[[str], None],
    ) -> None:
        self._on_change = on_change
        with self._lock:
            self._roots[workspace_id] = root
            self._snapshots[workspace_id] = self._snapshot(root)
            if workspace_id in self._threads and self._threads[workspace_id].is_alive():
                return
            t = threading.Thread(
                target=self._loop,
                args=(workspace_id,),
                name=f"ws-watch-{workspace_id[:8]}",
                daemon=True,
            )
            self._threads[workspace_id] = t
            t.start()

    def stop(self, workspace_id: str | None = None) -> None:
        if workspace_id is None:
            self._stop.set()
            with self._lock:
                self._roots.clear()
            return
        with self._lock:
            self._roots.pop(workspace_id, None)
            self._snapshots.pop(workspace_id, None)
            self._pending.pop(workspace_id, None)

    def _loop(self, workspace_id: str) -> None:
        while not self._stop.is_set():
            with self._lock:
                root = self._roots.get(workspace_id)
            if root is None:
                break
            try:
                snap = self._snapshot(root)
                old = self._snapshots.get(workspace_id, {})
                if snap != old:
                    self._snapshots[workspace_id] = snap
                    self._pending[workspace_id] = time.monotonic()
            except OSError as exc:
                logger.debug("watcher snapshot failed: %s", exc)
            # debounce flush
            now = time.monotonic()
            due = self._pending.get(workspace_id)
            if due is not None and (now - due) * 1000 >= self.debounce_ms:
                self._pending.pop(workspace_id, None)
                cb = self._on_change
                if cb:
                    try:
                        cb(workspace_id)
                    except Exception:  # noqa: BLE001
                        logger.exception("watcher on_change failed")
            time.sleep(self.poll_interval_s)

    def _snapshot(self, root: Path) -> dict[str, tuple[int, float]]:
        """Shallow+sampled snapshot for change detection (not full scan)."""
        out: dict[str, tuple[int, float]] = {}
        try:
            for i, p in enumerate(root.rglob("*")):
                if i > 5000:
                    break
                if p.is_file():
                    try:
                        st = p.stat()
                        out[str(p)] = (st.st_size, st.st_mtime)
                    except OSError:
                        continue
        except OSError:
            pass
        return out
