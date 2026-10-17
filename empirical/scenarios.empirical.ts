import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scenario, type ScenarioResult } from "./scenario";
import { scenariosDir } from "./session";

// Empirical scenarios: run REAL programs (kubectl, ssh, curl, node…) inside a bash with wrappers first in the `PATH`; every call of a
// wrapped program is recorded as a session in empirical/__scenarios__/<name>/. A scenario whose directory exists is NOT recorded again:
// delete the directory to record it again. Programs or settings a scenario needs and the machine lacks make it skip (nothing is created).
const root = mkdtempSync(join(tmpdir(), "donly-proxy-empirical-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const hasProgram = (program: string) => Bun.which(program) !== null;
const words = (value = "") => value.split(/\s+/).filter(Boolean);
const quoted = (args: string[]) => args.map((arg) => JSON.stringify(arg)).join(" ");
const sh = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

interface EmpiricalScenario {
  name: string;
  /** What the scenario shows. */
  summary: string;
  /** Programs recorded; all of them must exist on this machine. */
  wrap: string[];
  /** Why the scenario cannot be recorded on this machine, if so (missing environment variable). */
  unavailable?: string;
  script: string | (() => string);
  check?: (scenario: ScenarioResult) => void;
}

/** Script that starts the proxy with `routes` (manifest body), asks it for `GET http://<host><path>` for each request and stops it. */
const viaProxy = (routes: string, requests: { host: string; path: string }[]) => () => {
  const dir = mkdtempSync(join(root, "proxy-"));
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  writeFileSync(join(dir, "manifest.donly"), `proxy {\n  host "127.0.0.1"\n  port ${port}\n${routes}\n}\n`);
  const main = join(import.meta.dir, "..", "src", "cli", "main.ts");
  const asks = requests
    .map(({ host, path }) => `exec 3<>/dev/tcp/127.0.0.1/${port}\nprintf 'GET http://${host}${path} HTTP/1.1\\r\\nHost: ${host}\\r\\nConnection: close\\r\\n\\r\\n' >&3\ncat <&3\nexec 3>&-`)
    .join("\n");
  return `cd ${sh(dir)}
${sh(process.execPath)} ${sh(main)} manifest.donly > proxy.out 2>&1 &
proxy=$!
for _ in $(seq 100); do (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && break; sleep 0.1; done
${asks}
kill $proxy
wait $proxy
exit 0`;
};

const ssh = process.env.DONLY_E2E_SSH; // `user@host`; DONLY_E2E_SSH_ARGS: ssh options such as `-p 22 -i ~/.ssh/key`
const kubectl = process.env.DONLY_E2E_KUBECTL_POD; // `pod/name`; DONLY_E2E_KUBECTL_ARGS: kubectl options such as `-n prod`
const ipJson = /"ip":\s*"[\d.:a-f]+"/;
const ipify = [{ host: "api.ipify.org", path: "/?format=json" }];
const route = (body: string) => `  route http://api.ipify.org/* {\n${body}\n  }`;
const showsIp = (scenario: ScenarioResult) => expect(scenario.stdout).toMatch(ipJson);

const scenarios: EmpiricalScenario[] = [
  { name: "curl-version", summary: "curl --version", wrap: ["curl"], script: "curl --version" },
  { name: "wget-version", summary: "wget --version", wrap: ["wget"], script: "wget --version" },
  { name: "node-version", summary: "node --version", wrap: ["node"], script: "node --version" },
  { name: "kubectl-version", summary: "kubectl version --client", wrap: ["kubectl"], script: "kubectl version --client" },
  { name: "kubectl-unreachable-cluster", summary: "kubectl get pods against a cluster that refuses the connection", wrap: ["kubectl"], script: "kubectl --server=https://127.0.0.1:1 get pods" },
  { name: "ssh-version", summary: "ssh -V (prints on stderr)", wrap: ["ssh"], script: "ssh -V" },
  { name: "ssh-connection-refused", summary: "ssh to a port nobody listens on, in batch mode", wrap: ["ssh"], script: "ssh -o BatchMode=yes -o ConnectTimeout=3 -p 1 nobody@127.0.0.1 true" },
  // The proxy fetches the public IP of this machine with each real program.
  { name: "manifest-curl-public-ip", summary: "command_pass curl asking api.ipify.org for the public IP through the proxy", wrap: ["curl"], script: viaProxy(route(`    command_pass curl "--max-time" "15"`), ipify), check: showsIp },
  { name: "manifest-node-public-ip", summary: "command_pass node asking api.ipify.org for the public IP through the proxy", wrap: ["node"], script: viaProxy(route(`    command_pass node`), ipify), check: showsIp },
  {
    // Two wrapped programs in one scenario, each call a session of its own.
    name: "manifest-curl-and-node-public-ip",
    summary: "the proxy asks api.ipify.org twice, once with curl and once with node, in the same scenario",
    wrap: ["curl", "node"],
    script: viaProxy(
      `  route http://api.ipify.org/?format=json {\n    command_pass curl "--max-time" "15"\n  }\n  route http://api.ipify.org/?format=text {\n    command_pass node\n  }`,
      [{ host: "api.ipify.org", path: "/?format=json" }, { host: "api.ipify.org", path: "/?format=text" }],
    ),
    check: (scenario) => {
      expect(scenario.sessions.map((session) => session.program).sort()).toEqual(["curl", "node"]);
      expect(scenario.stdout).toMatch(ipJson);
      expect(scenario.stdout).toMatch(/text\/plain[\s\S]*\r\n[\d.:a-f]+\r\n0\r\n/);
    },
  },
  {
    name: "manifest-ssh-pass-public-ip",
    summary: "ssh_pass with a nested curl asking api.ipify.org for the public IP through the proxy",
    wrap: ["ssh"],
    unavailable: ssh ? undefined : "set DONLY_E2E_SSH=user@host",
    script: () => viaProxy(route(`    ssh_pass ${quoted([...words(process.env.DONLY_E2E_SSH_ARGS), ssh ?? ""])} {\n      command_pass curl\n    }`), ipify)(),
    check: showsIp,
  },
  {
    name: "manifest-kubectl-pass-public-ip",
    summary: "kubectl_pass with a nested curl asking api.ipify.org for the public IP through the proxy",
    wrap: ["kubectl"],
    unavailable: kubectl ? undefined : "set DONLY_E2E_KUBECTL_POD=pod/name",
    script: () => viaProxy(route(`    kubectl_pass ${quoted([...words(process.env.DONLY_E2E_KUBECTL_ARGS), kubectl ?? ""])} {\n      command_pass curl\n    }`), ipify)(),
    check: showsIp,
  },
];

for (const item of scenarios) {
  const missing = item.wrap.filter((program) => !hasProgram(program));
  const reason = existsSync(join(scenariosDir, item.name)) ? "scenario already recorded" : missing.length ? `missing ${missing.join(", ")}` : item.unavailable;
  test.skipIf(reason !== undefined)(`records the scenario ${item.name}${reason ? ` (skipped: ${reason})` : ""}`, async () => {
    // The proxy also calls curl or node on its own when a route asks for it: wrap them when the machine has them.
    const wrap = [...new Set([...item.wrap, ...["curl", "node"].filter(hasProgram)])];
    const script = typeof item.script === "function" ? item.script() : item.script;
    // Recorded in a temporary root: it only reaches its final place when the whole scenario (and its check) went well.
    const recorded = await Scenario.run({ name: item.name, wrap, script, root });
    expect(recorded.sessions.length).toBeGreaterThan(0);
    item.check?.(recorded);
    const final = join(scenariosDir, item.name);
    mkdirSync(scenariosDir, { recursive: true });
    renameSync(recorded.dir, final);
  });
}
