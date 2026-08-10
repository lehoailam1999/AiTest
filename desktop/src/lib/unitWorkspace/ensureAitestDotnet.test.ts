/**
 * C# / .NET AItest host — project-agnostic helpers (no product names).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aitestUnitTestsCsprojRel,
  buildAitestDotnetTestCommand,
  buildAitestUnitTestsCsproj,
  csprojHasAitestExclude,
  csprojHasBadAitestInclude,
  csharpShortIdFromPath,
  detectCentralPackageManagement,
  ensureCsharpUniqueTestClass,
  ensureCsprojExcludesAitest,
  ensureSiblingDomainEntitiesUsing,
  filterPackagesForCentralManagement,
  fixCsharpMoqCompilePitfalls,
  isDefaultDotnetTestCommand,
  isTestCsprojRel,
  parseCentralPackageVersionIds,
  parseCsharpErrorFileRels,
  parseTargetFramework,
  pickProductionProjectRefFromCsproj,
  removeBogusCsharpUsings,
  resolveAitestCsharpVerifyCommands,
} from "./ensureAitestDotnet.js";
import { suggestWorkspaceVerifyCommands } from "../stackHints.js";

describe("ensureAitestDotnet", () => {
  it("parses short id from hashed test file name", () => {
    assert.equal(
      csharpShortIdFromPath("src/Lib/AItest/FooServiceTests_a1b2c3d4.cs"),
      "a1b2c3d4"
    );
    assert.equal(csharpShortIdFromPath("AItest/NoHash.cs"), "");
  });

  it("uniquifies public *Tests class names with file hash", () => {
    const src = `namespace X;\npublic class FooServiceTests\n{\n  public FooServiceTests() {}\n}\n`;
    const out = ensureCsharpUniqueTestClass(src, "a1b2c3d4");
    assert.match(out, /public class FooServiceTests_a1b2c3d4/);
    assert.match(out, /public FooServiceTests_a1b2c3d4\s*\(/);
    assert.doesNotMatch(out, /public FooServiceTests\s*\(/);
    assert.equal(ensureCsharpUniqueTestClass(out, "a1b2c3d4"), out);
  });

  it("drops invented third-party Core.Repository usings (CS0234)", () => {
    const src =
      `using Acme.Domain.Repositories.Interfaces;\n` +
      `using SomeVendor.Core.Repository;\n` +
      `using Moq;\n` +
      `using Xunit;\n` +
      `public class FooTests { Mock<IFluentRepository<object>> m = new(); }\n`;
    const out = removeBogusCsharpUsings(src);
    assert.doesNotMatch(out, /SomeVendor\.Core\.Repository/);
    assert.match(out, /Acme\.Domain\.Repositories\.Interfaces/);
    assert.match(out, /using Moq;/);
  });

  it("does not invent Domain.Entities; only expands empty SaveChangesAsync()", () => {
    const src =
      `using Acme.Domain.Repositories.Interfaces;\n` +
      `using Moq;\n` +
      `var x = new CaseRecordEvidence();\n`;
    // Must NOT invent Entities namespace — layouts differ per project
    assert.doesNotMatch(
      ensureSiblingDomainEntitiesUsing(src),
      /\.Domain\.Entities/
    );

    const bad =
      `using Acme.Infrastructure.Data.Repositories;\n` +
      `using Moq;\n`;
    assert.doesNotMatch(
      ensureSiblingDomainEntitiesUsing(bad),
      /Infrastructure\.Data\.Entities/
    );

    const moq =
      `_repo.Setup(r => r.SaveChangesAsync()).Returns(Task.CompletedTask);\n` +
      `Mock<INoSqlFluentRepository<CaseRecord>> q = new();\n` +
      `q.Setup(x => x.Include(It.IsAny<Expression<Func<CaseRecord, object>>>()));\n`;
    const fixed = fixCsharpMoqCompilePitfalls(moq);
    assert.match(fixed, /SaveChangesAsync\(It\.IsAny<CancellationToken>\(\)\)\)/);
    // Must NOT rewrite return type or INoSqlFluentRepository (stack-specific)
    assert.match(fixed, /Returns\(Task\.CompletedTask\)/);
    assert.match(fixed, /Mock<INoSqlFluentRepository</);
    assert.equal(
      fixCsharpMoqCompilePitfalls(`using Some.Pagination;\nx.Content.CaseCode`),
      `using Some.Pagination;\nx.Content.CaseCode`
    );

    const rels = parseCsharpErrorFileRels(
      `D:\\repo\\src\\Lib\\AItest\\UnitTest\\FooTests_abc.cs(10,1): error CS0246: x`,
      "D:/repo"
    );
    assert.deepEqual(rels, ["src/Lib/AItest/UnitTest/FooTests_abc.cs"]);
  });

  it("keeps FQN-used third-party usings", () => {
    const src =
      `using Vendor.Core.Repository;\n` +
      `var x = Vendor.Core.Repository.Thing.Create();\n`;
    assert.match(removeBogusCsharpUsings(src), /Vendor\.Core\.Repository/);
  });

  it("normalizes absolute list paths and builds ProjectReference", async () => {
    const { toProjectRel, projectRefFromAitestDir, packagePrefixFromAitestTargets } =
      await import("./ensureAitestDotnet.js");
    assert.equal(
      toProjectRel("D:/repo/app", "D:/repo/app/src/Lib/Lib.csproj"),
      "src/Lib/Lib.csproj"
    );
    assert.equal(
      projectRefFromAitestDir("src/Lib/Lib.csproj", "src/Lib"),
      "..\\Lib.csproj"
    );
    assert.equal(
      packagePrefixFromAitestTargets([
        { targetRel: "src/Lib/AItest/UnitTest/FooTests_abc.cs" },
      ]),
      "src/Lib"
    );
  });

  it("inserts AItest Compile Remove into production csproj", () => {
    const xml = `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n`;
    const next = ensureCsprojExcludesAitest(xml);
    assert.equal(csprojHasAitestExclude(next), true);
    assert.match(next, /Compile\s+Remove="AItest\\+\*\*"/);
    assert.match(next, /None\s+Remove="AItest\\+\*\*"/);
    assert.doesNotMatch(next, /None\s+Include="AItest/);
    assert.equal(ensureCsprojExcludesAitest(next), next);
  });

  it("repairs legacy None Include=AItest (MSB3030 nest)", () => {
    const bad =
      `<Project Sdk="Microsoft.NET.Sdk">\n` +
      `  <!-- AITest: keep generated tests out of production compile -->\n` +
      `  <ItemGroup>\n` +
      `    <Compile Remove="AItest\\**" />\n` +
      `    <None Include="AItest\\**" Condition="Exists('AItest')" />\n` +
      `  </ItemGroup>\n` +
      `</Project>\n`;
    assert.equal(csprojHasBadAitestInclude(bad), true);
    const next = ensureCsprojExcludesAitest(bad);
    assert.equal(csprojHasBadAitestInclude(next), false);
    assert.equal(csprojHasAitestExclude(next), true);
    assert.doesNotMatch(next, /None\s+Include="AItest/);
    assert.match(next, /None\s+Remove="AItest\\+\*\*"/);
  });

  it("pickProductionProjectRefFromCsproj prefers app host over Domain/Dto", () => {
    const xml =
      `<Project>\n` +
      `  <ItemGroup>\n` +
      `    <ProjectReference Include="..\\..\\src\\Acme.Domain\\Acme.Domain.csproj" />\n` +
      `    <ProjectReference Include="..\\..\\src\\Acme\\Acme.csproj" />\n` +
      `    <ProjectReference Include="..\\Other.Test\\Other.Test.csproj" />\n` +
      `  </ItemGroup>\n` +
      `</Project>\n`;
    assert.equal(
      pickProductionProjectRefFromCsproj(xml, "test/Acme.Test/Acme.Test.csproj"),
      "src/Acme/Acme.csproj"
    );
    assert.equal(isTestCsprojRel("test/Acme.Test/Acme.Test.csproj"), true);
    assert.equal(isTestCsprojRel("src/Acme/Acme.csproj"), false);
  });

  it("parses TargetFramework and CPM", () => {
    assert.equal(
      parseTargetFramework(`<TargetFrameworks>net6.0;net8.0</TargetFrameworks>`),
      "net6.0"
    );
    assert.equal(
      detectCentralPackageManagement(
        `<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>`
      ),
      true
    );
    assert.equal(detectCentralPackageManagement(null), false);
  });

  it("scaffolds UnitTests csproj with ProjectReference (relative, no product name)", () => {
    const body = buildAitestUnitTestsCsproj({
      targetFramework: "net8.0",
      sutCsprojRelFromAitest: "../MyLib.csproj",
      centralPackageVersions: false,
    });
    assert.match(body, /IsTestProject>true/);
    assert.match(body, /ProjectReference Include="\.\.\\MyLib\.csproj"/);
    assert.match(body, /PackageReference Include="xunit" Version=/);
    assert.doesNotMatch(body, /Forensic/i);
  });

  it("omits PackageReference Version under central package management", () => {
    const body = buildAitestUnitTestsCsproj({
      targetFramework: "net8.0",
      sutCsprojRelFromAitest: "../Lib.csproj",
      centralPackageVersions: true,
    });
    assert.match(body, /PackageReference Include="Moq"\s*\/>/);
    assert.doesNotMatch(body, /Include="Moq" Version=/);
  });

  it("CPM filter drops packages missing PackageVersion (Logging)", () => {
    const central = parseCentralPackageVersionIds(`
      <PackageVersion Include="Moq" Version="4.20.72" />
      <PackageVersion Include="FluentAssertions" Version="7.0.0" />
    `);
    const kept = filterPackagesForCentralManagement(
      ["Moq", "FluentAssertions", "Microsoft.Extensions.Logging.Abstractionsctions"],
      central
    );
    assert.deepEqual(kept, ["Moq", "FluentAssertions"]);
  });

  it("builds verify command under packagePrefix", () => {
    assert.equal(
      aitestUnitTestsCsprojRel("src/App.Lib"),
      "src/App.Lib/AItest/AItest.UnitTests.csproj"
    );
    assert.equal(
      buildAitestDotnetTestCommand("src/App.Lib"),
      `dotnet test "src/App.Lib/AItest/AItest.UnitTests.csproj" --nologo`
    );
    assert.equal(isDefaultDotnetTestCommand("dotnet test"), true);
    assert.equal(isDefaultDotnetTestCommand("dotnet test --nologo"), true);
    assert.equal(
      isDefaultDotnetTestCommand(
        `dotnet test "src/App.Lib/AItest/AItest.UnitTests.csproj" --nologo`
      ),
      false
    );
  });
});

describe("suggestWorkspaceVerifyCommands csharp AItest", () => {
  it("prefers AItest.UnitTests for C# under AItest paths", () => {
    const h = suggestWorkspaceVerifyCommands({
      language: "C#",
      framework: "xunit",
      targetRelPaths: ["src/Lib/AItest/FooTests_abc12345.cs"],
      packagePrefix: "src/Lib",
      stackInspect: {
        workspace_kind: "node",
        is_monorepo_package: true,
        run_command: ["npm", "test"],
        compile_command: [],
        coverage_command: [],
        package_root: "ClientApp",
      } as never,
    });
    assert.match(h.test, /AItest\.UnitTests\.csproj/);
    assert.doesNotMatch(h.test, /jest/i);
  });

  it("uses AItest host for batch empty paths when language is C#", () => {
    const h = suggestWorkspaceVerifyCommands({
      language: "csharp",
      targetRelPaths: [],
      packagePrefix: "backend",
    });
    assert.equal(h.test, `dotnet test "backend/AItest/AItest.UnitTests.csproj" --nologo`);
  });

  it("resolveAitestCsharpVerifyCommands rewrites jest/npm to AItest host", () => {
    const r = resolveAitestCsharpVerifyCommands("src/Lib", {
      compile: "",
      test: "npx jest --config AItest/jest.config.cjs --runInBand",
    });
    assert.equal(r.test, `dotnet test "src/Lib/AItest/AItest.UnitTests.csproj" --nologo`);
    assert.equal(r.compile, `dotnet build "src/Lib/AItest/AItest.UnitTests.csproj" --nologo`);
  });

  it("resolveAitestCsharpVerifyCommands keeps explicit AItest csproj commands", () => {
    const test = `dotnet test "AItest/AItest.UnitTests.csproj" --nologo --filter Foo`;
    const compile = `dotnet build "AItest/AItest.UnitTests.csproj" --nologo`;
    const r = resolveAitestCsharpVerifyCommands("", { compile, test });
    assert.equal(r.test, test);
    assert.equal(r.compile, compile);
  });

  it("detects C# from .cs overlay paths even when language empty (batch)", () => {
    const h = suggestWorkspaceVerifyCommands({
      language: "",
      targetRelPaths: [
        "apps/api/AItest/UnitTest/Orders/OrderControllerTests_abc123.cs",
      ],
      packagePrefix: "apps/api",
    });
    assert.match(h.test, /AItest\.UnitTests\.csproj/);
    assert.doesNotMatch(h.test, /jest/i);
  });

  it("keeps jest for typescript AItest", () => {
    const h = suggestWorkspaceVerifyCommands({
      language: "TypeScript",
      framework: "jest",
      targetRelPaths: ["AItest/foo.spec.ts"],
    });
    assert.match(h.test, /jest/i);
  });
});
