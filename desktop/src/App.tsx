import { Navigate, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "./auth/AuthContext";
import Layout from "./components/Layout";
import LoginPage from "./features/auth/LoginPage";
import HomePage from "./features/home/HomePage";
import ProjectsPage from "./features/projects/ProjectsPage";
import RequirementHubPage from "./features/requirement/RequirementHubPage";
import UnitTestPage from "./features/unit-test/UnitTestPage";
import RunTestPage from "./features/execution/RunTestPage";
import ReportsPage from "./features/reporting/ReportsPage";
import ActivityPage from "./features/activity/ActivityPage";
import SettingsAiPage from "./features/settings/SettingsAiPage";
import { ROUTES, unitTestUrl } from "./lib/productRoutes";

function Protected({ children }: { children: ReactNode }) {
  const { accessToken, loading } = useAuth();
  if (loading) return <div className="center">Loading…</div>;
  if (!accessToken) return <Navigate to="/login" replace />;
  return children;
}

/** Legacy redirects → Sinh mã Unit (AI CLI · project root). */
function RedirectToGenerateTests() {
  return <Navigate to={unitTestUrl()} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route path="/" element={<HomePage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path={ROUTES.requirement} element={<RequirementHubPage />} />
        <Route path={ROUTES.unitTest} element={<UnitTestPage />} />
        <Route path="/run" element={<RunTestPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/settings/ai" element={<SettingsAiPage />} />

        {/* R8 cutover — Spec / Generate-TC cũ → Requirement Studio */}
        <Route path="/spec" element={<Navigate to={ROUTES.requirement} replace />} />
        <Route
          path="/generate/tc"
          element={<Navigate to={ROUTES.requirement} replace />}
        />

        {/* Legacy → chu trình mới */}
        <Route path="/coverage" element={<Navigate to={ROUTES.requirement} replace />} />
        <Route path="/requirements" element={<Navigate to={ROUTES.requirement} replace />} />
        <Route path="/testcases" element={<Navigate to={ROUTES.requirement} replace />} />
        <Route path="/generate" element={<Navigate to={ROUTES.requirement} replace />} />
        <Route path="/generate/code" element={<RedirectToGenerateTests />} />
        <Route path="/generate-unit" element={<RedirectToGenerateTests />} />
        <Route path="/generate-api" element={<RedirectToGenerateTests />} />
        {/* Legacy Workspace Host / Open Project — removed from product path */}
        <Route path="/workspace" element={<RedirectToGenerateTests />} />
        <Route path="/repo" element={<RedirectToGenerateTests />} />
        <Route path="/open-project" element={<RedirectToGenerateTests />} />
        <Route path="/run-test" element={<Navigate to="/run" replace />} />
        <Route path="/jobs" element={<Navigate to="/activity?tab=unit-jobs" replace />} />
        <Route path="/settings" element={<Navigate to="/settings/ai" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
