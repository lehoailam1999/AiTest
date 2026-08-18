import type { RepositoryRevision } from "@aitest/ide-protocol";
import { sha256 } from "./hash";
import type {
  FieldBindingPick,
  FieldBindingPickCandidate,
  FieldBindingPicker,
} from "./resolveBindings";
import type { SymbolProposal, SymbolProposer } from "./symbolProposer";

const DEFAULT_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_ENTRIES = 400;

/**
 * Sibling test cases of one module ask the AI CLI the same two questions, and
 * every ask is a cold `cursor-agent` process bounded by its own timeout. Reusing
 * an answer inside one Approve batch is what keeps a 15-TC run from spending
 * 30 process starts on ~2 distinct questions.
 *
 * Reuse is keyed by repository revision, so any commit or dirty-file change
 * starts a fresh cache. Both consumers also re-verify a reused answer against
 * live source — `resolvePrimary` only scores identifiers the symbol index
 * confirms, and a reused property must still appear in the current candidate
 * shortlist — so a stale hit degrades into "no answer", never into a wrong SUT.
 */
export function repositoryMemoKey(repository: RepositoryRevision): string {
  return [
    repository.workspaceId,
    repository.head || "no-head",
    repository.dirtyFingerprint || (repository.dirty ? "dirty" : "clean"),
  ].join("|");
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizedSet(values: readonly string[]): string {
  return [...new Set(values.map(normalize))].filter(Boolean).sort().join(",");
}

function candidateKey(candidate: {
  property: string;
  ownerPath: string;
}): string {
  return `${candidate.ownerPath.replace(/\\/g, "/")}#${candidate.property}`;
}

function candidateSignature(
  candidates: readonly FieldBindingPickCandidate[]
): string {
  return sha256([...candidates.map(candidateKey)].sort().join("\n"));
}

type Entry<T> = { at: number; value: T };

/** Cached pick, or `null` for "no candidate in this shortlist can hold it". */
type PickEntry = {
  pick: FieldBindingPick | null;
  candidateSignature: string;
  engine?: string;
};

export type ApproveCliMemo = {
  /** Wraps a proposer so identical semantic questions cost one CLI call. */
  wrapProposer(
    proposer: SymbolProposer | undefined,
    revisionKey: string
  ): SymbolProposer | undefined;
  /** Wraps a picker so a label resolved once is not asked again. */
  wrapPicker(
    picker: FieldBindingPicker | undefined,
    revisionKey: string
  ): FieldBindingPicker | undefined;
  stats(): { proposals: number; picks: number; hits: number; misses: number };
  clear(): void;
};

export function createApproveCliMemo(options?: {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}): ApproveCliMemo {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options?.now ?? Date.now;
  const proposals = new Map<string, Entry<SymbolProposal>>();
  const picks = new Map<string, Entry<PickEntry>>();
  let hits = 0;
  let misses = 0;

  function read<T>(store: Map<string, Entry<T>>, key: string): T | undefined {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (now() - entry.at > ttlMs) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function write<T>(store: Map<string, Entry<T>>, key: string, value: T): void {
    if (!store.has(key) && store.size >= maxEntries) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
    store.set(key, { at: now(), value });
  }

  return {
    wrapProposer(proposer, revisionKey) {
      if (!proposer) return proposer;
      return async (input) => {
        // Keyed by the module's behaviour class, not by the individual field.
        // A validation TC per field still hits the same handler, and keying on
        // fields gave a module of per-field TCs a 0% hit rate — one cold CLI
        // call each. Sharing is safe because a proposal is only a candidate
        // list: resolvePrimary re-verifies every name against the symbol index
        // and re-scores it against this TC's own wording before electing one.
        const key = [
          revisionKey,
          normalize(input.module),
          input.primaryBucket,
          input.scenario,
          normalize(input.expectedType),
        ].join("|");
        const cached = read(proposals, key);
        if (cached) {
          hits += 1;
          return { ...cached, memoHit: true };
        }
        misses += 1;
        const proposal = await proposer(input);
        if (!proposal.error && (proposal.symbols.length || proposal.paths.length)) {
          write(proposals, key, proposal);
        }
        return proposal;
      };
    },

    wrapPicker(picker, revisionKey) {
      if (!picker) return picker;
      return async (input) => {
        const signature = candidateSignature(input.candidates);
        const available = new Set(input.candidates.map(candidateKey));
        const reused: FieldBindingPick[] = [];
        const reusedMissing: string[] = [];
        const pending: string[] = [];
        let engine: string | undefined;

        for (const label of input.labels) {
          const key = `${revisionKey}|${normalize(label)}`;
          const cached = read(picks, key);
          if (!cached) {
            pending.push(label);
            continue;
          }
          if (cached.pick) {
            // The property must still exist in this TC's shortlist, otherwise
            // the reused answer is not verifiable here.
            if (available.has(candidateKey(cached.pick))) {
              reused.push({
                label,
                property: cached.pick.property,
                ownerPath: cached.pick.ownerPath,
              });
              engine = engine || cached.engine;
              continue;
            }
            pending.push(label);
            continue;
          }
          // "Missing" only transfers when the shortlist is identical — a wider
          // shortlist could hold the property this label needs.
          if (cached.candidateSignature === signature) {
            reusedMissing.push(label);
            engine = engine || cached.engine;
            continue;
          }
          pending.push(label);
        }

        if (!pending.length) {
          hits += 1;
          return {
            picks: reused,
            missing: reusedMissing,
            engine,
            memoHit: true,
          };
        }
        misses += 1;
        const result = await picker({ ...input, labels: pending });
        for (const pick of result.picks) {
          if (!available.has(candidateKey(pick))) continue;
          write(picks, `${revisionKey}|${normalize(pick.label)}`, {
            pick: {
              label: pick.label,
              property: pick.property,
              ownerPath: pick.ownerPath.replace(/\\/g, "/"),
            },
            candidateSignature: signature,
            engine: result.engine,
          });
        }
        for (const label of result.missing || []) {
          write(picks, `${revisionKey}|${normalize(label)}`, {
            pick: null,
            candidateSignature: signature,
            engine: result.engine,
          });
        }
        return {
          ...result,
          picks: [...reused, ...result.picks],
          missing: [...reusedMissing, ...(result.missing || [])],
          engine: result.engine || engine,
        };
      };
    },

    stats() {
      return { proposals: proposals.size, picks: picks.size, hits, misses };
    },

    clear() {
      proposals.clear();
      picks.clear();
      hits = 0;
      misses = 0;
    },
  };
}

/**
 * One cache per extension host: Approve arrives as one RPC per TC, so the reuse
 * has to outlive a single request to help a batch at all.
 */
export const sharedApproveCliMemo = createApproveCliMemo();
