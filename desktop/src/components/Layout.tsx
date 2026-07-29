import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Avatar, Button, Typography } from "antd";
import { LogoutOutlined, UserOutlined } from "@ant-design/icons";
import { useAuth } from "../auth/AuthContext";
import { useProject } from "../state/ProjectContext";
import { ApiHealthBanner } from "./ApiHealthBanner";
import {
  E2E_TEST_MATCH,
  REQUIREMENT_MATCH,
  ROUTES,
  UNIT_TEST_MATCH,
  pathMatches,
} from "../lib/productRoutes";

type NavItem = {
  to: string;
  label: string;
  end?: boolean;
  match?: readonly string[];
};

/**
 * IA — Design (Requirement) → Automate (Unit Test Engine → Run) → Insight (Jobs).
 * Phase U4: không còn IDE-first trên happy path.
 */
const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: "Design",
    items: [
      { to: ROUTES.home, label: "Home", end: true },
      { to: ROUTES.projects, label: "Projects" },
      {
        to: ROUTES.requirement,
        label: "Requirement",
        match: REQUIREMENT_MATCH,
      },
    ],
  },
  {
    title: "Automate",
    items: [
      { to: ROUTES.unitTest, label: "Unit test", match: UNIT_TEST_MATCH },
      { to: ROUTES.e2eTest, label: "E2E test", match: E2E_TEST_MATCH },
      { to: ROUTES.run, label: "Chạy test" },
    ],
  },
  {
    title: "Insight",
    items: [
      { to: ROUTES.reports, label: "Báo cáo" },
      { to: ROUTES.activity, label: "Unit Jobs" },
      { to: ROUTES.settingsAi, label: "Cấu hình AI" },
    ],
  },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const { project } = useProject();
  const navigate = useNavigate();
  const location = useLocation();

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  const displayName = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "User";

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">AI</span>
          <span className="brand-name">Test Studio</span>
        </div>
        <div className={`active-project${project ? "" : " active-project--empty"}`}>
          <span className="muted">Dự án hiện tại</span>
          {project ? (
            <>
              <strong className="active-project-name">{project.name}</strong>
              <span className="active-project-status">Đang làm việc</span>
              <Button
                type="link"
                size="small"
                className="active-project-cta"
                onClick={() => navigate(ROUTES.requirement)}
              >
                Mở Requirement →
              </Button>
            </>
          ) : (
            <>
              <strong className="active-project-name active-project-name--empty">
                Chưa chọn dự án
              </strong>
              <span className="active-project-hint">
                Chu trình: Requirement → Unit / E2E Engine → Chạy test.
              </span>
              <Button
                type="link"
                size="small"
                className="active-project-cta"
                onClick={() => navigate(ROUTES.projects)}
              >
                Đi tới Projects →
              </Button>
            </>
          )}
        </div>
        <nav>
          {NAV_SECTIONS.map((section) => (
            <div key={section.title} className="nav-section">
              <span className="nav-section-title">{section.title}</span>
              {section.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => {
                    const matched = item.match
                      ? pathMatches(location.pathname, item.match)
                      : isActive;
                    return ["nav-item", matched ? "active" : ""].filter(Boolean).join(" ");
                  }}
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="user-card">
            <Avatar size={36} icon={<UserOutlined />} className="user-avatar" />
            <div className="user">
              <Typography.Text className="user-name" ellipsis>
                {displayName}
              </Typography.Text>
              <Typography.Text className="user-email" type="secondary" ellipsis>
                {user?.email}
              </Typography.Text>
            </div>
          </div>
          <Button className="logout-btn" icon={<LogoutOutlined />} onClick={handleLogout} block>
            Đăng xuất
          </Button>
        </div>
      </aside>
      <main className="content">
        <ApiHealthBanner />
        <Outlet />
      </main>
    </div>
  );
}
