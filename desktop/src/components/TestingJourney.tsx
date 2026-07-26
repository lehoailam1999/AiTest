import { Link } from "react-router-dom";
import { Button, Card, Space, Steps, Tag, Typography } from "antd";
import {
  JOURNEY_STEPS,
  type JourneyStepId,
  type JourneyStatus,
} from "../lib/testingJourney";
import { ROUTES } from "../lib/productRoutes";

type Props = {
  status: JourneyStatus;
  /** Bước user đang xem (highlight) */
  highlight: JourneyStepId;
  showNextAction?: boolean;
  compact?: boolean;
};

function stepIndex(id: JourneyStepId): number {
  return JOURNEY_STEPS.findIndex((s) => s.id === id);
}

export function TestingJourney({ status, highlight, showNextAction = true, compact }: Props) {
  const hi = stepIndex(highlight);
  const currentIdx = stepIndex(status.currentStep);

  const items = JOURNEY_STEPS.map((s, i) => {
    let st: "finish" | "process" | "wait" = "wait";
    if (i < currentIdx) st = "finish";
    else if (i === currentIdx || s.id === highlight) st = "process";
    return {
      title: compact ? s.shortTitle : s.title,
      description: compact ? undefined : s.description,
      status: st,
    };
  });

  return (
    <Card className="testing-journey-card" size="small" title="Luồng kiểm thử (Requirement → Unit test)">
      <Steps
        size="small"
        orientation={compact ? "horizontal" : "vertical"}
        current={hi >= 0 ? hi : currentIdx}
        items={items}
        style={{ marginBottom: showNextAction ? 16 : 0 }}
      />

      <Space wrap size="middle">
        <Tag color={status.prepareDone ? "success" : "default"}>
          AI {status.aiReady ? "Ready" : "chưa Ready"}
        </Tag>
        <Tag color={status.ideConnected ? "success" : "default"}>
          IDE {status.ideConnected ? "Connected" : "chưa Connect"}
        </Tag>
        <Tag color={status.hasLocalPath ? "success" : "default"}>
          Root Apply {status.hasLocalPath ? "đã gắn" : "chưa gắn"}
        </Tag>
        <Tag>{status.requirementCount} requirement</Tag>
        <Tag>{status.testCaseTotal} TC</Tag>
        <Tag color={status.approvedCount > 0 ? "success" : "warning"}>
          {status.approvedCount} Approved
        </Tag>
        {status.draftCount > 0 ? (
          <Tag color="orange">{status.draftCount} chờ duyệt</Tag>
        ) : null}
      </Space>

      {showNextAction ? (
        <div className="testing-journey-next" style={{ marginTop: 16 }}>
          <Typography.Text type="secondary" style={{ display: "block", marginBottom: 8 }}>
            Bước gợi ý tiếp theo
          </Typography.Text>
          <Space wrap>
            <Link to={status.nextPath}>
              <Button type="primary">{status.nextLabel}</Button>
            </Link>
            {status.codeReady && highlight !== "code" ? (
              <Link to={ROUTES.unitTest}>
                <Button>Unit test</Button>
              </Link>
            ) : null}
          </Space>
        </div>
      ) : null}
    </Card>
  );
}
