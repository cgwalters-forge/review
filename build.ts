// Build the static app into dist/, or serve it for development:
//
//   node build.ts           # dist/: index.html, style.css, app.js
//   node build.ts --serve   # http://127.0.0.1:8787/, rebuilt on reload
//
// The output is code only. Nothing about the board or its items is
// fetched or embedded at build time.

import { copyFile, mkdir, rm } from "node:fs/promises";
import * as esbuild from "esbuild";

const OUT_DIR = "dist";
const STATIC_FILES = ["index.html", "style.css"];
const DEV_HOST = "127.0.0.1";
const DEV_PORT = 8787;

const options: esbuild.BuildOptions = {
  entryPoints: { app: "src/github/main.ts" },
  bundle: true,
  format: "esm",
  target: "es2022",
  outdir: OUT_DIR,
  minify: true,
  sourcemap: true,
  legalComments: "linked",
  logLevel: "info",
};

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });
await Promise.all(STATIC_FILES.map((f) => copyFile(`static/${f}`, `${OUT_DIR}/${f}`)));

if (process.argv.includes("--serve")) {
  const ctx = await esbuild.context(options);
  const { hosts, port } = await ctx.serve({ servedir: OUT_DIR, host: DEV_HOST, port: DEV_PORT });
  console.log(`Serving on http://${hosts[0] ?? DEV_HOST}:${port}/`);
} else {
  await esbuild.build(options);
}
