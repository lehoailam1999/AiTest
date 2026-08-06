"""Rule registry package (Phase 1 scaffold)."""

from .profiles import ACTIVE_RULE_PROFILE_IDS, RULE_PROFILES, RuleProfile
from .registry_loader import (
    RuleRegistryError,
    get_rule_text,
    invalidate_rule_registry_cache,
    load_rule_registry,
    resolve_rule_content,
)
from .retriever import (
    render_rules_for_profile,
    render_rules_for_profile_with_meta,
    retrieve_rule_rows,
)

__all__ = [
    "RULE_PROFILES",
    "ACTIVE_RULE_PROFILE_IDS",
    "RuleProfile",
    "RuleRegistryError",
    "get_rule_text",
    "invalidate_rule_registry_cache",
    "load_rule_registry",
    "resolve_rule_content",
    "render_rules_for_profile",
    "render_rules_for_profile_with_meta",
    "retrieve_rule_rows",
]

