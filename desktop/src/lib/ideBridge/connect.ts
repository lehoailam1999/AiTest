/**
 * Desktop orchestrator — IDE bridge client (P0/P1).
 * Discovery JSON is loaded via Tauri / settings; this module stays browser-safe.
 */
import {
  IdeRpcClient,
  bridgeWsUrl,
  parseBridgeDiscoveryJson,
  type IdeBridgeDiscovery,
  type IdeSemanticPacket,
  type BridgeHealth,
  type IdeRpcClientOptions,
} from "@aitest/ide-protocol";

export type IdeBridgeConnection = {
  client: IdeRpcClient;
  discovery: IdeBridgeDiscovery;
};

export function discoveryFromJson(raw: string): IdeBridgeDiscovery {
  const d = parseBridgeDiscoveryJson(raw);
  if (!d) throw new Error("ide-bridge.json không hợp lệ");
  return d;
}

export async function connectIdeBridge(input: {
  discovery: IdeBridgeDiscovery;
  WebSocketImpl?: IdeRpcClientOptions["WebSocketImpl"];
}): Promise<IdeBridgeConnection> {
  const client = new IdeRpcClient({
    url: bridgeWsUrl(input.discovery),
    token: input.discovery.token,
    WebSocketImpl: input.WebSocketImpl,
  });
  await client.connect();
  return { client, discovery: input.discovery };
}

export async function fetchIdeSemanticContext(
  conn: IdeBridgeConnection
): Promise<IdeSemanticPacket> {
  return conn.client.getSemanticContext({ includeDependencies: true });
}

export async function fetchIdeHealth(conn: IdeBridgeConnection): Promise<BridgeHealth> {
  return conn.client.health();
}

export type { IdeSemanticPacket, BridgeHealth, IdeBridgeDiscovery };
