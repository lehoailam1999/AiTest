import {
  resolveAgentBinary,
  runCursorAgentOneshotWithBin,
} from "../cursorAgentCliEngine";
import {
  parseSymbolProposal,
  buildCursorSymbolPrompt,
  type SymbolProposal,
  type SymbolProposer,
} from "./symbolProposer";

export const proposeSymbolsWithCursor: SymbolProposer = async (input) => {
  const root = (await import("./vscodeRuntime")).vscodeRepositoryRuntime.workspaceRoot();
  if (!root) return { symbols: [], paths: [], error: "no workspace folder" };
  let engine: string;
  try {
    engine = resolveAgentBinary();
  } catch (error) {
    return {
      symbols: [],
      paths: [],
      error: `agent CLI not resolvable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const timeoutMs = Math.min(60_000, Math.max(4_000, input.timeoutMs));
  const prompt = buildCursorSymbolPrompt(input);

  try {
    const raw = await runCursorAgentOneshotWithBin(engine, prompt, root, timeoutMs);
    const proposal = parseSymbolProposal(raw);
    return {
      ...proposal,
      engine,
      error:
        proposal.symbols.length || proposal.paths.length
          ? undefined
          : `agent returned no usable identifiers (${raw.trim().slice(0, 200) || "empty output"})`,
    };
  } catch (error) {
    // Proposals are an accelerator only; the deterministic sweep still decides.
    return {
      symbols: [],
      paths: [],
      engine,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
