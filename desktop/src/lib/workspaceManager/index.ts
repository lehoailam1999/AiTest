/**
 * FE helpers — Backend Workspace Manager (scan/search/read).
 * React không list/read disk trực tiếp cho generate flow.
 * Generate gửi contextPacket (IDE local read); workspaceId optional cho staging.
 * BE ưu tiên packet khi có nội dung (BR-06).
 *
 * Step 1: bindSourceRoot / pickAndBindSourceRoot — “Mở mã nguồn” dùng chung mọi loại test.
 */

export {
  bindSourceRoot,
  pickAndBindSourceRoot,
  syncSourceMeta,
  type BindSourceRootInput,
  type BindSourceRootResult,
  type SyncSourceMetaInput,
} from "./bindSourceRoot";

export {
  ensureWorkspaceOpen,
  getActiveWorkspaceId,
  listWorkspaceSourceFiles,
  readWorkspaceFiles,
  resolveWorkspaceScope,
  searchWorkspaceFiles,
} from "./client";
