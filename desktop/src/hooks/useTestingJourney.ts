import { useCallback, useEffect, useState } from "react";
import { journey } from "../api";
import { computeJourneyStatus, type JourneyStatus } from "../lib/testingJourney";
import { rootsMismatch } from "../lib/ideBridge/rootsMatch";
import { useIdeBridgeSession } from "../lib/ideBridge/session";
import { useProject } from "../state/ProjectContext";
import { workspace } from "../workspace";

const EMPTY: JourneyStatus = computeJourneyStatus({
  hasProject: false,
  aiReady: false,
  hasLocalPath: false,
  ideConnected: false,
  rootsAligned: true,
  requirementCount: 0,
  testCaseTotal: 0,
  draftCount: 0,
  approvedCount: 0,
});

/** Prefer server journey-status (W4); merge local ProjectPath + IDE bridge for Phase B gate. */
export function useTestingJourney() {
  const { project } = useProject();
  const ideStatus = useIdeBridgeSession((s) => s.status);
  const ideRoot = useIdeBridgeSession((s) => s.workspaceRoot);
  const [status, setStatus] = useState<JourneyStatus>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!project) {
      setStatus(EMPTY);
      setError(null);
      return;
    }
    setLoading(true);
    const hasLocalPath = Boolean(workspace.getLocalPath(project.id));
    const localPath = workspace.getLocalPath(project.id);
    const ideConnected = useIdeBridgeSession.getState().status === "connected";
    const ideWorkspace = useIdeBridgeSession.getState().workspaceRoot;
    const aligned = !rootsMismatch(localPath, ideWorkspace);
    try {
      const dto = await journey.status(project.id, {
        ideRoot: ideWorkspace,
        localPath,
      });
      const rootsAligned =
        typeof dto.rootsAligned === "boolean" ? dto.rootsAligned : aligned;
      setStatus(
        computeJourneyStatus({
          hasProject: true,
          aiReady: dto.aiReady,
          hasLocalPath,
          ideConnected,
          rootsAligned,
          requirementCount: dto.requirementCount,
          testCaseTotal: dto.testCaseTotal,
          draftCount: dto.draftCount,
          approvedCount: dto.approvedCount,
        })
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không tải được journey");
      setStatus(
        computeJourneyStatus({
          hasProject: true,
          aiReady: false,
          hasLocalPath,
          ideConnected,
          rootsAligned: aligned,
          requirementCount: 0,
          testCaseTotal: 0,
          draftCount: 0,
          approvedCount: 0,
        })
      );
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const localPath = project ? workspace.getLocalPath(project.id) : null;
    const aligned = !rootsMismatch(localPath, ideRoot);
    setStatus((prev) =>
      computeJourneyStatus({
        hasProject: prev.hasProject,
        aiReady: prev.aiReady,
        hasLocalPath: prev.hasLocalPath,
        ideConnected: ideStatus === "connected",
        rootsAligned: aligned,
        requirementCount: prev.requirementCount,
        testCaseTotal: prev.testCaseTotal,
        draftCount: prev.draftCount,
        approvedCount: prev.approvedCount,
      })
    );
  }, [ideStatus, ideRoot, project]);

  return { status, loading, error, refresh, project };
}
