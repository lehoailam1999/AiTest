/**
 * P10 — Desktop retrieval via IDE Command Layer (bounded search/read).
 * Planner (P11) will drive step order; this runs a fixed hint-driven pass.
 */
import type {
  BusinessIntent,
  ConfidenceReport,
  RetrievedFile,
} from "@aitest/ide-protocol";
import { getIdeRpcClientOrNull, useIdeBridgeSession } from "../ideBridge/session";

const MAX_HINTS = 4;
const MAX_FILES = 8;
const SNIPPET_CHARS = 3500;

const BUILD_PATH_RE =
  /(^|\/)(node_modules|dist|build|out|\.next|coverage|\.turbo|__pycache__|\.git)(\/|$)/i;

function isBuildArtifactPath(pathRel: string): boolean {
  return BUILD_PATH_RE.test(pathRel.replace(/\\/g, "/"));
}

function sourcePreferScore(pathRel: string): number {
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  if (isBuildArtifactPath(p)) return -100;
  if (p.endsWith(".d.ts")) return -25;
  if (/\.(ts|tsx|cs|java|py|go|kt)$/.test(p)) return 25;
  if (/\.(js|jsx)$/.test(p)) return 10;
  return 0;
}

function pickBestSymbolHit<T extends { name: string; pathRel: string; score?: number }>(
  hits: T[],
  hint: string
): T | null {
  if (!hits.length) return null;
  const q = hint.toLowerCase();
  const ranked = [...hits].sort((a, b) => {
    const nameRank = (n: string) => {
      const x = n.toLowerCase();
      if (x === q) return 3;
      if (x.startsWith(q)) return 2;
      if (x.includes(q)) return 1;
      return 0;
    };
    const da = nameRank(a.name) * 40 + sourcePreferScore(a.pathRel) + (a.score ?? 0) * 10;
    const db = nameRank(b.name) * 40 + sourcePreferScore(b.pathRel) + (b.score ?? 0) * 10;
    return db - da;
  });
  const source = ranked.find((h) => !isBuildArtifactPath(h.pathRel));
  return source ?? ranked[0];
}

function pickBestTextHit<T extends { pathRel: string }>(hits: T[]): T | null {
  if (!hits.length) return null;
  const ranked = [...hits].sort(
    (a, b) => sourcePreferScore(b.pathRel) - sourcePreferScore(a.pathRel)
  );
  const source = ranked.find((h) => !isBuildArtifactPath(h.pathRel));
  return source ?? ranked[0];
}

function isMethodMissing(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /^-32601|Method not found|searchSymbol/i.test(msg);
}

async function ensureFreshIdeClient(): Promise<void> {
  const s = useIdeBridgeSession.getState();
  // Re-read discovery + reconnect (fixes stale bridge after extension upgrade)
  s.disconnect();
  await s.connect();
}

