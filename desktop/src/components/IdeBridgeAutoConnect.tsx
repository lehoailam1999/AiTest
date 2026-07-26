/**
 * Keep IDE bridge session alive app-wide — must not depend on ReadyStrip expand.
 */
import { useEffect } from "react";
import { useIdeBridgeSession } from "../lib/ideBridge/session";
import { isTauri } from "../tauri/bridge";

export function IdeBridgeAutoConnect() {
  const connect = useIdeBridgeSession((s) => s.connect);

  useEffect(() => {
    if (!isTauri()) return;
    void connect();
    const id = window.setInterval(() => {
      const s = useIdeBridgeSession.getState().status;
      if (s === "error" || s === "idle") void connect();
    }, 5000);
    return () => window.clearInterval(id);
  }, [connect]);

  return null;
}
