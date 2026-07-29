import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Alert,
  Button,
  Card,
  Col,
  Progress,
  Row,
  Skeleton,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClusterOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
  ProjectOutlined,
  RocketOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { authFetch } from "../../api/client";
import { useTestingJourney } from "../../hooks/useTestingJourney";
import { useProject } from "../../state/ProjectContext";

type Dashboard = {
  totalProjects: number;
  totalRequirements: number;
  totalTestCases: number;
  executionPass: number;
  executionFail: number;
  jobCount: number;
  scopedToProject?: boolean;
};

type Kpi = {
  key: string;
  label: string;
  value: number | undefined;
  hint: string;
  icon: ReactNode;
  tone: "teal" | "blue" | "amber" | "violet" | "green" | "rose";
  to: string;
};

const QUICK_ACTIONS = [
  {
    to: "/projects",
    title: "Dự án",
    desc: "Tạo hoặc chọn dự án",
    icon: <ProjectOutlined />,
  },
  {
    to: "/requirement",
    title: "Requirement",
    desc: "Yêu cầu · chức năng · test case",
    icon: <ClusterOutlined />,
  },
  {
    to: "/unit-test",
    title: "Unit test",
    desc: "TC Approved → Project root → Unit Job → Staging → Apply (IDE tuỳ chọn)",
    icon: <ThunderboltOutlined />,
  },
  {
    to: "/run",
    title: "Chạy test",
    desc: "Execution & lịch sử lần chạy",
    icon: <PlayCircleOutlined />,
  },
];

type ReadyItem = {
  key: string;
  label: string;
  done: boolean;
  hint: string;
  to: string;
};

/**
 * Home — giao diện dashboard cũ + logic journey (1 primary CTA, không dual primary).
 */
