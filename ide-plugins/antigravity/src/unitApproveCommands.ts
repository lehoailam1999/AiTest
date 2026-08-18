/**
 * Antigravity uses the same VS Code-compatible repository intelligence runtime.
 * Keep this adapter thin so both IDE bridges emit identical v2 decisions.
 */
export { handleUnitApproveResolve } from "../../vscode/src/repositoryIntelligence/unitApproveCommands";
