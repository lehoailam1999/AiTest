"""Unit tests for P9 Business Analyzer parse/heuristic (no LLM)."""

from __future__ import annotations

import unittest

from app.services.business_analyzer import (
    heuristic_business_intent,
    parse_business_intent_json,
)


class BusinessAnalyzerTests(unittest.TestCase):
    def test_parse_llm_json(self) -> None:
        raw = """
        {
          "action": "Create",
          "entity": "Evidence",
          "expectedResults": ["Save successfully", "Generate evidence code"],
          "businessRules": [],
          "validationRules": ["Required fields"],
          "externalDeps": ["FileStorage", "AuditLog"],
          "domainTerms": ["vật chứng"],
          "searchHints": ["Evidence", "EvidenceService"]
        }
        """
        intent = parse_business_intent_json(raw)
        self.assertEqual(intent["action"], "Create")
        self.assertEqual(intent["entity"], "Evidence")
        self.assertIn("EvidenceService", intent["searchHints"])
        self.assertTrue(len(intent["expectedResults"]) >= 1)

    def test_parse_markdown_fence(self) -> None:
        raw = '```json\n{"action":"Update","entity":"User","expectedResults":[],"businessRules":[],"validationRules":[],"externalDeps":[],"domainTerms":[],"searchHints":[]}\n```'
        intent = parse_business_intent_json(raw)
        self.assertEqual(intent["action"], "Update")
        self.assertEqual(intent["entity"], "User")

    def test_heuristic_create_evidence(self) -> None:
        intent = heuristic_business_intent(
            title="Tạo vật chứng thành công",
            module="Forensic",
            steps="1. Nhập thông tin\n2. Lưu",
            expected="Lưu thành công\nSinh mã vật chứng",
        )
        self.assertEqual(intent["action"], "Create")
        self.assertEqual(intent["source"], "heuristic")
        self.assertTrue(len(intent["searchHints"]) >= 1)
        self.assertTrue(len(intent["expectedResults"]) >= 1)


if __name__ == "__main__":
    unittest.main()
