"""Alembic environment — uses app Base metadata + Settings DSN."""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool, text

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


def _bootstrap_if_empty(connection) -> None:
    """On a brand-new database: build schema from models, then stamp head.

    ``0001_baseline`` is only a marker — core tables historically came from
    ``create_all`` — so replaying the revisions would leave a fresh clone
    without ``projects`` / ``users`` / ``jobs``. ``create_all`` already produces
    the latest schema, so the revisions are marked as applied instead of being
    replayed (replaying would hit "column already exists" on future revisions).
    """
    from alembic.script import ScriptDirectory
    from sqlalchemy import inspect

    existing = set(inspect(connection).get_table_names())
    if "alembic_version" in existing or existing & set(target_metadata.tables):
        return

    print("[alembic] empty database — creating schema from models", flush=True)
    target_metadata.create_all(bind=connection)
    _ensure_alembic_version(connection)
    for head in ScriptDirectory.from_config(config).get_heads():
        connection.execute(
            text("INSERT INTO alembic_version (version_num) VALUES (:rev)"), {"rev": head}
        )
        print(f"[alembic] stamped {head} (baseline, revisions not replayed)", flush=True)
    connection.commit()


def _drop_unknown_versions(connection) -> None:
    """Forget revisions whose file no longer exists in ``versions/``.

    Deleting a revision file that was already applied leaves the DB pointing at
    an id Alembic cannot resolve, and every command then fails with
    "Can't locate revision identified by ...".
    """
    from alembic.script import ScriptDirectory

    known = {rev.revision for rev in ScriptDirectory.from_config(config).walk_revisions()}
    current = [row[0] for row in connection.execute(text("SELECT version_num FROM alembic_version"))]
    for rev in [rev for rev in current if rev not in known]:
        connection.execute(
            text("DELETE FROM alembic_version WHERE version_num = :rev"), {"rev": rev}
        )
        print(f"[alembic] forget revision {rev} (file missing in versions/)")
    # Always close this transaction: leaving it open makes Alembic reuse it and
    # the version bookkeeping of ``upgrade`` gets rolled back on disconnect.
    connection.commit()


def include_object(object_, name, type_, reflected, compare_to) -> bool:
    """Autogen table/column diffs (add + drop) — ignore index naming noise.

    Core tables were historically created by ``create_all``, so index names
    differ (ux_* vs ix_*) and would flood every ``db:migrate``.
    """
    if name == "alembic_version":
        return False
    if type_ in {"index", "unique_constraint"}:
        return False
    return True


def process_revision_directives(context_, revision, directives) -> None:
    """Skip writing a file when there is no table/column diff."""
    if not directives:
        return
    script = directives[0]
    if script.upgrade_ops is None:
        return

    if script.upgrade_ops.is_empty():
        print(
            "[alembic] No table/column changes vs DB — no file created.\n"
            "         Edit api/app/models/domain.py first, then npm run db:migrate again."
        )
        directives[:] = []
        return

    # Keep migration files naturally sorted: 0013_migration.py,
    # 0014_migration.py, ... instead of Alembic's random hash ids.
    import re

    from alembic.script import ScriptDirectory

    numbers = []
    for known_revision in ScriptDirectory.from_config(config).walk_revisions():
        match = re.match(r"^(\d{4})", known_revision.revision)
        if match:
            numbers.append(int(match.group(1)))
    script.rev_id = f"{max(numbers, default=0) + 1:04d}"
    print(f"[alembic] next revision: {script.rev_id}", flush=True)


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
        _bootstrap_if_empty(connection)
        _ensure_alembic_version(connection)
        _drop_unknown_versions(connection)
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
