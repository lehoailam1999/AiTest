"""SQLite metadata cache — no source content."""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

from app.features.workspace.domain.models import FileMeta


_SCHEMA = """
CREATE TABLE IF NOT EXISTS workspace_files (
    workspace_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    absolute_path TEXT NOT NULL,
    extension TEXT,
    language TEXT,
    size INTEGER,
    last_modified REAL,
    meta_hash TEXT,
    PRIMARY KEY (workspace_id, relative_path)
);
CREATE INDEX IF NOT EXISTS ix_ws_files_ext ON workspace_files(workspace_id, extension);
CREATE INDEX IF NOT EXISTS ix_ws_files_lang ON workspace_files(workspace_id, language);
CREATE INDEX IF NOT EXISTS ix_ws_files_rel ON workspace_files(workspace_id, relative_path);

CREATE TABLE IF NOT EXISTS workspace_sessions (
    workspace_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    root_path TEXT NOT NULL,
    status TEXT NOT NULL,
    file_count INTEGER DEFAULT 0,
    progress REAL DEFAULT 0,
    error_message TEXT,
    scan_generation INTEGER DEFAULT 0,
    opened_at TEXT
);
"""


class SqliteWorkspaceCache:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._init()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def _init(self) -> None:
        with self._lock:
            conn = self._connect()
            try:
                conn.executescript(_SCHEMA)
                conn.commit()
            finally:
                conn.close()

    def replace_files(self, workspace_id: str, files: list[FileMeta]) -> None:
        with self._lock:
            conn = self._connect()
            try:
                conn.execute(
                    "DELETE FROM workspace_files WHERE workspace_id = ?",
                    (workspace_id,),
                )
                conn.executemany(
                    """
                    INSERT INTO workspace_files(
                        workspace_id, relative_path, absolute_path, extension,
                        language, size, last_modified, meta_hash
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    [
                        (
                            f.workspace_id,
                            f.relative_path,
                            f.path,
                            f.extension,
                            f.language,
                            f.size,
                            f.last_modified,
                            f.meta_hash,
                        )
                        for f in files
                    ],
                )
                conn.commit()
            finally:
                conn.close()

    def list_files(
        self,
        workspace_id: str,
        *,
        ext: str | None = None,
        q: str | None = None,
        limit: int = 100,
        cursor: int = 0,
    ) -> tuple[list[FileMeta], int]:
        clauses = ["workspace_id = ?"]
        params: list[object] = [workspace_id]
        if ext:
            e = ext if ext.startswith(".") else f".{ext}"
            clauses.append("extension = ?")
            params.append(e.lower())
        if q:
            clauses.append("relative_path LIKE ?")
            params.append(f"%{q.replace('\\', '/')}%")
        where = " AND ".join(clauses)
        with self._lock:
            conn = self._connect()
            try:
                total = conn.execute(
                    f"SELECT COUNT(*) AS c FROM workspace_files WHERE {where}",
                    params,
                ).fetchone()["c"]
                rows = conn.execute(
                    f"""
                    SELECT * FROM workspace_files
                    WHERE {where}
                    ORDER BY relative_path
                    LIMIT ? OFFSET ?
                    """,
                    [*params, limit, cursor],
                ).fetchall()
            finally:
                conn.close()
        return [self._row_to_meta(r) for r in rows], int(total)

    def search(
        self,
        workspace_id: str,
        *,
        by: str,
        query: str,
        limit: int = 50,
    ) -> list[FileMeta]:
        q = (query or "").strip()
        if not q:
            return []
        with self._lock:
            conn = self._connect()
            try:
                if by == "ext":
                    e = q if q.startswith(".") else f".{q}"
                    rows = conn.execute(
                        """
                        SELECT * FROM workspace_files
                        WHERE workspace_id = ? AND extension = ?
                        ORDER BY relative_path LIMIT ?
                        """,
                        (workspace_id, e.lower(), limit),
                    ).fetchall()
                elif by == "token":
                    # token may appear in stem/path
                    like = f"%{q}%"
                    rows = conn.execute(
                        """
                        SELECT * FROM workspace_files
                        WHERE workspace_id = ?
                          AND (relative_path LIKE ? COLLATE NOCASE
                               OR absolute_path LIKE ? COLLATE NOCASE)
                        ORDER BY
                          CASE WHEN relative_path LIKE ? COLLATE NOCASE THEN 0 ELSE 1 END,
                          relative_path
                        LIMIT ?
                        """,
                        (workspace_id, like, like, f"%/{q}.%", limit),
                    ).fetchall()
                else:
                    # name | keyword → path substring
                    like = f"%{q.replace(chr(92), '/')}%"
                    rows = conn.execute(
                        """
                        SELECT * FROM workspace_files
                        WHERE workspace_id = ? AND relative_path LIKE ? COLLATE NOCASE
                        ORDER BY relative_path LIMIT ?
                        """,
                        (workspace_id, like, limit),
                    ).fetchall()
            finally:
                conn.close()
        return [self._row_to_meta(r) for r in rows]

    def delete_workspace(self, workspace_id: str) -> None:
        with self._lock:
            conn = self._connect()
            try:
                conn.execute(
                    "DELETE FROM workspace_files WHERE workspace_id = ?",
                    (workspace_id,),
                )
                conn.execute(
                    "DELETE FROM workspace_sessions WHERE workspace_id = ?",
                    (workspace_id,),
                )
                conn.commit()
            finally:
                conn.close()

    @staticmethod
    def _row_to_meta(row: sqlite3.Row) -> FileMeta:
        return FileMeta(
            workspace_id=row["workspace_id"],
            path=row["absolute_path"],
            relative_path=row["relative_path"],
            extension=row["extension"] or "",
            language=row["language"] or "unknown",
            size=int(row["size"] or 0),
            last_modified=float(row["last_modified"] or 0),
            meta_hash=row["meta_hash"] or "",
        )
