"""Tests for Structured Document Model (heading / table / entity index)."""

from __future__ import annotations

from app.features.requirement_studio.document_model import (
    build_chunk_pairs_from_files,
    build_document_index,
    index_to_chunk_pairs,
)


def test_build_document_index_splits_markdown_headings():
    text = """# Introduction
Overview of the app.

## Features
- Login
- Create todo

## Validation
| Field | Rule |
| title | required |
| email | format |
"""
    sections = build_document_index(text, file_name="srs.md")
    assert len(sections) >= 3
    headings = [s.heading for s in sections]
    assert "Introduction" in headings
    assert "Features" in headings
    assert "Validation" in headings
    val = next(s for s in sections if s.heading == "Validation")
    assert val.kind == "table"
    assert "title" in val.body


def test_index_to_chunk_pairs_prefixes_file():
    sections = build_document_index(
        "# Actors\nRole: User\n",
        file_name="a.md",
    )
    pairs = index_to_chunk_pairs(sections)
    assert pairs
    assert pairs[0][0] and "a.md" in pairs[0][0]
    assert "User" in pairs[0][1]


def test_build_chunk_pairs_from_files_multi():
    pairs = build_chunk_pairs_from_files(
        [
            ("a.md", "# A\nalpha\n"),
            ("b.md", "# B\nbeta\n"),
        ]
    )
    bodies = " ".join(t for _, t in pairs)
    assert "alpha" in bodies and "beta" in bodies


def test_entity_kind_detected():
    sections = build_document_index(
        "# Data\nEntity Todo stores title and status.\n",
        file_name="m.md",
    )
    assert any(s.kind == "entity" for s in sections)
