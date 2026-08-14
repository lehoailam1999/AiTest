/**
 * Contract tests — P0 DoD: client speaks to mock IDE plugin.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  IdeRpcClient,
  isIdeSemanticPacket,
  IDE_PROTOCOL_VERSION,
  IdeNotifications,
} from "./index.js";
import {
  startMockIdeServer,
  readBridgeDiscovery,
  bridgeWsUrl,
} from "./node.js";
import type { WsLike } from "./client.js";
import type { FocusChangedParams } from "./methods.js";

describe("ide-protocol P0 contracts", () => {
  it("writes discovery file and serves health + semantic context", async () => {
    const discoveryPath = join(tmpdir(), `aitest-p0-${Date.now()}`, "ide-bridge.json");
    const mock = await startMockIdeServer({
      discoveryPath,
      workspaceRoot: "D:/Demo",
    });

    try {
      const discovery = readBridgeDiscovery(discoveryPath);
      assert.ok(discovery);
      assert.equal(discovery!.protocolVersion, IDE_PROTOCOL_VERSION);
      assert.equal(discovery!.port, mock.port);
      assert.equal(discovery!.ide, "mock");
      assert.equal(bridgeWsUrl(discovery!), mock.url);

      const client = new IdeRpcClient({
        url: mock.url,
        token: mock.token,
        WebSocketImpl: WebSocket as unknown as new (url: string) => WsLike,
      });

      await client.connect();
      assert.equal(client.isConnected, true);

      const health = await client.health();
      assert.equal(health.status, "connected");
      assert.equal(health.ide, "mock");
      assert.equal(health.protocolVersion, IDE_PROTOCOL_VERSION);

      const packet = await client.getSemanticContext();
      assert.ok(isIdeSemanticPacket(packet));
      assert.equal(packet.focus.symbol, "AuthService");
      assert.equal(packet.focus.method, "login");
      assert.ok((packet.dependencies?.length ?? 0) >= 1);

      const method = await client.getCurrentMethod();
      assert.ok(method);
      assert.equal(method!.name, "login");

      const cls = await client.getCurrentClass();
      assert.ok(cls);
      assert.equal(cls!.name, "AuthService");

      client.disconnect();
    } finally {
      await mock.close();
    }
  });

  it("rejects wrong auth token", async () => {
    const discoveryPath = join(tmpdir(), `aitest-p0-bad-${Date.now()}`, "ide-bridge.json");
    const mock = await startMockIdeServer({ discoveryPath });
    const client = new IdeRpcClient({
      url: mock.url,
      token: "wrong-token",
      WebSocketImpl: WebSocket as unknown as new (url: string) => WsLike,
    });
    try {
      await assert.rejects(
        () => client.connect(),
        /32001|Invalid|Unauthorized|auth|Not authenticated/i
      );
    } finally {
      client.disconnect();
      await mock.close();
    }
  });

  it("pushes focusChanged notification to Desktop client (P1)", async () => {
    const discoveryPath = join(tmpdir(), `aitest-p1-focus-${Date.now()}`, "ide-bridge.json");
    const mock = await startMockIdeServer({ discoveryPath });
    const client = new IdeRpcClient({
      url: mock.url,
      token: mock.token,
      WebSocketImpl: WebSocket as unknown as new (url: string) => WsLike,
    });
    try {
      await client.connect();
      const got = await new Promise<FocusChangedParams>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("focusChanged timeout")), 2000);
        client.onNotification((method, params) => {
          if (method !== IdeNotifications.focusChanged) return;
          clearTimeout(t);
          resolve(params as FocusChangedParams);
        });
        mock.notifyFocusChanged({
          focus: {
            file: "src/foo.ts",
            symbol: "Foo",
            kind: "class",
            method: "bar",
          },
          confidence: "high",
        });
      });
      assert.equal(got.focus.symbol, "Foo");
      assert.equal(got.focus.method, "bar");
    } finally {
      client.disconnect();
      await mock.close();
    }
  });

  it("P10 command layer: searchSymbol / searchText / readFile / goto / refs (bounded)", async () => {
    const discoveryPath = join(tmpdir(), `aitest-p10-${Date.now()}`, "ide-bridge.json");
    const mock = await startMockIdeServer({ discoveryPath });
    const client = new IdeRpcClient({
      url: mock.url,
      token: mock.token,
      WebSocketImpl: WebSocket as unknown as new (url: string) => WsLike,
    });
    try {
      await client.connect();

      const symbols = await client.searchSymbol({ query: "Auth", maxResults: 5 });
      assert.ok(symbols.hits.length >= 1);
      assert.ok(symbols.hits.length <= 5);
      assert.ok(symbols.hits.some((h) => h.name === "AuthService"));

      const text = await client.searchText({ query: "findByEmail", maxResults: 10 });
      assert.ok(text.hits.length >= 1);
      assert.ok(text.hits[0].preview.includes("findByEmail"));

      const top = symbols.hits.find((h) => h.name === "AuthService") ?? symbols.hits[0];
      const file = await client.readFile({ pathRel: top.pathRel, maxBytes: 4096 });
      assert.ok(file.content.length > 0);
      assert.ok(file.content.length <= 4096);
      assert.equal(file.pathRel, top.pathRel);

      const def = await client.goToDefinition({ symbolId: top.id });
      assert.ok(def.locations.length >= 1);
      assert.equal(def.locations[0].pathRel, top.pathRel);

      const refs = await client.findReferences({ symbolId: top.id, maxResults: 8 });
      const refList = Array.isArray(refs) ? refs : refs.refs;
      assert.ok(refList.length >= 1);
      assert.ok(refList.length <= 8);

      const capped = await client.searchSymbol({ query: "e", maxResults: 9999 });
      assert.ok(capped.hits.length <= 20);
    } finally {
      client.disconnect();
      await mock.close();
    }
  });
});
