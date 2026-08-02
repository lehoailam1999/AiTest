from __future__ import annotations

import os

import httpx

from app.llm.base import (
    GenerateContext,
    TestCaseDraft,
    UnitRequest,
    UnitResult,
    api_system_prompt,
    api_user_prompt,
    drafts_look_english,
    guess_class_name,
    infer_language,
    parse_test_cases_json,
    strip_code_fences,
    suggest_api_path,
    system_prompt,
    truncate,
    unit_result_from_raw,
    unit_system_prompt,
    unit_user_prompt,
    user_prompt,
    vietnamese_retry_suffix,
    vietnamese_translate_prompt,
)


class LLMError(Exception):
    pass


class Provider:
    name: str = "provider"

    async def verify(self, api_key: str) -> None:
        raise NotImplementedError

    async def chat(self, api_key: str, system: str, user: str) -> str:
        raise NotImplementedError

    async def generate(
        self,
        api_key: str,
        title: str,
        content: str,
        ctx: GenerateContext | None = None,
    ) -> list[TestCaseDraft]:
        ctx = ctx or GenerateContext()
        system = system_prompt(ctx)
        user = user_prompt(title, content, ctx)
        text = await self.chat(api_key, system, user)
        drafts = parse_test_cases_json(text)
        if drafts_look_english(drafts):
            retry_user = user + vietnamese_retry_suffix()
            text = await self.chat(api_key, system, retry_user)
            drafts = parse_test_cases_json(text)
        if drafts_look_english(drafts):
            t_system, t_user = vietnamese_translate_prompt(drafts)
            text = await self.chat(api_key, t_system, t_user)
            drafts = parse_test_cases_json(text)
        return drafts


class OpenAI(Provider):
    name = "openai"

    def __init__(self, model: str = "gpt-4o-mini", base_url: str | None = None):
        self.model = model
        self.base_url = base_url or "https://api.openai.com/v1"

    async def verify(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=90) as client:
            res = await client.get(
                f"{self.base_url}/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
        if res.status_code >= 400:
            raise LLMError(f"openai verify HTTP {res.status_code}: {truncate(res.text, 200)}")

    async def chat(self, api_key: str, system: str, user: str) -> str:
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0.2,
            # TC JSON với nhiều case dễ vượt 4k — tránh Unterminated string
            "max_tokens": 16384,
        }
        async with httpx.AsyncClient(timeout=180) as client:
            res = await client.post(
                f"{self.base_url}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json=body,
            )
        if res.status_code >= 400:
            raise LLMError(f"openai chat HTTP {res.status_code}: {truncate(res.text, 400)}")
        data = res.json()
        choices = data.get("choices") or []
        if not choices:
            raise LLMError("openai: empty choices")
        return choices[0]["message"]["content"]


class Anthropic(Provider):
    name = "anthropic"

    def __init__(self, model: str = "claude-3-5-haiku-latest"):
        self.model = model

    async def verify(self, api_key: str) -> None:
        body = {
            "model": self.model,
            "max_tokens": 8,
            "messages": [{"role": "user", "content": "ping"}],
        }
        async with httpx.AsyncClient(timeout=90) as client:
            res = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
                json=body,
            )
        if res.status_code in (401, 403):
            raise LLMError(f"anthropic auth failed: {truncate(res.text, 200)}")
        if res.status_code >= 500 or res.status_code == 404:
            raise LLMError(f"anthropic verify HTTP {res.status_code}: {truncate(res.text, 200)}")

    async def chat(self, api_key: str, system: str, user: str) -> str:
        body = {
            "model": self.model,
            "max_tokens": 16384,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
        async with httpx.AsyncClient(timeout=180) as client:
            res = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
                json=body,
            )
        if res.status_code >= 400:
            raise LLMError(f"anthropic chat HTTP {res.status_code}: {truncate(res.text, 400)}")
        data = res.json()
        text = "".join(
            c.get("text", "") for c in data.get("content", []) if c.get("type") == "text"
        )
        if not text:
            raise LLMError("anthropic: empty content")
        return text


