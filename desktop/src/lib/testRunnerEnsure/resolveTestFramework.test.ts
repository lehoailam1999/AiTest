import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveTestFramework } from "./resolveTestFramework.ts";
import { assertSafeInstallCommand } from "./assertSafeInstall.ts";

describe("resolveTestFramework", () => {
  it("locks vitest when in package.json", () => {
    const r = resolveTestFramework({
      packageJsonContent: JSON.stringify({
        devDependencies: { vitest: "^2.0.0", vite: "^5.0.0" },
      }),
    });
    assert.equal(r.status, "present");
    assert.equal(r.framework, "vitest");
    assert.equal(r.locked, true);
    assert.equal(r.installCommand, null);
  });

  it("suggests vitest for vite project without test runner", () => {
    const r = resolveTestFramework({
      packageJsonContent: JSON.stringify({
        dependencies: { vite: "^5.0.0" },
      }),
    });
    assert.equal(r.status, "missing");
    assert.equal(r.framework, "vitest");
    assert.ok(r.installCommand?.includes("vitest"));
  });

  it("suggests jest for react-scripts", () => {
    const r = resolveTestFramework({
      packageJsonContent: JSON.stringify({
        dependencies: { "react-scripts": "5.0.1" },
      }),
    });
    assert.equal(r.framework, "jest");
    assert.equal(r.status, "missing");
  });

  it("suggests xunit scaffold — never dotnet add on production csproj", () => {
    const r = resolveTestFramework({
      scan: {
        projectPath: "D:/x",
        name: "x",
        solutionFiles: [],
        csprojFiles: ["D:/x/App.csproj"],
        testProjects: [],
        frameworks: ["net8.0"],
        testFrameworks: [],
        stacks: ["ASP.NET Core"],
        modules: [],
        language: "C#",
        tree: [],
      },
    });
    assert.equal(r.status, "missing");
    assert.equal(r.framework, "xunit");
    assert.ok(r.installCommand?.includes("dotnet new xunit"));
    assert.ok(r.installCommand?.includes("AItest.UnitTests"));
    assert.ok(!r.installCommand?.includes("App.csproj"));
  });

  it("dotnet add only targets scanned test projects", () => {
    const r = resolveTestFramework({
      preferredLanguage: "C#",
      sourceFile: "Services/Foo.cs",
      scan: {
        projectPath: "D:/x",
        name: "x",
        solutionFiles: [],
        csprojFiles: ["D:/x/App.csproj"],
        testProjects: ["D:/x/App.Tests.csproj"],
        frameworks: ["net8.0"],
        testFrameworks: [],
        stacks: ["ASP.NET Core"],
        modules: [],
        language: "C#",
        tree: [],
      },
    });
    assert.equal(r.status, "missing");
    assert.ok(r.installCommand?.includes('dotnet add "D:/x/App.Tests.csproj"'));
    assert.ok(!r.installCommand?.includes("App.csproj\" package"));
  });

  it("prefers scan xUnit over empty package.json (mixed / tooling root)", () => {
    const r = resolveTestFramework({
      packageJsonContent: JSON.stringify({ name: "tools", private: true }),
      scan: {
        projectPath: "D:/x",
        name: "x",
        solutionFiles: [],
        csprojFiles: ["D:/x/App.csproj"],
        testProjects: ["D:/x/App.Tests.csproj"],
        frameworks: ["net8.0"],
        testFrameworks: ["xUnit"],
        stacks: ["ASP.NET Core"],
        modules: [],
        language: "C#",
        tree: [],
      },
    });
    assert.equal(r.status, "present");
    assert.equal(r.framework, "xunit");
    assert.equal(r.locked, true);
  });

  it("locks xunit from csproj PackageReference content", () => {
    const r = resolveTestFramework({
      csprojContent: `<Project><ItemGroup><PackageReference Include="xunit" Version="2.9.0" /></ItemGroup></Project>`,
      scan: {
        projectPath: "D:/x",
        name: "x",
        solutionFiles: [],
        csprojFiles: ["D:/x/App.Tests.csproj"],
        testProjects: ["D:/x/App.Tests.csproj"],
        frameworks: ["net8.0"],
        testFrameworks: [],
        stacks: [],
        modules: [],
        language: "C#",
        tree: [],
      },
    });
    assert.equal(r.status, "present");
    assert.equal(r.framework, "xunit");
  });

  it("Forensic monorepo: C# source ignores ClientApp Jest in package.json", () => {
    const r = resolveTestFramework({
      preferredLanguage: "C#",
      sourceFile: "Services/CaseService.cs",
      packageJsonContent: JSON.stringify({
        devDependencies: { jest: "^29.0.0" },
      }),
      scan: {
        projectPath: "D:/Forensic",
        name: "Forensic",
        solutionFiles: ["D:/Forensic/Forensic.sln"],
        csprojFiles: ["D:/Forensic/Forensic.csproj"],
        testProjects: ["D:/Forensic/Forensic.Tests.csproj"],
        frameworks: ["net8.0"],
        testFrameworks: ["xUnit"],
        stacks: ["ASP.NET Core", "Node.js"],
        modules: [],
        language: "C# + JavaScript/TypeScript",
        tree: [],
      },
    });
    assert.equal(r.framework, "xunit");
    assert.equal(r.status, "present");
    assert.equal(r.locked, true);
  });

  it("flags missing @types/jest when Jest is installed alone", () => {
    const r = resolveTestFramework({
      preferredLanguage: "TypeScript",
      sourceFile: "backend/src/todos/todos.controller.ts",
      packageJsonContent: JSON.stringify({
        devDependencies: { jest: "^30.0.0", "ts-jest": "^29.0.0" },
      }),
    });
    assert.equal(r.framework, "jest");
    assert.equal(r.status, "missing");
    assert.deepEqual(r.packages, ["@types/jest"]);
    assert.ok(r.installCommand?.includes("@types/jest"));
  });

  it("locks jest when @types/jest is present", () => {
    const r = resolveTestFramework({
      preferredLanguage: "TypeScript",
      packageJsonContent: JSON.stringify({
        devDependencies: { jest: "^30.0.0", "@types/jest": "^30.0.0" },
      }),
    });
    assert.equal(r.framework, "jest");
    assert.equal(r.status, "present");
    assert.equal(r.locked, true);
  });
});

describe("assertSafeInstallCommand", () => {
  it("allows npm install -D", () => {
    assert.equal(
      assertSafeInstallCommand("npm install -D vitest"),
      "npm install -D vitest"
    );
  });

  it("rejects shell injection", () => {
    assert.throws(() => assertSafeInstallCommand("npm install -D vitest; rm -rf /"));
  });
});