export async function retrieveViaIdeCommands(input: {
  intent: BusinessIntent;
  focus?: { file: string; symbol: string; method?: string } | null;
}): Promise<{
  retrieved: RetrievedFile[];
  confidence: ConfidenceReport;
  usedIde: boolean;
  error?: string;
}> {
  const retrieved: RetrievedFile[] = [];
  const candidates: ConfidenceReport["candidates"] = [];
  const seen = new Set<string>();

  const pushFile = (f: RetrievedFile) => {
    const key = f.path;
    if (seen.has(key) || retrieved.length >= MAX_FILES) return;
    seen.add(key);
    retrieved.push(f);
  };

  let client = getIdeRpcClientOrNull();

  if (input.focus?.file) {
    const symbol = input.focus.method
      ? `${input.focus.symbol}.${input.focus.method}`
      : input.focus.symbol;
    let snippet: string | undefined;
    if (client?.isConnected) {
      try {
        const file = await client.readFile({
          pathRel: input.focus.file,
          maxBytes: SNIPPET_CHARS,
        });
        snippet = file.content.slice(0, SNIPPET_CHARS);
      } catch {
        /* caret boost without content — builder will re-read */
      }
    }
    pushFile({
      path: input.focus.file,
      role: "caret-boost",
      symbolIds: [symbol],
      score: 0.88,
      snippet,
    });
    candidates.push({
      symbol,
      path: input.focus.file,
      score: 0.88,
      rationale: "Caret / focus hiện tại trong IDE (boost)",
    });
  }

  if (!client?.isConnected) {
    for (const hint of input.intent.searchHints.slice(0, MAX_HINTS)) {
      if (candidates.some((c) => c.symbol === hint)) continue;
      candidates.push({
        symbol: hint,
        path: "(IDE offline — Connect IDE để search)",
        score: 0.4,
        rationale: "Cần IDE bridge để searchSymbol / readFile",
      });
    }
    const overall =
      candidates.length > 0 ? Math.max(...candidates.map((c) => c.score)) : 0.25;
    return {
      retrieved,
      confidence: {
        candidates: candidates.sort((a, b) => b.score - a.score),
        overall,
        enough: overall >= 0.8 && retrieved.length > 0,
        missingHints: [
          "Connect IDE để chạy searchSymbol / readFile (P10)",
          ...(overall < 0.8 ? ["Độ tin cậy chưa đủ"] : []),
        ],
      },
      usedIde: false,
      error: "IDE bridge offline",
    };
  }

  const hints = [
    ...input.intent.searchHints,
    input.intent.entity,
    input.intent.action,
  ]
    .map((h) => (h || "").trim())
    .filter(Boolean)
    .filter((h, i, arr) => arr.indexOf(h) === i)
    .slice(0, MAX_HINTS);

  async function runSearchPass(): Promise<void> {
    if (!client) return;
    for (const hint of hints) {
      if (retrieved.length >= MAX_FILES) break;
      const res = await client.searchSymbol({ query: hint, maxResults: 12 });
      const top = pickBestSymbolHit(res.hits, hint);
      if (!top) {
        const text = await client.searchText({
          query: hint,
          maxResults: 8,
          glob: "**/*.{ts,tsx,js,jsx,cs,py,java,go}",
        });
        const th = pickBestTextHit(text.hits);
        if (!th) {
          candidates.push({
            symbol: hint,
            path: "(không tìm thấy)",
            score: 0.35,
            rationale: `searchSymbol/searchText: 0 hits cho «${hint}»`,
          });
          continue;
        }
        const file = await client.readFile({
          pathRel: th.pathRel,
          startLine: Math.max(0, th.line - 5),
          endLine: th.line + 25,
          maxBytes: SNIPPET_CHARS,
        });
        pushFile({
          path: th.pathRel,
          role: "search-text",
          snippet: file.content.slice(0, SNIPPET_CHARS),
          score: isBuildArtifactPath(th.pathRel) ? 0.5 : 0.62,
          symbolIds: [hint],
        });
        candidates.push({
          symbol: hint,
          path: th.pathRel,
          score: isBuildArtifactPath(th.pathRel) ? 0.5 : 0.62,
          rationale: "searchText hit + readFile (bounded, ưu tiên source)",
        });
        continue;
      }

      const file = await client.readFile({
        pathRel: top.pathRel,
        startLine: top.range?.start,
        endLine: top.range?.end != null ? top.range.end + 5 : undefined,
        maxBytes: SNIPPET_CHARS,
      });
      let score = top.name.toLowerCase() === hint.toLowerCase() ? 0.9 : 0.78;
      if (isBuildArtifactPath(top.pathRel)) score = Math.min(score, 0.55);
      else if (sourcePreferScore(top.pathRel) >= 25) score = Math.min(0.95, score + 0.05);
      pushFile({
        path: top.pathRel,
        role: "search-symbol",
        snippet: file.content.slice(0, SNIPPET_CHARS),
        score,
        symbolIds: [top.id, top.name],
      });
      candidates.push({
        symbol: top.name,
        path: top.pathRel,
        score,
        rationale: `searchSymbol(«${hint}») → readFile (ưu tiên source)`,
      });
    }
  }

  let error: string | undefined;
  try {
    await runSearchPass();
  } catch (e) {
    if (isMethodMissing(e)) {
      try {
        await ensureFreshIdeClient();
        client = getIdeRpcClientOrNull();
        if (!client?.isConnected) {
          error =
            "IDE bridge thiếu P10 — Reload Window Cursor rồi Connect IDE lại";
        } else {
          await runSearchPass();
        }
      } catch (e2) {
        error = e2 instanceof Error ? e2.message : String(e2);
        if (isMethodMissing(e2)) {
          error =
            "Extension chưa có searchSymbol — chạy npm run extension:install, Reload Window, Connect IDE";
        }
      }
    } else {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  const overall =
    candidates.length > 0 ? Math.max(...candidates.map((c) => c.score)) : 0.3;
  const enough = overall >= 0.8 && retrieved.length > 0;
  const missingHints: string[] = [];
  if (!enough) {
    missingHints.push("Độ tin cậy chưa đủ — chỉnh caret hoặc thử hint khác");
  }
  if (retrieved.length === 0) {
    missingHints.push("Chưa lấy được file — kiểm tra workspace IDE mở đúng project");
  }

  return {
    retrieved,
    confidence: {
      candidates: candidates.sort((a, b) => b.score - a.score),
      overall,
      enough,
      missingHints,
    },
    usedIde: true,
    error,
  };
}
