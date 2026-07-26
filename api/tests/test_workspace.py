"""Unit tests for workspace path jail, filter, gitignore, scanner."""

from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path

from app.features.workspace.domain.errors import InvalidRootPath, PathOutsideRoot
from app.features.workspace.infrastructure.directory_filter import DirectoryFilter
from app.features.workspace.infrastructure.gitignore import GitIgnoreMatcher
from app.features.workspace.infrastructure.local_adapter import LocalDiskWorkspaceAdapter
from app.features.workspace.infrastructure.memory_index import MemorySessionIndex
from app.features.workspace.infrastructure.path_jail import normalize_root, resolve_under_root
from app.features.workspace.infrastructure.scanner import WorkspaceScanner
from app.features.workspace.infrastructure.sqlite_cache import SqliteWorkspaceCache


class PathJailTests(unittest.TestCase):
    def test_normalize_and_jail(self):
        with tempfile.TemporaryDirectory() as td:
            root = normalize_root(td)
            inside = resolve_under_root(root, "a/b.txt")
            self.assertTrue(str(inside).startswith(str(root)))
            with self.assertRaises(PathOutsideRoot):
                resolve_under_root(root, "../outside.txt")

    def test_invalid_root(self):
        with self.assertRaises(InvalidRootPath):
            normalize_root("")
        with self.assertRaises(InvalidRootPath):
            normalize_root("/this/path/definitely/does/not/exist-xyz-aitest")


class FilterGitignoreTests(unittest.TestCase):
    def test_deny_node_modules(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            filt = DirectoryFilter(root)
            self.assertTrue(filt.should_skip_dir(root / "node_modules", "node_modules"))
            self.assertFalse(filt.should_skip_dir(root / "src", "src"))

    def test_gitignore_patterns(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / ".gitignore").write_text("*.log\nsecret/\n", encoding="utf-8")
            gi = GitIgnoreMatcher.from_root(root)
            self.assertTrue(gi.matches_file(root / "a.log", root))
            self.assertTrue(gi.matches_dir(root / "secret", root))
            self.assertFalse(gi.matches_file(root / "a.py", root))


class ScannerAdapterTests(unittest.TestCase):
    def test_scan_and_search_read(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "src").mkdir()
            (root / "src" / "LoginService.cs").write_text("class LoginService {}", encoding="utf-8")
            (root / "node_modules").mkdir()
            (root / "node_modules" / "x.js").write_text("ignored", encoding="utf-8")
            (root / ".gitignore").write_text("*.tmp\n", encoding="utf-8")
            (root / "skip.tmp").write_text("x", encoding="utf-8")

            db = Path(td) / "meta.db"
            cache = SqliteWorkspaceCache(db)
            mem = MemorySessionIndex()
            adapter = LocalDiskWorkspaceAdapter(cache, mem, scanner=WorkspaceScanner())
            session = adapter.open("11111111-1111-1111-1111-111111111111", str(root))
            # wait for background scan
            for _ in range(50):
                st = adapter.get_status(session.workspace_id)
                if st and st.status.value == "ready":
                    break
                time.sleep(0.05)
            st = adapter.get_status(session.workspace_id)
            self.assertIsNotNone(st)
            assert st is not None
            self.assertEqual(st.status.value, "ready")
            self.assertGreaterEqual(st.file_count, 1)

            items, total = adapter.list_files(session.workspace_id, q="Login")
            self.assertGreaterEqual(total, 1)
            self.assertTrue(any("LoginService" in i.relative_path for i in items))

            hits = adapter.search(
                session.workspace_id,
                __import__(
                    "app.features.workspace.domain.models", fromlist=["SearchQuery"]
                ).SearchQuery(by="token", query="LoginService", limit=10),
            )
            self.assertTrue(hits)

            reads = adapter.read_files(session.workspace_id, ["src/LoginService.cs"])
            self.assertEqual(len(reads), 1)
            self.assertIn("LoginService", reads[0].content)

            # path jail
            bad = adapter.read_files(session.workspace_id, ["../etc/passwd"])
            self.assertTrue(bad[0].error)


if __name__ == "__main__":
    unittest.main()
