import type { Project, ProjectMeta } from "../api/types";
import { underGeneratedTestFolder, testFileNameFromSource } from "./testOutputLayout";

/** Infer primary language from a source path (monorepo-safe). */
export function languageFromSourcePath(path?: string | null): string | null {
  const p = (path || "").toLowerCase().replace(/\\/g, "/");
  if (!p) return null;
  if (p.endsWith(".cs")) return "C#";
  if (p.endsWith(".ts") || p.endsWith(".tsx")) return "TypeScript";
  if (p.endsWith(".js") || p.endsWith(".jsx")) return "JavaScript";
  if (p.endsWith(".py")) return "Python";
  if (p.endsWith(".go")) return "Go";
  if (p.endsWith(".rs")) return "Rust";
  if (p.endsWith(".java")) return "Java";
  if (p.endsWith(".kt")) return "Kotlin";
  if (p.endsWith(".php")) return "PHP";
  return null;
}

/** Source file extensions by language — empty = all common code extensions. */
export function sourceExtensionsForLanguage(language?: string | null): string[] {
  const lang = (language || "").toLowerCase();
  if (!lang) {
    return [
      ".cs",
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".py",
      ".go",
      ".rs",
      ".java",
      ".kt",
      ".php",
    ];
  }
  if (lang.includes("c#") || lang.includes("csharp") || lang.includes(".net")) {
    return [".cs"];
  }
  if (lang.includes("typescript") || lang.includes("javascript") || lang.includes("node")) {
    return [".ts", ".tsx", ".js", ".jsx"];
  }
  if (lang.includes("python")) return [".py"];
  if (lang.includes("go")) return [".go"];
  if (lang.includes("rust")) return [".rs"];
  if (lang.includes("java") || lang.includes("kotlin")) return [".java", ".kt"];
  if (lang.includes("php")) return [".php"];
  return [".cs", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt", ".php"];
}

export type TestFrameworkOption = { value: string; label: string };

/** Unit-test frameworks suggested from project language / stacks — không mặc định xUnit. */
export function testFrameworkOptions(
  language?: string | null,
  meta?: ProjectMeta | null
): TestFrameworkOption[] {
  const fromMeta = (meta?.testFrameworks ?? []).filter(Boolean);
  if (fromMeta.length > 0) {
    const mapped = fromMeta.map((f) => {
      const raw = f.toLowerCase().replace(/\s+/g, "");
      const value =
        raw.includes("xunit")
          ? "xunit"
          : raw.includes("nunit")
            ? "nunit"
            : raw.includes("mstest")
              ? "mstest"
              : raw.includes("vitest")
                ? "vitest"
                : raw.includes("jest")
                  ? "jest"
                  : raw.includes("mocha")
                    ? "mocha"
                    : raw.includes("pytest")
                      ? "pytest"
                      : raw;
      return { value, label: f };
    });
    // Deduplicate by canonical value
    const seen = new Set<string>();
    return mapped.filter((o) => {
      if (seen.has(o.value)) return false;
      seen.add(o.value);
      return true;
    });
  }

  const lang = (language || "").toLowerCase();
  const stacks = (meta?.stacks ?? []).map((s) => s.toLowerCase()).join(" ");

  if (lang.includes("c#") || lang.includes("csharp") || stacks.includes("asp.net")) {
    return [
      { value: "xunit", label: "xUnit" },
      { value: "nunit", label: "NUnit" },
      { value: "mstest", label: "MSTest" },
    ];
  }
  if (lang.includes("typescript") || lang.includes("javascript") || stacks.includes("node")) {
    return [
      { value: "jest", label: "Jest" },
      { value: "vitest", label: "Vitest" },
      { value: "mocha", label: "Mocha" },
    ];
  }
  if (lang.includes("python") || stacks.includes("fastapi") || stacks.includes("django")) {
    return [
      { value: "pytest", label: "pytest" },
      { value: "unittest", label: "unittest" },
    ];
  }
  if (lang.includes("go")) {
    return [{ value: "gotest", label: "go test" }];
  }
  if (lang.includes("java") || lang.includes("kotlin")) {
    return [
      { value: "junit", label: "JUnit" },
      { value: "testng", label: "TestNG" },
    ];
  }
  if (lang.includes("rust")) {
    return [{ value: "cargo", label: "cargo test" }];
  }
  if (lang.includes("php")) {
    return [
      { value: "phpunit", label: "PHPUnit" },
      { value: "pest", label: "Pest" },
    ];
  }

  return [
    { value: "auto", label: "Theo ngôn ngữ nguồn (AI tự chọn)" },
    { value: "xunit", label: "xUnit (.NET)" },
    { value: "jest", label: "Jest" },
    { value: "pytest", label: "pytest" },
    { value: "junit", label: "JUnit" },
    { value: "gotest", label: "go test" },
    { value: "phpunit", label: "PHPUnit" },
  ];
}

/** Lệnh chạy test gợi ý theo stack đã nhận diện — user có thể sửa. */
export function suggestTestCommand(project?: Project | null): string {
  if (!project) return "";
  const lang = (project.language || "").toLowerCase();
  const stacks = (project.meta?.stacks ?? []).map((s) => s.toLowerCase()).join(" ");
  const fw = (project.framework || "").toLowerCase();

  if (lang.includes("c#") || fw.startsWith("net") || stacks.includes("asp.net")) {
    return "dotnet test";
  }
  if (stacks.includes("vitest")) return "npx vitest run";
  if (stacks.includes("jest") || lang.includes("typescript") || lang.includes("javascript")) {
    return "npm test";
  }
  if (lang.includes("python") || stacks.includes("fastapi") || stacks.includes("django")) {
    return "pytest";
  }
  if (lang.includes("go")) return "go test ./...";
  if (lang.includes("rust")) return "cargo test";
  if (lang.includes("java") || stacks.includes("maven")) return "mvn test";
  if (stacks.includes("gradle")) return "gradle test";

  return "";
}

/** Nhãn parser/runner hiển thị trên màn Chạy test. */
export function runnerLabelFromCommand(command: string): string {
  const c = command.trim().toLowerCase();
  if (/^dotnet\s+test\b/.test(c) || c.includes("dotnet test")) return ".NET (TRX / console)";
  if (c.includes("pytest") || c.includes("py.test")) return "pytest";
  if (c.includes("vitest")) return "Vitest";
  if (c.includes("jest") || c.includes("npm test") || c.includes("pnpm test") || c.includes("yarn test"))
    return "Jest / npm test";
  if (c.includes("go test")) return "go test";
  if (c.includes("cargo test")) return "cargo test";
  if (c.includes("mvn test")) return "Maven";
  return "Tự động (đa runner)";
}

export type WorkspaceVerifyCommands = {
  compile: string;
  test: string;
  coverage: string;
};

/** Lệnh gợi ý khi verify workspace (sau staging tạm vào target paths). */
export function suggestWorkspaceVerifyCommands(opts: {
  language?: string | null;
  framework?: string | null;
  meta?: ProjectMeta | null;
  targetRelPaths: string[];
  /** Owning package (backend/, …) — empty when Apply root is the package. */
  packagePrefix?: string | null;
}): WorkspaceVerifyCommands {
  const lang = (opts.language || "").toLowerCase();
  const fw = (opts.framework || "").toLowerCase();
  const stacks = (opts.meta?.stacks ?? []).map((s) => s.toLowerCase()).join(" ");
  const paths = opts.targetRelPaths.map((p) => `"${p.replace(/"/g, "")}"`).join(" ");
  const underAitest = opts.targetRelPaths.some((p) =>
    /(?:^|\/)AItest\//i.test(p.replace(/\\/g, "/"))
  );

  if (lang.includes("c#") || lang.includes("csharp") || stacks.includes("asp.net")) {
    return {
      compile: "dotnet build",
      test: "dotnet test",
      coverage: "",
    };
  }

  if (lang.includes("python") || fw.includes("pytest") || stacks.includes("fastapi")) {
    const test = paths ? `pytest ${paths}` : "pytest";
    return {
      compile: "",
      test,
      coverage: paths
        ? `pytest ${paths} --cov --cov-report=term-missing`
        : "pytest --cov --cov-report=term-missing",
    };
  }

  if (
    lang.includes("typescript") ||
    lang.includes("javascript") ||
    fw.includes("jest") ||
    fw.includes("vitest")
  ) {
    if (underAitest && !fw.includes("vitest")) {
      // Nest default jest only scans src/**/*.spec.ts — use AItest config.
      // cwd resolves to package (backend/) via Tauri resolve_test_cwd.
      return {
        compile: "",
        test: "npx jest --config AItest/jest.config.cjs --runInBand",
        coverage: "",
      };
    }
    const test = paths ? `npm test -- ${paths}` : "npm test";
    return {
      compile: "",
      test,
      coverage: "",
    };
  }

  if (lang.includes("go")) {
    return { compile: "", test: paths ? `go test ${paths}` : "go test ./...", coverage: "" };
  }

  if (lang.includes("rust")) {
    return { compile: "", test: "cargo test", coverage: "" };
  }

  if (lang.includes("java") || stacks.includes("maven")) {
    return { compile: "mvn -q -DskipTests compile", test: "mvn test", coverage: "" };
  }

  const fallbackTest = lang.includes("python")
    ? "pytest"
    : lang.includes("go")
      ? "go test ./..."
      : "npm test";

  return {
    compile: "",
    test: opts.targetRelPaths.length ? `pytest ${paths}` : fallbackTest,
    coverage: "",
  };
}

export function unitTestFileExt(language?: string | null, sourceFileName?: string): string {
  if (sourceFileName) {
    const m = sourceFileName.match(/(\.[a-zA-Z0-9]+)$/);
    if (m) {
      const ext = m[1].toLowerCase();
      if ([".cs", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt"].includes(ext)) {
        return ext;
      }
    }
  }
  const lang = (language || "").toLowerCase();
  if (lang.includes("c#") || lang.includes("csharp")) return ".cs";
  if (lang.includes("typescript")) return ".ts";
  if (lang.includes("javascript")) return ".js";
  if (lang.includes("python")) return ".py";
  if (lang.includes("go")) return ".go";
  if (lang.includes("rust")) return ".rs";
  if (lang.includes("java")) return ".java";
  if (lang.includes("kotlin")) return ".kt";
  return ".txt";
}

function sanitizeBase(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, "");
  return cleaned || "Target";
}

/** Gợi ý đường dẫn ghi unit test — dưới AItest/UnitTest/{Module}/… */
export function suggestUnitTestPath(opts: {
  language?: string | null;
  framework?: string | null;
  sourceFileName?: string | null;
  className?: string | null;
  module?: string | null;
  packagePrefix?: string | null;
}): { relativePath: string; fileName: string } {
  const language = opts.language || "";
  const framework = (opts.framework || "").toLowerCase();
  const src = (opts.sourceFileName || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const srcDir = src.includes("/") ? src.slice(0, src.lastIndexOf("/")) : "";
  const stemFromSrc = src ? (src.split("/").pop() || "").replace(/\.[^.]+$/, "") : "";
  const base = sanitizeBase(opts.className || stemFromSrc || "Target");
  const ext = unitTestFileExt(language, src);
  const lang = language.toLowerCase();
  const pathOpts = {
    sourceFileName: src || null,
    module: opts.module || null,
    packagePrefix: opts.packagePrefix,
  };

  if (lang.includes("python") || framework.includes("pytest") || framework.includes("unittest")) {
    const fileName = testFileNameFromSource({
      sourceFileName: src,
      language,
      className: base,
      kind: "unit",
    });
    return {
      relativePath: underGeneratedTestFolder("unit", fileName, srcDir, pathOpts),
      fileName,
    };
  }

  if (lang.includes("go")) {
    const fileName = testFileNameFromSource({
      sourceFileName: src,
      language,
      className: base,
      kind: "unit",
    });
    return {
      relativePath: underGeneratedTestFolder("unit", fileName, srcDir, pathOpts),
      fileName,
    };
  }

  if (lang.includes("rust")) {
    const fileName = `${base.toLowerCase()}_test.rs`;
    return {
      relativePath: underGeneratedTestFolder("unit", fileName, srcDir, pathOpts),
      fileName,
    };
  }

  if (
    lang.includes("typescript") ||
    lang.includes("javascript") ||
    ["jest", "vitest", "mocha"].some((f) => framework.includes(f))
  ) {
    const fileName = testFileNameFromSource({
      sourceFileName: src,
      language,
      className: base,
      kind: "unit",
    });
    return {
      relativePath: underGeneratedTestFolder("unit", fileName, srcDir, pathOpts),
      fileName,
    };
  }

  if (lang.includes("java") || lang.includes("kotlin") || framework.includes("junit")) {
    const useExt = [".java", ".kt"].includes(ext) ? ext : ".java";
    const fileName = `${base}${base.endsWith("Test") ? "" : "Test"}${useExt}`.replace(
      /TestTest/,
      "Test"
    );
    return {
      relativePath: underGeneratedTestFolder("unit", fileName, srcDir, pathOpts),
      fileName,
    };
  }

  if (
    lang.includes("c#") ||
    lang.includes("csharp") ||
    ["xunit", "nunit", "mstest"].some((f) => framework.includes(f))
  ) {
    const fileName = testFileNameFromSource({
      sourceFileName: src || `${base}.cs`,
      language: "C#",
      className: base,
      kind: "unit",
    });
    return {
      relativePath: underGeneratedTestFolder("unit", fileName, srcDir, pathOpts),
      fileName,
    };
  }

  const fileName = `${base}Tests${ext}`;
  return {
    relativePath: underGeneratedTestFolder("unit", fileName, srcDir, pathOpts),
    fileName,
  };
}

/** Gợi ý đường dẫn API test — dưới AItest/APITest/{Module}/… */
export function suggestApiTestPath(opts: {
  language?: string | null;
  framework?: string | null;
  className?: string | null;
  sourceFileName?: string | null;
  module?: string | null;
  packagePrefix?: string | null;
}): { relativePath: string; fileName: string } {
  const lang = (opts.language || "").toLowerCase();
  const src = (opts.sourceFileName || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const srcDir = src.includes("/") ? src.slice(0, src.lastIndexOf("/")) : "";
  const base = sanitizeBase(opts.className || "Api");
  const pathOpts = {
    sourceFileName: src || null,
    module: opts.module || null,
    packagePrefix: opts.packagePrefix,
  };
  const fileName = testFileNameFromSource({
    sourceFileName: src || undefined,
    language: opts.language || (lang.includes("python") ? "Python" : lang.includes("c#") ? "C#" : "TypeScript"),
    className: base,
    kind: "api",
  });

  // Keep legacy-ish names when no source stem
  let name = fileName;
  if (!src) {
    if (lang.includes("python") || (opts.framework || "").toLowerCase().includes("pytest")) {
      name = `test_api_${base.toLowerCase()}.py`;
    } else if (lang.includes("typescript") || lang.includes("javascript")) {
      const ext = lang.includes("typescript") ? ".ts" : ".js";
      name = `${base.toLowerCase()}.api.test${ext}`;
    } else if (lang.includes("c#") || lang.includes("csharp")) {
      name = `${base}ApiTests.cs`;
    } else if (lang.includes("go")) {
      name = `${base.toLowerCase()}_api_test.go`;
    } else {
      name = `test_api_${base.toLowerCase()}.py`;
    }
  }

  return {
    relativePath: underGeneratedTestFolder("api", name, srcDir, pathOpts),
    fileName: name,
  };
}
