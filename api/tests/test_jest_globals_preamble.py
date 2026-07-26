from app.llm.base import ensure_node_test_globals_preamble


def test_jest_preamble_injected():
    code = (
        "import { X } from 'x';\n"
        "beforeEach(() => {});\n"
        "describe('t', () => { it('a', () => { expect(1).toBe(1); }); });\n"
    )
    out = ensure_node_test_globals_preamble(code, "TypeScript", "Jest")
    assert out.startswith('/// <reference types="jest" />')
    assert "beforeEach" in out


def test_jest_preamble_idempotent():
    code = '/// <reference types="jest" />\ndescribe("t", () => {});'
    assert ensure_node_test_globals_preamble(code, "TypeScript", "Jest") == code
