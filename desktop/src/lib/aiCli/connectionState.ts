import type { AiCliDetectResult } from "./types";

export type AiCliRecoveryState = "idle" | "recovering" | "recovered" | "failed";
export type AiCliConnectionState =
  | "checking"
  | "not_installed"
  | "needs_auth"
  | "needs_verify"
  | "connected"
  | "recovered";

/**
 * Two independent axes: local detection (installed / signed in) and the Backend
 * connection record for this project. Only the detector may report `needs_auth`;
 * a signed-in CLI without a Ready record is `needs_verify` instead.
 */
export function aiCliConnectionState(
  result: AiCliDetectResult | undefined,
  detecting: boolean,
  recovery: AiCliRecoveryState,
  backendReady = false
): AiCliConnectionState {
  if (detecting || recovery === "recovering") return "checking";
  if (result?.status === "NOT_AUTHENTICATED") return "needs_auth";
  if (result?.status !== "READY") return "not_installed";
  if (!backendReady) return "needs_verify";
  return recovery === "recovered" ? "recovered" : "connected";
}

export function aiCliFailureMessage(result?: AiCliDetectResult): string {
  if (!result) return "Chưa kiểm tra CLI đã chọn trên máy này.";
  if (result.message) return result.message;
  if (result.status === "NOT_AUTHENTICATED") {
    return "CLI đã được tìm thấy nhưng chưa đăng nhập.";
  }
  if (result.status === "FOUND") {
    return "Đã tìm thấy CLI nhưng chưa xác minh được phiên bản.";
  }
  if (result.status === "INVALID") {
    return "Đường dẫn CLI không hợp lệ.";
  }
  if (result.status === "ERROR") {
    return "Không thể chạy CLI để kiểm tra.";
  }
  return "Không tìm thấy CLI đã chọn trên máy này.";
}
