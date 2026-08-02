"""One-shot: allow EXECUTION_CONTEXT on requirement_analysis_records type check."""
from __future__ import annotations

from sqlalchemy import create_engine, text

from app.config import get_settings

SQL_DROP = (
    "ALTER TABLE requirement_analysis_records "
    "DROP CONSTRAINT IF EXISTS ck_requirement_analysis_records_type"
)
SQL_ADD = """
ALTER TABLE requirement_analysis_records
ADD CONSTRAINT ck_requirement_analysis_records_type
CHECK (type IN (
  'SUMMARY_SCOPE','FEATURES','ACTORS_PERMISSIONS','BUSINESS_FLOWS','EXECUTION_CONTEXT',
  'BUSINESS_RULES','VALIDATION_DATA','API_UI','ERROR_HANDLING','ACCEPTANCE',
  'NFR_CONSTRAINTS','GAPS'
))
"""
SQL_SHOW = """
SELECT pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname = 'ck_requirement_analysis_records_type'
"""


def main() -> None:
    engine = create_engine(get_settings().sqlalchemy_url)
    with engine.begin() as conn:
        before = conn.execute(text(SQL_SHOW)).fetchall()
        print("BEFORE:", before)
        conn.execute(text(SQL_DROP))
        conn.execute(text(SQL_ADD))
        after = conn.execute(text(SQL_SHOW)).fetchall()
        print("AFTER:", after)
    print("OK")


if __name__ == "__main__":
    main()
