import { homedir } from "node:os";
import path from "node:path";

// Machine-scoped state (event ledger, telemetry config, self-check scan cache)
// lives under the user's home, never the project dir — foo used to write
// telemetry INTO the user's git repo and nothing gitignored it (see the ledger
// history in src/commands/agent.ts). FOO_STATE_DIR overrides for tests.
export function machineStateDir(): string {
  return process.env.FOO_STATE_DIR?.trim() || path.join(homedir(), ".foo");
}
