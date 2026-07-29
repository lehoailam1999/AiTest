/**

 * EX1.2 — Pipeline strip: status + duration; click → xem log phase.

 */

import { Steps, type StepsProps } from "antd";

import { formatDurationMs } from "../../lib/unitWorkspace/parseTestRunSummary";

import {

  E2E_PHASES,

  E2E_PHASE_LABEL,

  type E2eJobRunState,

  type E2ePhaseId,

  type E2ePhaseStatus,

} from "./e2eJobState";



type Props = {

  run: E2eJobRunState;

  busy: boolean;

  activePhase: E2ePhaseId | null;

  onSelectPhase: (id: E2ePhaseId) => void;

  /** Hiện cửa sổ Chromium khi Headless */

  showBrowser?: boolean;

};



function toStepsStatus(

  s: E2ePhaseStatus,

  isCurrent: boolean,

  busy: boolean

): StepsProps["status"] {

  if (s === "error") return "error";

  if (s === "finish" || s === "skip") return "finish";

  if (s === "process" || (isCurrent && busy)) return "process";

  return "wait";

}



function description(

  status: E2ePhaseStatus,

  durationMs?: number,

  healCount?: number,

  phaseId?: E2ePhaseId,

  showBrowser?: boolean

): string | undefined {

  if (status === "skip") return "Bỏ qua";

  if (status === "process") {

    if (phaseId === "headless") {

      return showBrowser ? "Xem từng bước…" : "Nền…";

    }

    if (phaseId === "generate") return "AI CLI…";

    if (phaseId === "inspect") return "DOM…";

    if (phaseId === "heal") return "Sửa selector…";

    return "…";

  }

  if (phaseId === "heal" && status === "finish" && (healCount || 0) > 0) {

    return `Đã sửa ${healCount}×`;

  }

  if (durationMs != null && durationMs >= 0 && (status === "finish" || status === "error")) {

    return formatDurationMs(durationMs);

  }

  return undefined;

}



export function E2ePipelineStrip({

  run,

  busy,

  activePhase,

  onSelectPhase,

  showBrowser = true,

}: Props) {

  const items: StepsProps["items"] = E2E_PHASES.map((id) => {

    const ph = run.phases[id];

    const isCurrent = run.current === id;

    return {

      title: E2E_PHASE_LABEL[id],

      status: toStepsStatus(ph.status, isCurrent, busy),

      description: description(

        ph.status,

        ph.durationMs,

        run.healCount,

        id,

        showBrowser

      ),

      onClick: () => onSelectPhase(id),

      style: { cursor: "pointer" },

      className:

        activePhase === id

          ? "e2e-pipe-step e2e-pipe-step--active"

          : "e2e-pipe-step",

    };

  });



  const currentIndex = run.current

    ? E2E_PHASES.indexOf(run.current)

    : E2E_PHASES.findIndex((id) => run.phases[id].status === "process");



  return (

    <div className="e2e-pipeline">

      <Steps

        size="small"

        current={currentIndex >= 0 ? currentIndex : 0}

        items={items}

      />

    </div>

  );

}