export default function HomePage() {
  const { project } = useProject();
  const { status: journey, error: journeyError } = useTestingJourney();
  const location = useLocation();
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    const qs = project ? `?projectId=${encodeURIComponent(project.id)}` : "";
    return authFetch<Dashboard>(`/dashboard${qs}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Load failed"))
      .finally(() => setLoading(false));
  }, [project]);

  useEffect(() => {
    void load();
  }, [load, location.pathname]);

  const execTotal = (data?.executionPass ?? 0) + (data?.executionFail ?? 0);
  const passRate =
    execTotal > 0 ? Math.round(((data?.executionPass ?? 0) / execTotal) * 100) : 0;

  const kpis: Kpi[] = useMemo(
    () => [
      {
        key: "projects",
        label: "Dự án",
        value: data?.totalProjects,
        hint: project ? "Tổng hệ thống" : "Tổng số dự án",
        icon: <ProjectOutlined />,
        tone: "teal",
        to: "/projects",
      },
      {
        key: "reqs",
        label: "Yêu cầu",
        value: data?.totalRequirements,
        hint: project ? `Trong ${project.name}` : "Nguồn yêu cầu",
        icon: <FileTextOutlined />,
        tone: "blue",
        to: "/requirement",
      },
      {
        key: "tcs",
        label: "Test case",
        value: data?.totalTestCases,
        hint: project ? `Trong ${project.name}` : "Đã sinh / tạo thủ công",
        icon: <ClusterOutlined />,
        tone: "violet",
        to: "/requirement?tab=review",
      },
      {
        key: "jobs",
        label: "Công việc AI",
        value: data?.jobCount,
        hint: project ? `Trong ${project.name}` : "Job sinh TC",
        icon: <ThunderboltOutlined />,
        tone: "amber",
        to: "/activity",
      },
    ],
    [data, project]
  );

  const hour = new Date().getHours();
  const greet =
    hour < 12 ? "Chào buổi sáng" : hour < 18 ? "Chào buổi chiều" : "Chào buổi tối";

  const ctaPath = project ? journey.nextPath : "/projects";
  const ctaLabel = project ? journey.nextLabel : "Chọn dự án";

  const readyItems: ReadyItem[] = useMemo(
    () => [
      {
        key: "ai",
        label: "AI",
        done: journey.aiReady,
        hint: journey.aiReady ? "Ready" : "Cấu hình AI CLI",
        to: "/settings/ai",
      },
      {
        key: "tc",
        label: "Spec + TC Approved",
        done: journey.reviewDone,
        hint: journey.reviewDone
          ? `${journey.approvedCount} Approved`
          : journey.draftCount > 0
            ? `${journey.draftCount} chờ duyệt`
            : journey.specDone
              ? "Sinh / duyệt TC"
              : "Tạo requirement",
        to: "/requirement",
      },
      {
        key: "ide",
        label: "Project root",
        done: journey.hasLocalPath,
        hint: journey.hasLocalPath
          ? "Root OK · sẵn sàng sinh"
          : "Gắn root trên Sinh Unit",
        to: "/unit-test",
      },
      {
        key: "apply",
        label: "Sinh / Apply",
        done: journey.codeReady,
        hint: journey.codeReady ? "Sẵn sàng Unit" : "Cần TC Approved",
        to: journey.codeReady ? "/unit-test" : "/requirement",
      },
    ],
    [journey]
  );

  return (
    <div className="page dash">
      <section className="dash-hero">
        <div className="dash-hero-copy">
          <Typography.Text className="dash-eyebrow">AI Test Studio</Typography.Text>
          <Typography.Title level={2} className="dash-title">
            {greet}
          </Typography.Title>
          <Typography.Paragraph className="dash-lead">
            {project
              ? `Số liệu yêu cầu, test case, công việc AI và kết quả chạy test đang hiển thị cho dự án «${project.name}».`
              : "Tổng quan chất lượng kiểm thử — chọn dự án để xem số liệu theo từng dự án."}
          </Typography.Paragraph>
          <Space wrap size="middle" className="dash-hero-actions">
            {project ? (
              <Tag color="success" className="dash-project-tag">
                Project: {project.name}
              </Tag>
            ) : (
              <Tag color="warning" className="dash-project-tag">
                Chưa chọn project
              </Tag>
            )}
            <Link to={ctaPath}>
              <Button type="primary" size="large" icon={<RocketOutlined />}>
                {ctaLabel}
              </Button>
            </Link>
          </Space>
        </div>
        <div className="dash-hero-panel" aria-hidden>
          <div className="dash-orb dash-orb-a" />
          <div className="dash-orb dash-orb-b" />
          <div className="dash-hero-metric">
            <span className="dash-hero-metric-label">Pass rate</span>
            <strong className="dash-hero-metric-value">
              {loading ? "—" : execTotal === 0 ? "—" : `${passRate}%`}
            </strong>
            <span className="dash-hero-metric-sub">
              {execTotal === 0
                ? "Chưa có lần chạy"
                : `${data?.executionPass ?? 0}/${execTotal} passed`}
            </span>
          </div>
        </div>
      </section>

      {error || journeyError ? (
        <Alert type="error" showIcon title={error || journeyError || ""} />
      ) : null}

      {project ? (
        <Card
          className="dash-card"
          title="Sẵn sàng cho chu trình"
          variant="borderless"
          style={{ marginBottom: 16 }}
          extra={
            <Link to={ctaPath}>
              <Button type="link">{ctaLabel} →</Button>
            </Link>
          }
        >
          <Row gutter={[12, 12]}>
            {readyItems.map((item) => (
              <Col xs={12} md={6} key={item.key}>
                <Link to={item.to} style={{ color: "inherit", textDecoration: "none" }}>
                  <div
                    className={`dash-ready-item${item.done ? " dash-ready-item--done" : ""}`}
                    style={{
                      padding: "12px 14px",
                      borderRadius: 10,
                      border: "1px solid var(--ant-color-border-secondary, #e8eef3)",
                      background: item.done ? "rgba(15, 110, 86, 0.06)" : undefined,
                      height: "100%",
                    }}
                  >
                    <Space>
                      {item.done ? (
                        <CheckCircleOutlined style={{ color: "#0f6e56" }} />
                      ) : (
                        <CloseCircleOutlined style={{ color: "#adb5bd" }} />
                      )}
                      <div>
                        <Typography.Text strong style={{ display: "block" }}>
                          {item.label}
                        </Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {item.hint}
                        </Typography.Text>
                      </div>
                    </Space>
                  </div>
                </Link>
              </Col>
            ))}
          </Row>
        </Card>
      ) : null}

      <Row gutter={[16, 16]}>
        {kpis.map((k) => (
          <Col xs={24} sm={12} lg={6} key={k.key}>
            <Link to={k.to} className="dash-kpi-link">
              <Card className={`dash-kpi dash-kpi-${k.tone}`} variant="borderless" hoverable>
                {loading ? (
                  <Skeleton active paragraph={{ rows: 1 }} title={{ width: "60%" }} />
                ) : (
                  <>
                    <div className="dash-kpi-top">
                      <span className="dash-kpi-icon">{k.icon}</span>
                      <Typography.Text type="secondary">{k.label}</Typography.Text>
                    </div>
                    <div className="dash-kpi-value">{k.value ?? 0}</div>
                    <Typography.Text type="secondary" className="dash-kpi-hint">
                      {k.hint}
                    </Typography.Text>
                  </>
                )}
              </Card>
            </Link>
          </Col>
        ))}
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={10}>
          <Card className="dash-card" title="Kết quả thực thi" variant="borderless">
            {loading ? (
              <Skeleton active paragraph={{ rows: 4 }} />
            ) : (
              <>
                <div className="dash-exec-head">
                  <Progress
                    type="dashboard"
                    percent={execTotal === 0 ? 0 : passRate}
                    strokeColor={{ "0%": "#0f6e56", "100%": "#16b58a" }}
                    railColor="#e8eef3"
                    format={(p) => (
                      <span className="dash-progress-label">
                        <strong>{execTotal === 0 ? "—" : `${p}%`}</strong>
                        <small>pass</small>
                      </span>
                    )}
                  />
                  <div className="dash-exec-stats">
                    <div className="dash-exec-row ok">
                      <CheckCircleOutlined />
                      <div>
                        <strong>{data?.executionPass ?? 0}</strong>
                        <span>Đạt</span>
                      </div>
                    </div>
                    <div className="dash-exec-row bad">
                      <CloseCircleOutlined />
                      <div>
                        <strong>{data?.executionFail ?? 0}</strong>
                        <span>Thất bại</span>
                      </div>
                    </div>
                  </div>
                </div>
                <Link to="/run">
                  <Button block icon={<PlayCircleOutlined />}>
                    Chạy test mới
                  </Button>
                </Link>
              </>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={14}>
          <Card className="dash-card" title="Lối tắt nhanh" variant="borderless">
            <Row gutter={[12, 12]}>
              {QUICK_ACTIONS.map((a) => (
                <Col xs={24} sm={12} key={a.to}>
                  <Link to={a.to} className="dash-action">
                    <span className="dash-action-icon">{a.icon}</span>
                    <span className="dash-action-copy">
                      <strong>{a.title}</strong>
                      <small>{a.desc}</small>
                    </span>
                  </Link>
                </Col>
              ))}
            </Row>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
