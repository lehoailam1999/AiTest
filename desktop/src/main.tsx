import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ConfigProvider, App as AntApp } from "antd";
import viVN from "antd/locale/vi_VN";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { ProjectProvider } from "./state/ProjectContext";
import "./styles.css";

function Root() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
        },
      })
  );

  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ConfigProvider
          locale={viVN}
          theme={{
            token: {
              colorPrimary: "#0f6e56",
              borderRadius: 10,
              fontFamily: '"Segoe UI", "IBM Plex Sans", sans-serif',
            },
          }}
        >
          <AntApp>
            <BrowserRouter>
              <AuthProvider>
                <ProjectProvider>
                  <App />
                </ProjectProvider>
              </AuthProvider>
            </BrowserRouter>
          </AntApp>
        </ConfigProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}

createRoot(document.getElementById("root")!).render(<Root />);
