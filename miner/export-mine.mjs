// Produce the static `out/` export the store folds in as /mine.
//
// The app also ships dynamic POST route handlers under app/api (rpc proxy, forge requests).
// `output: "export"` refuses to build while those exist, and the store doesn't use them anyway
// (it serves its own /api/rpc Netlify function). So we move app/api aside, run the export build
// with EXPORT_MINE=1, and always move it back — even if the build fails.
//
//   node export-mine.mjs
import { renameSync, existsSync, rmSync } from "fs";
import { execSync } from "child_process";
import path from "path";

const root = process.cwd();
const api = path.join(root, "app", "api");
const apiOff = path.join(root, "app", "_api_off");

// Clean up a leftover from a previous crashed run.
if (existsSync(apiOff) && !existsSync(api)) renameSync(apiOff, api);

let moved = false;
try {
  if (existsSync(api)) { renameSync(api, apiOff); moved = true; }
  execSync("npx next build --webpack", {
    stdio: "inherit",
    env: { ...process.env, EXPORT_MINE: "1" },
  });
  if (!existsSync(path.join(root, "out", "mine.html")) && !existsSync(path.join(root, "out", "mine", "index.html"))) {
    throw new Error("export finished but out/mine(.html) is missing");
  }
  console.log("\n✓ static export written to out/ (with the mine fixes). Now rebuild the store zip.");
} finally {
  if (moved) {
    if (existsSync(api)) rmSync(api, { recursive: true, force: true }); // shouldn't happen, but never lose _api_off
    if (existsSync(apiOff)) renameSync(apiOff, api);
  }
}