class Gemini(Provider):
    name = "gemini"

    def __init__(self, model: str = "gemini-2.0-flash"):
        self.model = model

    async def verify(self, api_key: str) -> None:
        url = f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
        async with httpx.AsyncClient(timeout=90) as client:
            res = await client.get(url)
        if res.status_code >= 400:
            raise LLMError(f"gemini verify HTTP {res.status_code}: {truncate(res.text, 200)}")

    async def chat(self, api_key: str, system: str, user: str) -> str:
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}"
            f":generateContent?key={api_key}"
        )
        body = {
            "contents": [
                {"role": "user", "parts": [{"text": system + "\n\n" + user}]}
            ],
            "generationConfig": {
                "temperature": 0.2,
                "maxOutputTokens": 16384,
            },
        }
        async with httpx.AsyncClient(timeout=180) as client:
            res = await client.post(url, json=body)
        if res.status_code >= 400:
            raise LLMError(f"gemini chat HTTP {res.status_code}: {truncate(res.text, 400)}")
        data = res.json()
        candidates = data.get("candidates") or []
        if not candidates or not candidates[0]["content"]["parts"]:
            raise LLMError("gemini: empty candidates")
        return candidates[0]["content"]["parts"][0]["text"]


class Ollama(Provider):
    name = "ollama"

    def __init__(self, base_url: str | None = None, model: str | None = None):
        self._base_url = base_url
        self.model = model

    def base(self) -> str:
        u = (self._base_url or os.getenv("OLLAMA_BASE_URL") or "http://127.0.0.1:11434").strip()
        return u.rstrip("/")

    def model_name(self) -> str:
        m = (self.model or os.getenv("OLLAMA_MODEL") or "llama3.2").strip()
        return m

    async def verify(self, api_key: str) -> None:
        async with httpx.AsyncClient(timeout=15) as client:
            try:
                res = await client.get(f"{self.base()}/api/tags")
            except httpx.HTTPError as exc:
                raise LLMError(
                    f"ollama unreachable at {self.base()} — chạy Ollama và kiểm tra OLLAMA_BASE_URL: {exc}"
                ) from exc
        if res.status_code >= 400:
            raise LLMError(f"ollama verify HTTP {res.status_code}: {truncate(res.text, 200)}")
        # Cloud/remote model may not be in tags — ping chat lightly.
        await self._ping_chat()

    async def _ping_chat(self) -> None:
        body = {
            "model": self.model_name(),
            "messages": [{"role": "user", "content": "ping"}],
            "stream": False,
            "options": {"num_predict": 1},
        }
        async with httpx.AsyncClient(timeout=45) as client:
            res = await client.post(f"{self.base()}/api/chat", json=body)
        if res.status_code >= 400:
            raise LLMError(f"ollama ping HTTP {res.status_code}: {truncate(res.text, 300)}")
        err = res.json().get("error")
        if err:
            raise LLMError(f"ollama: {err}")

    async def chat(self, api_key: str, system: str, user: str) -> str:
        body = {
            "model": self.model_name(),
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "stream": False,
            "options": {"temperature": 0.2, "num_predict": 16384},
        }
        async with httpx.AsyncClient(timeout=180) as client:
            res = await client.post(f"{self.base()}/api/chat", json=body)
        if res.status_code >= 400:
            raise LLMError(f"ollama chat HTTP {res.status_code}: {truncate(res.text, 400)}")
        data = res.json()
        if data.get("error"):
            raise LLMError(f"ollama: {data['error']}")
        content = (data.get("message") or {}).get("content", "")
        if not content.strip():
            raise LLMError("ollama: empty message")
        return content


