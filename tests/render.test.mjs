// bundles tests/render/entry.jsx with esbuild and runs it on the demo data
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const out = join(mkdtempSync(join(tmpdir(), "chouca-render-")), "render.mjs");
await build({ entryPoints: ["tests/render/entry.jsx"], bundle: true, platform: "node", format: "esm", outfile: out, jsx: "automatic",
  logLevel: "error", loader: { ".css": "empty" },
  // the map libraries need a browser: a stub stands in (the test renders HTML only)
  plugins: [{ name: "stub-maps", setup(b) {
    b.onResolve({ filter: /^(maplibre-gl|pmtiles)$/ }, () => ({ path: resolve("tests/render/stub.js") }));
  } }],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } });
execFileSync("node", [out, "tests/fixtures/demo"], { stdio: "inherit" });
