"""Default directory denylist + gitignore-aware filter."""

from __future__ import annotations

from pathlib import Path

from app.features.workspace.infrastructure.gitignore import GitIgnoreMatcher

DEFAULT_DENY_DIRS = frozenset(
    {
        ".git",
        "node_modules",
        "dist",
        "build",
        "target",
        "obj",
        "bin",
        "__pycache__",
        "venv",
        ".venv",
        ".idea",
        ".vscode",
        ".ai-test",
        ".next",
        "coverage",
        ".tox",
        ".mypy_cache",
        ".pytest_cache",
        "vendor",
    }
)

# Hidden dirs we still enter
_ALLOW_HIDDEN_DIRS = frozenset({".github", ".config"})


class DirectoryFilter:
    def __init__(
        self,
        root: Path,
        *,
        deny_dirs: frozenset[str] | None = None,
        gitignore: GitIgnoreMatcher | None = None,
    ):
        self.root = root
        self.deny_dirs = deny_dirs or DEFAULT_DENY_DIRS
        self.gitignore = gitignore

    def should_skip_dir(self, dir_path: Path, dir_name: str) -> bool:
        if dir_name in self.deny_dirs:
            return True
        if dir_name.startswith(".") and dir_name not in _ALLOW_HIDDEN_DIRS:
            return True
        if self.gitignore and self.gitignore.matches_dir(dir_path, self.root):
            return True
        return False

    def should_skip_file(self, file_path: Path) -> bool:
        name = file_path.name
        if name in {".DS_Store", "Thumbs.db"}:
            return True
        if self.gitignore and self.gitignore.matches_file(file_path, self.root):
            return True
        return False
