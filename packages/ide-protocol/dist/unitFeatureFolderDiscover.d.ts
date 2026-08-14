/**
 * Discover feature-folder tokens from index bridge hits (portable).
 *
 * Flow: title/intent → IT bridge needles (CheckCode, Assign, InitUpload…)
 *     → paths/symbols on *this* index → CQRS folder segment under Commands/X/
 *
 * No product folder nouns (Evidence, Order, CasePerson…). Folder names come
 * only from paths that already exist on the SUT index.
 */
import type { UnitIntent } from "./unitIntentAliases.js";
/** Minimal index shape — Desktop CodeIndexSnapshot is compatible. */
export type FeatureFolderIndexLike = {
    files?: Record<string, unknown>;
    symbolsByFile?: Record<string, Array<{
        name?: string;
    }>>;
    symbolIndex?: Record<string, string[]>;
};
/**
 * Cross-cutting infra path segments — demote on domain behavior intents.
 * Auth/Mail/Notification only (IT shape).
 */
export declare const UNIT_INFRA_PATH_TOKENS: readonly ["Authentication", "AuthService", "Mail", "MailService", "ImageProcessing", "Notification", "WebNotification"];
/** Infra Auth/Mail/Notification or signed-URL generator — soft writeBack caution. */
export declare function isCrossCuttingSoftPrimaryPath(pathRel: string): boolean;
/**
 * Soft writeBack: refuse Auth/Mail/Notification/signed-URL primary unless
 * module/prefer tokens hit the same infra stem on the path.
 */
export declare function softCrossCuttingDenied(pathRel: string, gateOrPreferTokens: string[] | null | undefined): boolean;
/**
 * Signed/presigned URL or access-token generators — not domain create/validate.
 */
export declare function isSignedUrlOrTokenGeneratePath(pathRel: string): boolean;
/**
 * VI/EN → portable IT bridge stems only.
 * Folder nouns are never returned — only CheckCode / Assign / InitUpload / …
 */
export declare function titleCueBridgeStems(titleTokens: string[]): string[];
/** @deprecated use titleCueBridgeStems; kept for callers that imported kinds. */
export type TitleDiscoverKinds = {
    dossier: boolean;
    person: boolean;
    device: boolean;
    upload: boolean;
    storage: boolean;
    create: boolean;
    describe: boolean;
};
/** @deprecated thin adapter — prefer titleCueBridgeStems. */
export declare function titleDiscoverKinds(titleTokens: string[]): TitleDiscoverKinds;
/**
 * CQRS/feature folder under Commands|Queries|… — preferred discover vote.
 */
export declare function featureFolderSegmentFromPath(pathRel: string): string | null;
/** Split path into segment tokens (folder names + file stem). */
export declare function pathSegmentTokens(pathRel: string): string[];
/** Collect bridge needles from intent rulePatterns + TC title bridges. */
export declare function bridgeNeedlesForDiscover(intent: Pick<UnitIntent, "rulePatterns" | "codePatterns" | "classFeatureTokens"> | null | undefined, titleTokens?: string[]): string[];
export type DiscoverFeatureFoldersOpts = {
    intent?: Pick<UnitIntent, "rulePatterns" | "codePatterns" | "classFeatureTokens" | "requiresBodyRule" | "primaryClass" | "classes"> | null;
    titleTokens?: string[];
    bridgeNeedles?: string[];
    maxFolders?: number;
};
export type DiscoverFeatureFoldersResult = {
    featureTokens: string[];
    bridgePaths: string[];
    bridgeNeedles: string[];
};
/**
 * From index: needles → bridge paths → CQRS feature folder tokens.
 */
export declare function discoverFeatureFoldersFromIndex(index: FeatureFolderIndexLike | null | undefined, allPaths?: string[] | null, opts?: DiscoverFeatureFoldersOpts): DiscoverFeatureFoldersResult;
export declare function isInfraCrossCuttingPath(pathRel: string): boolean;
export declare function infraPathDemoteScore(pathRel: string, intent?: Pick<UnitIntent, "requiresBodyRule" | "primaryClass" | "classes"> | null): number;
export declare function filterCandidatesByFeatureFolders<T extends {
    pathRel: string;
}>(candidates: T[], featureTokens: string[]): {
    candidates: T[];
    filtered: boolean;
};
