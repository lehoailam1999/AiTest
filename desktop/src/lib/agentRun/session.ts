/**
 * P0 — Session state for Agent Run → frozen contextPacket for Generate.
 */
import { create } from "zustand";
import type {
  AgentRunPhase,
  BusinessIntent,
  ConfidenceReport,
  RetrievedFile,
} from "@aitest/ide-protocol";
import type { AITestContextPacket } from "../contextPacket/types";

export type AgentRunSessionState = {
  testCaseId: string | null;
  phase: AgentRunPhase;
  intent: BusinessIntent | null;
  retrieved: RetrievedFile[];
  confidence: ConfidenceReport | null;
  /** Frozen packet after retrieve — Generate must prefer this */
  packet: AITestContextPacket | null;
  language: string | null;
  framework: string | null;
  primaryPath: string | null;
  contextSource: "agent-ide" | null;
  error: string | null;
  override: boolean;
  setAnalyzing: (testCaseId: string) => void;
  setIntent: (intent: BusinessIntent) => void;
  setRetrieving: () => void;
  setRetrieved: (retrieved: RetrievedFile[], confidence: ConfidenceReport) => void;
  setPacket: (payload: {
    packet: AITestContextPacket;
    language: string;
    framework: string;
    primaryPath: string;
  }) => void;
  setPhase: (phase: AgentRunPhase) => void;
  setError: (error: string | null) => void;
  setOverride: (v: boolean) => void;
  clear: () => void;
  /** Packet ready for generate (even if needs_user + override) */
  canGenerateWithPacket: () => boolean;
};

const empty = {
  testCaseId: null as string | null,
  phase: "idle" as AgentRunPhase,
  intent: null as BusinessIntent | null,
  retrieved: [] as RetrievedFile[],
  confidence: null as ConfidenceReport | null,
  packet: null as AITestContextPacket | null,
  language: null as string | null,
  framework: null as string | null,
  primaryPath: null as string | null,
  contextSource: null as "agent-ide" | null,
  error: null as string | null,
  override: false,
};

export const useAgentRunSession = create<AgentRunSessionState>((set, get) => ({
  ...empty,
  setAnalyzing: (testCaseId) =>
    set({
      ...empty,
      testCaseId,
      phase: "analyzing",
    }),
  setIntent: (intent) => set({ intent, phase: "planning" }),
  setRetrieving: () => set({ phase: "retrieving", error: null }),
  setRetrieved: (retrieved, confidence) =>
    set({
      retrieved,
      confidence,
      phase: confidence.enough ? "evaluating" : "needs_user",
    }),
  setPacket: ({ packet, language, framework, primaryPath }) =>
    set({
      packet,
      language,
      framework,
      primaryPath,
      contextSource: "agent-ide",
    }),
  setPhase: (phase) => set({ phase }),
  setError: (error) => set({ error, phase: error ? "error" : get().phase }),
  setOverride: (override) => set({ override }),
  clear: () => set({ ...empty }),
  canGenerateWithPacket: () => {
    const s = get();
    if (!s.packet?.files?.length) return false;
    if (s.confidence?.enough) return true;
    return s.override;
  },
}));
