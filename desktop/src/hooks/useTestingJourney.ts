import { useCallback, useEffect, useState } from "react";
import { journey } from "../api";
import { computeJourneyStatus, type JourneyStatus } from "../lib/testingJourney";
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

/** Prefer server journey-status; Local FS project root only (no IDE bridge). */
export function useTestingJourney() {
  const { project } = useProject();
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
    try {
      const dto = await journey.status(project.id, {
        localPath,
      });
      setStatus(
        computeJourneyStatus({
          hasProject: true,
          aiReady: dto.aiReady,
          hasLocalPath,
          ideConnected: false,
          rootsAligned: true,
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
          ideConnected: false,
          rootsAligned: true,
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

  return { status, loading, error, refresh };
}
