import { type FocusChangedParams } from "../methods.js";
import type { IdeSemanticPacket } from "../types.js";
export type MockIdeOptions = {
    token?: string;
    workspaceRoot?: string;
    /** Discovery file path (default under tmp) */
    discoveryPath?: string;
    packet?: IdeSemanticPacket;
};
export type MockIdeHandle = {
    port: number;
    token: string;
    discoveryPath: string;
    url: string;
    /** Push focusChanged to all authenticated clients (P1) */
    notifyFocusChanged: (params: FocusChangedParams) => void;
    close: () => Promise<void>;
};
export declare function startMockIdeServer(opts?: MockIdeOptions): Promise<MockIdeHandle>;
