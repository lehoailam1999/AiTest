/**
 * Requirement hub — quản lý tổng thể theo Requirement + vào từng Requirement Studio.
 * Spec (cũ) đã bỏ khỏi hub (R8 cutover).
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Alert, Button, Typography } from "antd";
import { requirementStudio } from "../../api";
import RequirementStudioPage, {
  type StudioFocus,
  type StudioStatusSnapshot,
} from "../requirementStudio/RequirementStudioPage";
import JourneyListPanel from "../requirementStudio/JourneyListPanel";
import RequirementJourneyStrip, {
  buildRequirementJourney,
  type JourneyStageId,
} from "../requirementStudio/RequirementJourneyStrip";
import { ROUTES } from "../../lib/productRoutes";
import { useCoverageBoard } from "./model/useCoverageBoard";
import { ReviewQueuePanel } from "./ui/ReviewQueuePanel";

type HubTab = "home" | "studio" | "review";

export default function CoverageBoardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const workspaceId = searchParams.get("workspaceId")?.trim() || null;
  const tab: HubTab =
    rawTab === "review" && workspaceId
      ? "review"
      : rawTab === "studio" && workspaceId
        ? "studio"
        : workspaceId
          ? "studio"
          : "home";
  const stageParam = searchParams.get("stage");
  const studioFocus: StudioFocus =
    stageParam === "knowledge" ||
    stageParam === "chat" ||
    stageParam === "analyze" ||
    stageParam === "coverage"
      ? "knowledge"
      : stageParam === "freeze"
        ? "freeze"
        : "docs";
  const reviewModule = searchParams.get("module")?.trim() || undefined;
  const [studioStatus, setStudioStatus] = useState<StudioStatusSnapshot>({
    fileCount: 0,
    chunkCount: 0,
    knowledgeStatus: "empty",
    hasSnapshot: false,
  });
  const [journeySnapIds, setJourneySnapIds] = useState<Set<string>>(new Set());

  const { project, pendingCases, loading, refresh, invalidate } = useCoverageBoard({
    page: 1,
    pageSize: 50,
  });

  useEffect(() => {
    if (!workspaceId) {
      setJourneySnapIds(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await requirementStudio.listSnapshots(workspaceId);
        if (!cancelled) {
          setJourneySnapIds(new Set(res.items.map((s) => String(s.id))));
        }
      } catch {
        if (!cancelled) setJourneySnapIds(new Set());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, studioStatus.hasSnapshot]);

  const journeyPendingCases = useMemo(() => {
    if (!workspaceId) return [];
    return pendingCases.filter(
      (c) =>
        c.requirementSnapshotId && journeySnapIds.has(String(c.requirementSnapshotId))
    );
  }, [pendingCases, journeySnapIds, workspaceId]);

  const journeyPendingCount = journeyPendingCases.length;

  const journey = useMemo(
    () =>
      buildRequirementJourney({
        fileCount: studioStatus.fileCount,
        chunkCount: studioStatus.chunkCount,
        knowledgeStatus: studioStatus.knowledgeStatus,
        hasSnapshot: studioStatus.hasSnapshot,
        pendingReviewCount: journeyPendingCount,
        reviewActive: tab === "review",
      }),
    [studioStatus, journeyPendingCount, tab]
  );

  function setHome() {
    setSearchParams({}, { replace: true });
  }

  function openJourney(id: string, stage?: StudioFocus) {
    const q = new URLSearchParams();
    q.set("tab", "studio");
    q.set("workspaceId", id);
    if (stage && stage !== "docs") q.set("stage", stage);
    setSearchParams(q, { replace: true });
  }

  function openReview(id: string) {
    const q = new URLSearchParams();
    q.set("tab", "review");
    q.set("workspaceId", id);
    setSearchParams(q, { replace: true });
  }

  function setStudioFocus(next: StudioFocus) {
    if (!workspaceId) return;
    const q = new URLSearchParams(searchParams);
    q.set("tab", "studio");
    q.set("workspaceId", workspaceId);
    q.delete("view");
    if (next === "knowledge") q.set("stage", "knowledge");
    else if (next === "freeze") q.set("stage", "freeze");
    else q.delete("stage");
    setSearchParams(q, { replace: true });
  }

  function onJourneySelect(id: JourneyStageId) {
    if (!workspaceId) return;
    if (id === "docs") {
      setStudioFocus("docs");
      return;
    }
    if (id === "knowledge") {
      setStudioFocus("knowledge");
      return;
    }
    if (id === "freeze") {
      setStudioFocus("freeze");
      return;
    }
    if (id === "review") {
      openReview(workspaceId);
    }
  }

  if (!project) {
    return (
      <div className="page coverage-page req-studio-page">
        <header className="page-head req-studio-head">
          <div>
            <Typography.Title level={2}>Requirement</Typography.Title>
            <Typography.Text type="secondary">Chọn project để bắt đầu.</Typography.Text>
          </div>
        </header>
      </div>
    );
  }

  const inJourney = Boolean(workspaceId) && (tab === "studio" || tab === "review");

  return (
    <div className="page coverage-page req-studio-page">
      <header className="page-head req-studio-head">
        <div>
          <Typography.Title level={2}>Requirement</Typography.Title>
          <Typography.Text type="secondary" className="coverage-lead">
            Quản lý theo <strong>Requirement</strong> (mỗi phần nghiệp vụ một mục). Trong
            Requirement: tài liệu → phân tích → sinh TC → duyệt. Sau Approved, sang{" "}
            <Link to={ROUTES.unitTest}>Unit test</Link>.
          </Typography.Text>
        </div>
        <div className="page-head-actions">
          {inJourney ? (
            <>
              <Button onClick={setHome}>Tất cả Requirement</Button>
              <Button type="primary" onClick={() => setStudioFocus("docs")}>
                Thêm tài liệu
              </Button>
            </>
          ) : null}
        </div>
      </header>

      {inJourney ? (
        <RequirementJourneyStrip stages={journey} onSelect={onJourneySelect} />
      ) : null}

      <div className={`coverage-panel req-studio-panel${inJourney ? " req-studio-panel--journey" : ""}`}>
        {tab === "home" || !workspaceId ? (
          <JourneyListPanel
            onOpenJourney={(id) => openJourney(id)}
            onOpenReview={(id) => openReview(id)}
          />
        ) : tab === "review" ? (
          <div className="studio-page">
            <div className="studio-toolbar">
              <div className="studio-toolbar-main">
                <Button type="link" className="req-back-link" onClick={setHome}>
                  ← Tất cả Requirement
                </Button>
                <Typography.Title level={4} className="studio-title">
                  Duyệt TC
                  {journeyPendingCount > 0 ? (
                    <Typography.Text type="secondary" style={{ fontSize: 14, marginLeft: 8 }}>
                      {journeyPendingCount} chờ duyệt (Requirement này)
                    </Typography.Text>
                  ) : null}
                </Typography.Title>
                <Typography.Text type="secondary" className="studio-lead">
                  Chỉ TC sinh từ Snapshot của Requirement đang mở.
                </Typography.Text>
              </div>
            </div>
            {journeyPendingCount === 0 ? (
              <Alert
                type="info"
                showIcon
                title="Chưa có TC chờ duyệt trong Requirement này"
                description="Sinh TC từ tài liệu + Phân tích trước, hoặc quay lại Requirement khác."
                action={
                  <Button type="primary" onClick={() => setStudioFocus("freeze")}>
                    Sang Sinh test case
                  </Button>
                }
              />
            ) : (
              <ReviewQueuePanel
                projectId={project.id}
                cases={journeyPendingCases}
                moduleFilter={reviewModule}
                loading={loading}
                onChanged={() => {
                  invalidate();
                  void refresh();
                }}
              />
            )}
          </div>
        ) : (
          <RequirementStudioPage
            workspaceId={workspaceId}
            focus={studioFocus}
            onFocusChange={setStudioFocus}
            onStatusChange={setStudioStatus}
            onBackToHub={setHome}
            onNavigateReview={() => {
              void refresh();
              openReview(workspaceId);
            }}
          />
        )}
      </div>
    </div>
  );
}
