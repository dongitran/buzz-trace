/**
 * Every test runs on an empty machine: no `~/.phoenix/phoenix.db` for Config to find, no PHOENIX_* variables of the
 * developer. A test that found a real database there (it did: a copy from days ago holding a session named `sess-1`)
 * passed or failed with the machine it ran on.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "buzz-trace-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
for (const name of [
  "PHOENIX_ENDPOINT",
  "PHOENIX_COLLECTOR_ENDPOINT",
  "PHOENIX_UI_ENDPOINT",
  "PHOENIX_PROJECT",
  "PHOENIX_DB_PATH",
  "PHOENIX_API_KEY",
]) {
  delete process.env[name];
}
process.on("exit", () => {
  fs.rmSync(home, { recursive: true, force: true });
});
