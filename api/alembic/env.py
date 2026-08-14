"""Alembic environment — uses app Base metadata + Settings DSN."""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from alembic.operations import ops as alembic_ops
from sqlalchemy import engine_from_config, inspect, pool, text

from app.config import get_settings
from app.database import Base
import app.models  # noqa: F401 — register models on Base.metadata

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def get_url() -> str:
    return get_settings().sqlalchemy_url


def _ensure_alembic_version(connection) -> None:
    """Alembic default version_num is VARCHAR(32); revision ids like 0010_* are longer."""
    connection.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS alembic_version (
                version_num VARCHAR(128) NOT NULL
            )
            """
        )
    )
    connection.execute(
        text(
            """
            ALTER TABLE alembic_version
              ALTER COLUMN version_num TYPE VARCHAR(128)
            """
        )
    )
    connection.commit()


def include_object(object_, name, type_, reflected, compare_to) -> bool:
    """Autogen only table/column diffs — ignore index/constraint naming noise.

    Core tables historically came from create_all; index names often differ
    (ux_* vs ix_*) and would otherwise flood every ``db:migrate``.
    """
    if name == "alembic_version":
        return False
    # Ignore all index / unique-constraint churn (name or unique flag).
    if type_ in {"index", "unique_constraint"}:
        return False
    # Do not DROP tables that exist only in DB (not in models).
    if type_ == "table" and reflected and compare_to is None:
        return False
    return True


def process_revision_directives(context_, revision, directives) -> None:
    """Safety net: never emit CREATE TABLE for a relation that already exists.

    Always inspect via a fresh engine — ``context.connection`` can be None
    during ``revision --autogenerate``, which previously skipped this filter
    and wrote full-schema CREATE dumps.
    """
    if not directives:
        return
    script = directives[0]
    if script.upgrade_ops is None:
        return

    from sqlalchemy import create_engine

    eng = create_engine(get_url())
    try:
        with eng.connect() as conn:
            existing = set(inspect(conn).get_table_names())
    finally:
        eng.dispose()

    print(f"[alembic] autogen filter: {len(existing)} tables in live DB")
    skipped: list[str] = []

    def _filter_ops(container) -> None:
        kept = []
        for op in list(container.ops):
            if isinstance(op, alembic_ops.ModifyTableOps):
                _filter_ops(op)
                if op.ops:
                    kept.append(op)
                continue
            if isinstance(op, alembic_ops.CreateTableOp) and op.table_name in existing:
                skipped.append(op.table_name)
                continue
            kept.append(op)
        container.ops = kept

    _filter_ops(script.upgrade_ops)
    for name in skipped:
        print(f"[alembic] skip CREATE TABLE {name} (already exists)")

    if script.upgrade_ops.is_empty():
        print("[alembic] No table/column changes detected — revision not created.")
        directives[:] = []


def _configure_kwargs(**extra):
    return {
        "target_metadata": target_metadata,
        "compare_type": True,
        "compare_server_default": False,
        "include_object": include_object,
        "process_revision_directives": process_revision_directives,
        **extra,
    }


def run_migrations_offline() -> None:
    url = get_url()
    context.configure(
        url=url,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        **_configure_kwargs(),
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    configuration = config.get_section(config.config_ini_section) or {}
    configuration["sqlalchemy.url"] = get_url()
    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        _ensure_alembic_version(connection)
        context.configure(
            connection=connection,
            **_configure_kwargs(),
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
