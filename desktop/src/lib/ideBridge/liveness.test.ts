import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import type { IdeBridgeDiscovery } from "@aitest/ide-protocol";
import {
  clearDiscoveryLivenessCache,
  filterAliveDiscoveries,
  markDiscoveryAlive,
  probeDiscoveryAlive,
} from "./liveness.js";

type Listener = (ev: { data?: unknown }) => void;

/** Bridge that completes the handshake and answers aitest/auth. */
class LiveWs {
  readyState = 0;
  private listeners = new Map<string, Set<Listener>>();

  constructor(_url: string) {
    setTimeout(() => {
      this.readyState = 1;
      this.emit("open", {});
    }, 0);
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    const req = JSON.parse(data) as { id: string | number };
    setTimeout(() => {
      this.emit("message", {
        data: JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }),
      });
    }, 0);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  private emit(type: string, ev: { data?: unknown }): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

/** Discovery file left behind by a killed IDE — nothing listens on the port. */
class DeadWs {
  readyState = 0;
  private listeners = new Map<string, Set<Listener>>();

  constructor(_url: string) {
    setTimeout(() => {
      this.readyState = 3;
      for (const l of this.listeners.get("error") ?? []) l({});
    }, 0);
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(): void {
    throw new Error("dead bridge");
  }

  close(): void {
    this.readyState = 3;
  }
}

function discovery(port: number): IdeBridgeDiscovery {
  return {
    protocolVersion: 1,
    port,
    token: `token-${port}`,
    ide: "cursor",
    workspaceRoot: "D:/Xlab/Forensic/forensic",
    startedAt: "2026-08-15T12:00:00.000Z",
  };
}

describe("probeDiscoveryAlive", () => {
  beforeEach(() => clearDiscoveryLivenessCache());

  it("accepts a bridge that connects and authenticates", async () => {
    const alive = await probeDiscoveryAlive(discovery(50159), {
      WebSocketImpl: LiveWs as never,
      timeoutMs: 200,
    });
    assert.equal(alive, true);
  });

  it("rejects a stale discovery whose port is dead", async () => {
    const alive = await probeDiscoveryAlive(discovery(64681), {
      WebSocketImpl: DeadWs as never,
      timeoutMs: 200,
    });
    assert.equal(alive, false);
  });

  it("reuses a fresh cached verdict instead of reconnecting", async () => {
    const d = discovery(50159);
    markDiscoveryAlive(d, true);
    const alive = await probeDiscoveryAlive(d, {
      WebSocketImpl: DeadWs as never,
      timeoutMs: 200,
    });
    assert.equal(alive, true);
  });
});

describe("filterAliveDiscoveries", () => {
  beforeEach(() => clearDiscoveryLivenessCache());

  it("drops dead ports and keeps list order", async () => {
    const dead = discovery(64681);
    const live = discovery(50159);
    markDiscoveryAlive(dead, false);
    markDiscoveryAlive(live, true);

    const kept = await filterAliveDiscoveries([dead, live], { timeoutMs: 50 });
    assert.deepEqual(
      kept.map((d) => d.port),
      [50159]
    );
  });
});