class Antigravity(Provider):
    """
    Antigravity LLM — same UX as other cloud providers by default:
      API Key (Google) + model → Google Generative Language API (Gemini).

    Optional: set base_url / ANTIGRAVITY_BASE_URL to an OpenAI-compatible
    endpoint (local proxy or remote gateway) instead of Google cloud.
    """

    name = "antigravity"

    def __init__(self, model: str = "gemini-2.0-flash", base_url: str | None = None):
        self.model = model or "gemini-2.0-flash"
        self._base_url = base_url

    def openai_compat_base(self) -> str | None:
        u = (self._base_url or os.getenv("ANTIGRAVITY_BASE_URL") or "").strip()
        return u.rstrip("/") if u else None

    def _gemini(self) -> Gemini:
        return Gemini(model=self.model)

    async def verify(self, api_key: str) -> None:
        base = self.openai_compat_base()
        if base:
            headers = {}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            url = f"{base}/models"
            try:
                async with httpx.AsyncClient(timeout=15) as client:
                    res = await client.get(url, headers=headers)
            except httpx.HTTPError as exc:
                raise LLMError(
                    f"antigravity OpenAI-compatible endpoint unreachable at {base}: {exc}"
                ) from exc
            if res.status_code >= 400:
                raise LLMError(
                    f"antigravity verify HTTP {res.status_code} at {url}: {truncate(res.text, 300)}"
                )
            return

        if not (api_key or "").strip():
            raise LLMError(
                "antigravity cần Google API Key (giống Gemini) — "
                "hoặc điền Base URL nếu dùng proxy OpenAI-compatible"
            )
        await self._gemini().verify(api_key)

    async def chat(self, api_key: str, system: str, user: str) -> str:
        base = self.openai_compat_base()
        if not base:
            if not (api_key or "").strip():
                raise LLMError("antigravity: thiếu Google API Key")
            return await self._gemini().chat(api_key, system, user)

        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0.2,
            "max_tokens": 16384,
        }
        url = f"{base}/chat/completions"
        try:
            async with httpx.AsyncClient(timeout=180) as client:
                res = await client.post(url, headers=headers, json=body)
        except httpx.HTTPError as exc:
            raise LLMError(f"antigravity chat failed at {base}: {exc}") from exc
        if res.status_code >= 400:
            raise LLMError(f"antigravity chat HTTP {res.status_code}: {truncate(res.text, 400)}")
        data = res.json()
        choices = data.get("choices") or []
        if not choices:
            raise LLMError("antigravity: empty choices")
        content = choices[0].get("message", {}).get("content")
        if content is None:
            raise LLMError("antigravity: empty message content")
        return content if isinstance(content, str) else str(content)


def for_provider(name: str) -> Provider:
    key = (name or "").strip().lower()
    if key == "openai":
        return OpenAI()
    if key == "anthropic":
        return Anthropic()
    if key == "gemini":
        return Gemini()
    if key == "ollama":
        return Ollama()
    if key == "antigravity":
        return Antigravity()
    raise LLMError(f"unsupported provider {name!r} (use openai|anthropic|gemini|ollama|antigravity)")


async def generate_unit(provider: Provider, api_key: str, req: UnitRequest) -> UnitResult:
    if not req.source_code.strip():
        raise LLMError("sourceCode is required")
    if not req.test_case_title.strip():
        raise LLMError("test case title is required")
    language = infer_language(req)
    raw = await provider.chat(
        api_key,
        unit_system_prompt(
            req.framework,
            language,
            testing_framework=req.testing_framework,
            mock_framework=req.mock_framework,
            assertion_library=req.assertion_library,
            project_rules=req.project_rules,
            user_rules=req.user_rules,
        ),
        unit_user_prompt(req),
    )
    try:
        return unit_result_from_raw(raw, req)
    except ValueError as exc:
        raise LLMError(str(exc)) from exc


async def generate_api_test(provider: Provider, api_key: str, req: UnitRequest) -> UnitResult:
    if not req.test_case_title.strip():
        raise LLMError("test case title is required")
    if not req.source_code.strip() and not req.open_api_spec.strip():
        raise LLMError("sourceCode or openApiSpec is required for API tests")
    language = infer_language(req)
    raw = await provider.chat(
        api_key, api_system_prompt(req.framework, language), api_user_prompt(req)
    )
    code = strip_code_fences(raw)
    if not code.strip():
        raise LLMError("LLM returned empty API test code")
    class_name = req.class_name or guess_class_name(req.source_file_name, req.source_code)
    suggested, file_name = suggest_api_path(
        language,
        class_name,
        req.source_file_name,
        req.framework,
        module=req.module or "",
        package_prefix=req.package_prefix,
    )
    if req.source_file_name:
        from app.services.test_output_layout import rewrite_sut_imports

        code = rewrite_sut_imports(
            code, test_rel=suggested, source_rel=req.source_file_name
        )
    return UnitResult(code=code, suggested_path=suggested, file_name=file_name)
