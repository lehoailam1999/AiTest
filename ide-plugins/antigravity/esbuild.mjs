import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  external: ["vscode"],
  platform: "node",
  format: "cjs",
  sourcemap: true,
  target: "node18",
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
  console.log("[aitest-ide-antigravity] watching…");
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("[aitest-ide-antigravity] compiled → out/extension.js");
}
