import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { projects } from "../api";
import { workspace } from "../workspace";

type ActiveProject = { id: string; name: string } | null;

type ProjectState = {
  project: ActiveProject;
  setProject: (id: string, name: string) => void;
  clearProject: () => void;
};

const ProjectContext = createContext<ProjectState | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [project, setProjectState] = useState<ActiveProject>(() => {
    const id = workspace.getActive();
    if (!id) return null;
    const recent = workspace.recent().find((p) => p.id === id);
    return recent ? { id, name: recent.name } : { id, name: "Project" };
  });

  const setProject = useCallback((id: string, name: string) => {
    workspace.setActive(id);
    workspace.addRecent(id, name);
    setProjectState({ id, name });
  }, []);

  const clearProject = useCallback(() => {
    workspace.clearActive();
    setProjectState(null);
  }, []);

  useEffect(() => {
    const id = workspace.getActive();
    if (!id) return;
    void projects
      .get(id)
      .then((p) => setProjectState({ id: p.id, name: p.name }))
      .catch(() => {
        workspace.clearActive();
        setProjectState(null);
      });
  }, []);

  const value = useMemo(
    () => ({ project, setProject, clearProject }),
    [project, setProject, clearProject]
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject() {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error("useProject must be used within ProjectProvider");
  return ctx;
}
