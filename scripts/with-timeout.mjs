// Run one discovery script under a hard wall-clock limit.
//
// discover-sf.mjs has its own deadline, but it is only checked between pages,
// and a browser call that never returns never reaches the check. From Oct 20
// 2026 every scheduled sweep hung inside that crawl until GitHub cancelled the
// whole job at its 40 minute limit, so nothing after it ran: Devpost, lablab,
// HackerRank and the normalizer were all skipped and the board stopped
// updating for two days. Killing the one stuck script, and its browser with it,
// costs that script's results and keeps everything else.
//
// usage: node scripts/with-timeout.mjs <minutes> <script> [args...]
import { spawn } from "node:child_process";

const [, , minutesArg, script, ...rest] = process.argv;
const minutes = Number(minutesArg);
if (!script || !Number.isFinite(minutes) || minutes <= 0) {
  console.error("usage: node scripts/with-timeout.mjs <minutes> <script> [args...]");
  process.exit(2);
}

// Its own process group, so the browser it launched dies with it.
const child = spawn(process.execPath, [script, ...rest], { stdio: "inherit", detached: true });
const timer = setTimeout(() => {
  console.error(`${script}: still running after ${minutes} min; killed so the rest of the sweep can publish.`);
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}, minutes * 60_000);
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  process.exit(code ?? (signal ? 1 : 0));
});
