/**
 * Journey strip — Tài liệu → Phân tích → Tạo test case → Duyệt test case.
 */
import { CheckCircleFilled, LockOutlined } from "@ant-design/icons";

export type JourneyStageId =
  | "docs"
  | "knowledge"
  | "freeze"
  | "review";

export type JourneyStageState = "done" | "current" | "todo" | "locked";

export type JourneyStage = {
  id: JourneyStageId;
  label: string;
  hint: string;
  state: JourneyStageState;
};

type Props = {
  stages: JourneyStage[];
  onSelect?: (id: JourneyStageId) => void;
};

export function buildRequirementJourney(opts: {
  fileCount: number;
  chunkCount: number;
  knowledgeStatus?: string | null;
  hasSnapshot?: boolean;
  pendingReviewCount?: number;
  /** When user is on Duyệt TC pane */
  reviewActive?: boolean;
}): JourneyStage[] {
  const knowledgeReady = opts.knowledgeStatus === "ready";
  const knowledgeStale = opts.knowledgeStatus === "stale";
  const docsDone = opts.fileCount > 0 && opts.chunkCount > 0;
  const analysisOk = knowledgeReady || knowledgeStale;

  let knowledgeState: JourneyStageState = "todo";
  if (knowledgeReady) knowledgeState = "done";
  else if (knowledgeStale) knowledgeState = "current";
  else if (docsDone) knowledgeState = "current";
  else knowledgeState = "todo";

  let docsState: JourneyStageState = "todo";
  if (docsDone) docsState = "done";
  else docsState = "current";

  let freezeState: JourneyStageState = "locked";
  if (opts.hasSnapshot) freezeState = "done";
  else if (analysisOk) freezeState = "current";

  let reviewState: JourneyStageState = "locked";
  if (opts.reviewActive) reviewState = "current";
  else if ((opts.pendingReviewCount ?? 0) > 0) reviewState = "todo";
  else if (opts.hasSnapshot) reviewState = "todo";

  return [
    {
      id: "docs",
      label: "Tài liệu",
      hint: opts.fileCount ? `${opts.fileCount} file · ${opts.chunkCount} đoạn` : "Upload",
      state: docsState,
    },
    {
      id: "knowledge",
      label: "Phân tích",
      hint: knowledgeStale
        ? "Cần phân tích lại"
        : knowledgeReady
          ? "Sẵn sàng"
          : docsDone
            ? "Phân tích"
            : "Sau khi có đoạn",
      state: knowledgeState,
    },
    {
      id: "freeze",
      label: "Tạo test case",
      hint: opts.hasSnapshot
        ? "Đã chốt snapshot"
        : analysisOk
          ? "Từ tài liệu và phân tích"
          : "Sau khi phân tích xong",
      state: freezeState,
    },
    {
      id: "review",
      label: "Duyệt test case",
      hint:
        (opts.pendingReviewCount ?? 0) > 0
          ? `${opts.pendingReviewCount} chờ duyệt`
          : opts.hasSnapshot
            ? "Sau khi tạo test case"
            : "Sau khi chốt snapshot",
      state: reviewState,
    },
  ];
}

export default function RequirementJourneyStrip({ stages, onSelect }: Props) {
  return (
    <nav className="req-journey" aria-label="Các bước Requirement Studio">
      <ol className="req-journey-list">
        {stages.map((s, i) => {
          const clickable =
            Boolean(onSelect) &&
            (s.state === "done" ||
              s.state === "current" ||
              s.state === "todo" ||
              s.id === "review");
          const className = [
            "req-journey-step",
            `req-journey-step--${s.state}`,
            clickable ? "is-clickable" : "",
          ]
            .filter(Boolean)
            .join(" ");

          const inner = (
            <>
              <span className="req-journey-index" aria-hidden>
                {s.state === "done" ? (
                  <CheckCircleFilled />
                ) : s.state === "locked" ? (
                  <LockOutlined />
                ) : (
                  i + 1
                )}
              </span>
              <span className="req-journey-body">
                <span className="req-journey-label">{s.label}</span>
                <span className="req-journey-hint">{s.hint}</span>
              </span>
            </>
          );

          return (
            <li key={s.id} className={className}>
              {clickable && s.state !== "locked" ? (
                <button type="button" className="req-journey-btn" onClick={() => onSelect?.(s.id)}>
                  {inner}
                </button>
              ) : (
                <div className="req-journey-static">{inner}</div>
              )}
              {i < stages.length - 1 ? <span className="req-journey-sep" aria-hidden /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
