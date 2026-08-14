import type { AiCliId, AiCliOs } from "./types";

export type AiCliSetupGuide = {
  installCommand: Record<AiCliOs, string | null>;
  loginCommand: string | null;
  loginNote: string;
  docsUrl: string | null;
};

const GUIDES: Record<AiCliId, AiCliSetupGuide> = {
  "cursor-cli": {
    installCommand: {
      win32: "irm 'https://cursor.com/install?win32=true' | iex",
      darwin: "curl https://cursor.com/install -fsS | bash",
      linux: "curl https://cursor.com/install -fsS | bash",
    },
    loginCommand: "agent login",
    loginNote: "Cursor mở trình duyệt để đăng nhập; credential được Cursor lưu cục bộ.",
    docsUrl: "https://cursor.com/docs/cli/installation",
  },
  "gemini-cli": {
    installCommand: {
      win32: "npm install -g @google/gemini-cli",
      darwin: "npm install -g @google/gemini-cli",
      linux: "npm install -g @google/gemini-cli",
    },
    loginCommand: "gemini",
    loginNote: "Chọn Sign in with Google trong CLI và hoàn tất OAuth trên trình duyệt.",
    docsUrl: "https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/index.md",
  },
  "claude-cli": {
    installCommand: {
      win32: "irm https://claude.ai/install.ps1 | iex",
      darwin: "curl -fsSL https://claude.ai/install.sh | bash",
      linux: "curl -fsSL https://claude.ai/install.sh | bash",
    },
    loginCommand: "claude auth login",
    loginNote: "Claude mở luồng đăng nhập Anthropic; app không đọc hoặc lưu credential.",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code/setup",
  },
  "antigravity-cli": {
    installCommand: {
      win32: "irm https://antigravity.google/install.ps1 | iex",
      darwin: "curl -fsSL https://antigravity.google/install.sh | bash",
      linux: "curl -fsSL https://antigravity.google/install.sh | bash",
    },
    loginCommand: "agy",
    loginNote: "Lần chạy đầu, chọn phương thức đăng nhập và hoàn tất hướng dẫn trong CLI.",
    docsUrl: "https://antigravity.google/product/antigravity-cli",
  },
  ollama: {
    installCommand: {
      win32: "winget install Ollama.Ollama",
      darwin: "brew install ollama",
      linux: "curl -fsSL https://ollama.com/install.sh | sh",
    },
    loginCommand: null,
    loginNote: "Ollama local không cần đăng nhập. Cloud model mới cần `ollama signin`.",
    docsUrl: "https://docs.ollama.com/quickstart",
  },
  "custom-script": {
    installCommand: { win32: null, darwin: null, linux: null },
    loginCommand: null,
    loginNote: "Tự cài script của bạn, rồi chọn file executable bên dưới.",
    docsUrl: null,
  },
};

export function getAiCliSetupGuide(id: AiCliId): AiCliSetupGuide {
  return GUIDES[id];
}
