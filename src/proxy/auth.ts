import { createHash, timingSafeEqual } from "node:crypto";
import type { Directive } from "donly";

/** One `auth basic { username … password … }` of the `proxy` block. */
export interface AuthUser {
  username: string;
  password: string;
}

export const realm = "donly-proxy";
/** Headers of the 407 answer: the same for a missing header and for wrong credentials. */
export const challenge = { "proxy-authenticate": `Basic realm="${realm}", charset="UTF-8"`, "content-length": "0" };

const digest = (text: string) => createHash("sha256").update(text).digest();

/** Reads every `auth` directive of the `proxy` block; each `auth basic` declares one user. */
export const parseAuth = (proxy: Directive | undefined): AuthUser[] | undefined => {
  const directives = proxy?.children.filter((c) => c.name === "auth") ?? [];
  if (directives.length === 0) return undefined;
  const users: AuthUser[] = [];
  for (const directive of directives) {
    if (directive.args.length !== 1 || directive.args[0] !== "basic") throw new Error("auth: solo se soporta basic (auth basic { username … password … })");
    const field = (name: string) => directive.children.find((c) => c.name === name)?.args[0];
    const username = field("username");
    const password = field("password");
    const text = (value: unknown) => (typeof value === "string" || typeof value === "number") && String(value) !== "";
    if (!text(username) || !text(password)) throw new Error("auth basic: username y password son obligatorios y deben ser textos");
    if (String(username).includes(":")) throw new Error(`auth basic: username no puede contener ':' ("${username}")`);
    if (users.some((u) => u.username === String(username))) throw new Error(`auth basic: el usuario "${username}" está declarado más de una vez`);
    users.push({ username: String(username), password: String(password) });
  }
  return users;
};

/** Constant-time check of a username/password pair against every declared user. */
export const verify = (users: AuthUser[], username: string, password: string): boolean => {
  const given = [digest(username), digest(password)] as const;
  let ok = false;
  // Visit every user so the time does not tell which names exist.
  for (const user of users) {
    const same = timingSafeEqual(digest(user.username), given[0]) && timingSafeEqual(digest(user.password), given[1]);
    ok = ok || same;
  }
  return ok;
};

/** The user of a `Proxy-Authorization: Basic …` header, or `undefined` when it is missing, malformed or wrong. */
export const authenticate = (users: AuthUser[], header: string | undefined): string | undefined => {
  const credentials = basicCredentials(header);
  return credentials && verify(users, credentials.username, credentials.password) ? credentials.username : undefined;
};

/** The (unverified) pair of a Basic header; used to name the user of a failed attempt. */
export const basicCredentials = (header: string | undefined): AuthUser | undefined => {
  const match = /^basic +([A-Za-z0-9+/=_-]+) *$/i.exec(header ?? "");
  if (!match) return undefined;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon < 0 ? undefined : { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
};
