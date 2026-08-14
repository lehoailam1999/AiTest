/**
 * Run: npm run mock-ide — writes ~/.aitest/ide-bridge.json and serves forever until Ctrl+C.
 */
import { startMockIdeServer } from "./server.js";
import { defaultBridgeDiscoveryPath } from "../bridgeFs.js";

const handle = await startMockIdeServer({
  discoveryPath: defaultBridgeDiscoveryPath(),
  workspaceRoot: process.cwd(),
});

console.log(`[aitest mock-ide] listening ${handle.url}`);
console.log(`[aitest mock-ide] discovery → ${handle.discoveryPath}`);
console.log(`[aitest mock-ide] token = ${handle.token}`);
console.log("Press Ctrl+C to stop.");

process.on("SIGINT", () => {
  void handle.close().then(() => process.exit(0));
});
