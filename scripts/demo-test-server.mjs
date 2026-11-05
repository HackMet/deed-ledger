#!/usr/bin/env node
// Runs the public demo locally for a person to test, safe from edits in progress:
// - from a frozen copy of this worktree (default ../hackathon-demo-test), so an agent saving files
//   here never restarts the server mid-reply; run this again to pick up new code;
// - with a fresh local database each start (the hourly store limit starts over);
// - with the once-a-minute sweep `wrangler dev` doesn't run, so a stranded reply is recovered;
// - with the real models: it refuses to start without MODEL_API_KEY in the environment, because
//   without it every reply is the "Lo estoy revisando" placeholder. The key goes to wrangler through
//   the environment only, never to a file.
//
//   MODEL_API_KEY=… node scripts/demo-test-server.mjs [--port 8795] [--dir ../hackathon-demo-test] [--no-ai]
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SIM_SECRETS, parseArgs, simChildEnv } from "./lib/sim.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? 8795);
const dest = resolve(source, String(args.dir ?? "../hackathon-demo-test"));
const key = process.env.MODEL_API_KEY ?? "";
if (key === "" && args["no-ai"] === undefined) {
  console.error("MODEL_API_KEY is not set: every reply would be the placeholder. Set it, or pass --no-ai on purpose.");
  process.exit(1);
}
// rsync --delete empties the destination of anything that isn't in the worktree, so it must be a folder
// this script made: never the worktree, a folder holding it or inside it, or any folder without the marker.
const MARKER = ".demo-test-copy";
const inside = (child, parent) => child === parent || child.startsWith(`${parent}/`);
if (inside(dest, source) || inside(source, dest)) throw new Error(`refusing ${dest}: it holds or is inside the worktree`);
if (existsSync(dest) && readdirSync(dest).length > 0 && !existsSync(`${dest}/${MARKER}`)) {
  throw new Error(`refusing ${dest}: it isn't empty and wasn't made by this script`);
}

const run = (cmd, cmdArgs) => {
  const result = spawnSync(cmd, cmdArgs, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} failed`);
};
// The code, without local state or secrets; node_modules hard-linked, so the copy is quick and small.
mkdirSync(dest, { recursive: true });
writeFileSync(`${dest}/${MARKER}`, "Made by scripts/demo-test-server.mjs; safe to delete.\n");
run("rsync", ["-a", "--delete", "--exclude", "/node_modules", "--exclude", "/.wrangler", "--exclude", "/.dev.vars", "--exclude", "/.git", "--exclude", `/${MARKER}`, `${source}/`, `${dest}/`]);
run("rsync", ["-a", "--delete", `--link-dest=${source}/node_modules`, `${source}/node_modules/`, `${dest}/node_modules/`]);

process.chdir(dest);
const persist = ".wrangler/test-state";
if (existsSync(persist)) rmSync(persist, { recursive: true });
const vars = {
  ...SIM_SECRETS,
  MODEL_API_KEY: "",
  DEV_CONSOLE: "",
  DEED_ENGINE: "1",
  CONVERSATION: "planner",
  CONSOLE_LANG: "en",
  PUBLIC_BASE_URL: `http://localhost:${port}`,
};
mkdirSync(".wrangler", { recursive: true });
writeFileSync(".wrangler/test.env", `${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n")}\n`);
const env = { ...simChildEnv(), ...vars, MODEL_API_KEY: key };
const migrate = spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], { env, encoding: "utf8" });
if (migrate.status !== 0) throw new Error(`migrations failed:\n${migrate.stdout}${migrate.stderr}`);

const dev = spawn("npx", ["wrangler", "dev", "--port", String(port), "--persist-to", persist, "--env-file", ".wrangler/test.env"], { env, stdio: "inherit" });
const sweep = setInterval(() => {
  fetch(`http://localhost:${port}/cdn-cgi/local/scheduled`).catch(() => {});
}, 60_000);
console.log(`\nDemo test server: http://localhost:${port}/demo  (frozen copy of ${source} in ${dest}; AI ${key === "" ? "OFF" : "on"})\n`);
dev.on("exit", (code) => {
  clearInterval(sweep);
  process.exit(code ?? 0);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => dev.kill(signal));
