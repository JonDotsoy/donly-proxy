import { expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../server";
import { testFeature } from "../../../utils/test_utils/test-feature/test-feature";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-ssh-pass-options-"));
const load = (payload: string) => {
  const file = join(dir, `v-${Math.random()}.donly`);
  writeFileSync(file, payload);
  return loadConfig(file);
};
const sshPass = (body: string, line = "") => `proxy {\n  route {\n    ssh_pass ${line} {\n${body}\n      command_pass curl\n    }\n  }\n}\n`;
const argsOf = async (payload: string) => ((await load(payload)).routes[0]!.action as { args: string[] }).args;

testFeature(sshPass(`      host "user@remote.test"`), ["/proxy/route/ssh_pass/host"], "should read the host of ssh_pass from the host subdirective", async (payload) => {
  expect(await argsOf(payload)).toEqual(["user@remote.test"]);
});

testFeature(sshPass(`      host "remote.test"`, `"-v"`), ["/proxy/route/ssh_pass/host"], "should treat the arguments of the ssh_pass line as ssh options when host is a subdirective", async (payload) => {
  expect(await argsOf(payload)).toEqual(["-v", "remote.test"]);
});

testFeature(sshPass(`      host "remote.test"\n      identity_file "./keys/id_ed25519"`), ["/proxy/route/ssh_pass/identity_file"], "should turn identity_file of ssh_pass into -i resolved against the manifest", async (payload) => {
  expect(await argsOf(payload)).toEqual(["-i", join(dir, "keys/id_ed25519"), "remote.test"]);
});

testFeature(
  sshPass(`      host "remote.test"\n      option "StrictHostKeyChecking=accept-new"\n      option "IdentitiesOnly=yes"`),
  ["/proxy/route/ssh_pass/option"],
  "should turn each option of ssh_pass into an ssh -o",
  async (payload) => {
    expect(await argsOf(payload)).toEqual(["-o", "StrictHostKeyChecking=accept-new", "-o", "IdentitiesOnly=yes", "remote.test"]);
  },
);

testFeature(sshPass(`      host "remote.test"\n      extra_args "-4" "-v"`), ["/proxy/route/ssh_pass/extra_args"], "should append the extra_args of ssh_pass as ssh options", async (payload) => {
  expect(await argsOf(payload)).toEqual(["-4", "-v", "remote.test"]);
});

testFeature(
  sshPass(
    [
      `      host "remote.test"`,
      `      port 45322`,
      `      user "root"`,
      `      identity_file "./id"`,
      `      option "StrictHostKeyChecking=accept-new"`,
      `      extra_args "-v"`,
    ].join("\n"),
  ),
  ["/proxy/route/ssh_pass"],
  "should configure the whole ssh connection of ssh_pass with subdirectives",
  async (payload) => {
    expect(await argsOf(payload)).toEqual(["-p", "45322", "-l", "root", "-i", join(dir, "id"), "-o", "StrictHostKeyChecking=accept-new", "-v", "remote.test"]);
  },
);

testFeature(sshPass(`      host ""`), ["/proxy/route/ssh_pass/host"], "should reject an empty host in ssh_pass", async (payload) => {
  await expect(load(payload)).rejects.toThrow("host debe ser un destino");
});

testFeature(sshPass(`      host "remote.test"\n      identity_file 7`), ["/proxy/route/ssh_pass/identity_file"], "should reject an identity_file that is not a path in ssh_pass", async (payload) => {
  await expect(load(payload)).rejects.toThrow("identity_file debe ser una ruta");
});

testFeature(sshPass(`      host "remote.test"\n      option ""`), ["/proxy/route/ssh_pass/option"], "should reject an empty option in ssh_pass", async (payload) => {
  await expect(load(payload)).rejects.toThrow("option debe ser un texto no vacío");
});
