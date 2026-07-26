"""Feature modules — Modular Monolith entrypoints (ADR-001).

Composition root: app.main includes legacy app.routers.* plus new feature routers
(journey, reporting, integration). Facades below document the bounded-context map.
"""

from app.features.ai_connection import api as ai_connection
from app.features.execution import api as execution
from app.features.generation import api as generation
from app.features.identity import api as identity
from app.features.journey import api as journey
from app.features.project import api as project
from app.features.reporting import api as reporting
from app.features.specification import api as specification
from app.features.test_design import api as test_design
from app.features.workspace_audit import api as workspace_audit

__all__ = [
    "identity",
    "project",
    "ai_connection",
    "specification",
    "test_design",
    "generation",
    "workspace_audit",
    "execution",
    "reporting",
    "journey",
]
