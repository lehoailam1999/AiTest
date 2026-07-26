"""Tests for BE generate-scope dependency expansion."""

from __future__ import annotations

import asyncio

from app.features.workspace.generate_scope import resolve_generate_scope
from app.features.workspace.infrastructure.import_extract import (
    candidate_paths_for_spec,
    extract_import_specs,
    resolve_relative_spec,
)


class _FakeSvc:
    def __init__(self, files: dict[str, str]):
        self.files = {k.replace("\\", "/"): v for k, v in files.items()}

    def read(self, workspace_id: str, body: dict):
        out = []
        for p in body.get("paths") or []:
            rel = str(p).replace("\\", "/")
            content = self.files.get(rel, "")
            # case-insensitive
            if not content:
                for k, v in self.files.items():
                    if k.lower() == rel.lower():
                        content = v
                        rel = k
                        break
            out.append({"relativePath": rel, "content": content})
        return {"files": out}

    def search(self, workspace_id: str, body: dict):
        q = str(body.get("query") or "").lower()
        items = []
        for path in self.files:
            stem = path.rsplit("/", 1)[-1].rsplit(".", 1)[0].lower()
            if q in path.lower() or q == stem or stem.startswith(q):
                items.append({"relativePath": path})
        return {"items": items[: int(body.get("limit") or 8)]}

    def build_context(self, workspace_id: str, tokens: list[str], *, max_related: int = 12):
        raise AssertionError("should not fall back when primary forced")


def test_extract_ts_imports_and_relative():
    content = """
import { UserRepository } from './user.repository';
import { JwtService } from '../jwt/jwt.service';
export class AuthService {
  constructor(private users: UserRepository, private jwt: JwtService) {}
  login() {}
}
"""
    specs = extract_import_specs(content, path="src/auth/auth.service.ts", language="TypeScript")
    assert "./user.repository" in specs
    assert "../jwt/jwt.service" in specs
    assert resolve_relative_spec("./user.repository", "src/auth/auth.service.ts") == "src/auth/user.repository"
    cands = candidate_paths_for_spec("./user.repository", "src/auth/auth.service.ts")
    assert any(c.endswith("user.repository.ts") for c in cands)


def test_resolve_generate_scope_expands_related():
    svc = _FakeSvc(
        {
            "src/auth/auth.service.ts": (
                "import { UserRepository } from './user.repository';\n"
                "export class AuthService {\n"
                "  constructor(private users: UserRepository) {}\n"
                "  login() { return this.users.find(); }\n"
                "}\n"
            ),
            "src/auth/user.repository.ts": "export class UserRepository { find() { return 1; } }\n",
            "src/auth/auth.dto.ts": "export class AuthDto {}\n",
        }
    )

    async def _run():
        return await resolve_generate_scope(
            svc,
            "ws1",
            module="Auth",
            title="Login",
            body={
                "sourceFileName": "src/auth/auth.service.ts",
                "relatedPaths": [],
                "language": "TypeScript",
            },
        )

    scope = asyncio.run(_run())
    assert scope["primary"] == "src/auth/auth.service.ts"
    assert "AuthService" in scope["primaryContent"]
    related_paths = [r["path"] for r in scope["related"]]
    assert "src/auth/user.repository.ts" in related_paths
    assert any("UserRepository" in r["content"] for r in scope["related"])
