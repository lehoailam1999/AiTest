"""Background CLI conversation session pool (reuse by project + topic)."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Optional

from app.llm.cli.process_runner import CLIProcessRunner

logger = logging.getLogger(__name__)

_SYSTEM_INIT = (
    "Bạn là kỹ sư QA senior. Từ giờ mọi phản hồi sinh test case PHẢI là JSON hợp lệ "
    '(không markdown giải thích dài), schema: '
    '{"testCases":[{"title":"...","type":"Chức năng|Phủ định|Biên|API",'
    '"priority":"Thấp|Trung bình|Cao|Nghiêm trọng","severity":"Nhẹ|Nặng|Nghiêm trọng",'
    '"module":"...","precondition":"...","steps":"1. ...\\n2. ...",'
    '"expectedResult":"...","testData":"...","automationReady":false}]}. '
    "Toàn bộ nội dung tiếng Việt."
)


class CLISessionPool:
    """Singleton pool — reuse interactive CLI sessions theo project/topic."""

    _instance: Optional["CLISessionPool"] = None

    def __new__(cls) -> "CLISessionPool":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance.sessions = {}
            cls._instance._lock = asyncio.Lock()
            cls._instance._cleanup_started = False
        return cls._instance

    def get_session_key(self, project_id: str, topic: Optional[str] = None) -> str:
        return f"proj_{project_id}_topic_{topic or 'global'}"

    async def get_or_create_session(
        self,
        project_id: str,
        topic: Optional[str],
        cli_command: list[str],
        *,
        interactive: bool = True,
        send_system_init: bool = True,
    ) -> CLIProcessRunner:
        await self.ensure_cleanup_task()
        key = self.get_session_key(project_id, topic)
        async with self._lock:
            if key in self.sessions:
                info = self.sessions[key]
                runner: CLIProcessRunner = info["runner"]
                if runner.is_alive:
                    info["last_used"] = time.time()
                    return runner
                await runner.terminate()
                del self.sessions[key]

            runner = CLIProcessRunner(command=cli_command)
            if interactive:
                await runner.start()
                if send_system_init:
                    try:
                        await runner.send_prompt(_SYSTEM_INIT, timeout=90)
                    except Exception as e:  # noqa: BLE001
                        logger.warning("CLI system init failed (continuing): %s", e)
            self.sessions[key] = {
                "runner": runner,
                "created_at": time.time(),
                "last_used": time.time(),
                "command": list(cli_command),
                "interactive": interactive,
            }
            return runner

    def list_sessions(self, project_id: str | None = None) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        now = time.time()
        for key, info in self.sessions.items():
            if project_id and not key.startswith(f"proj_{project_id}_"):
                continue
            runner: CLIProcessRunner = info["runner"]
            idle = now - float(info.get("last_used") or now)
            status = "active" if runner.is_alive else "dead"
            if runner.is_alive and idle > 300:
                status = "idle"
            out.append(
                {
                    "sessionKey": key,
                    "status": status,
                    "alive": runner.is_alive,
                    "idleSeconds": int(idle),
                    "command": info.get("command") or [],
                }
            )
        return out

    async def cleanup_idle_sessions(self, max_idle_seconds: int = 1800) -> int:
        now = time.time()
        removed = 0
        async with self._lock:
            for key, info in list(self.sessions.items()):
                if now - float(info.get("last_used") or 0) > max_idle_seconds:
                    await info["runner"].terminate()
                    del self.sessions[key]
                    removed += 1
        return removed

    async def ensure_cleanup_task(self) -> None:
        if getattr(self, "_cleanup_started", False):
            return
        self._cleanup_started = True

        async def _loop() -> None:
            while True:
                try:
                    await asyncio.sleep(300)
                    await self.cleanup_idle_sessions()
                except Exception as e:  # noqa: BLE001
                    logger.debug("CLI cleanup loop: %s", e)

        try:
            asyncio.get_running_loop().create_task(_loop())
        except RuntimeError:
            self._cleanup_started = False
