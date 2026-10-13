import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Generates a self-signed cert/key pair with openssl unless both files already exist. */
export const ensureCerts = ({ cert, key }: { cert: string; key: string }) => {
  if (existsSync(cert) && existsSync(key)) return;
  mkdirSync(dirname(cert), { recursive: true });
  mkdirSync(dirname(key), { recursive: true });
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "365", "-subj", "/CN=donly-proxy"],
    { stdio: "ignore" },
  );
};
