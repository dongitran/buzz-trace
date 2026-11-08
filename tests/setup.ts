/**
 * Every test runs on an empty machine: a home of its own and none of the developer's PHOENIX_* variables, so a test passes
 * or fails with the code and not with the machine it runs on.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "buzz-trace-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
for (const name of [
  "PHOENIX_ENDPOINT",
  "PHOENIX_URL",
  "PHOENIX_COLLECTOR_ENDPOINT",
  "PHOENIX_UI_ENDPOINT",
  "PHOENIX_PROJECT",
  "PHOENIX_API_KEY",
  "PHOENIX_EMAIL",
  "PHOENIX_PASSWORD",
]) {
  delete process.env[name];
}
process.on("exit", () => {
  fs.rmSync(home, { recursive: true, force: true });
});
