"""Map file extension → language label."""

from __future__ import annotations

_EXT_LANG: dict[str, str] = {
    ".cs": "csharp",
    ".fs": "fsharp",
    ".vb": "vbnet",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".pyi": "python",
    ".java": "java",
    ".kt": "kotlin",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".m": "objc",
    ".mm": "objcpp",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".c": "c",
    ".scala": "scala",
    ".sql": "sql",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".json": "json",
    ".xml": "xml",
    ".md": "markdown",
    ".html": "html",
    ".css": "css",
    ".scss": "scss",
}


class LanguageDetector:
    def detect(self, path_or_ext: str) -> str:
        p = path_or_ext.replace("\\", "/").lower()
        if "." not in p.rsplit("/", 1)[-1]:
            ext = p if p.startswith(".") else f".{p}"
        else:
            name = p.rsplit("/", 1)[-1]
            idx = name.rfind(".")
            ext = name[idx:] if idx >= 0 else ""
        return _EXT_LANG.get(ext, "unknown")

    def is_source_ext(self, ext: str) -> bool:
        e = ext if ext.startswith(".") else f".{ext}"
        return e.lower() in _EXT_LANG
