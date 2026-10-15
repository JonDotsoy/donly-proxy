import type { Duplex } from "node:stream";

/** Where the client asked to be tunnelled to, as `host:port` (IPv6 literals in brackets). */
export interface SocksTarget {
  host: string;
  port: number;
}

/** Reads from a socket in exact amounts; `detach` hands the socket back with whatever was over-read. */
class Reader {
  private buffer = Buffer.alloc(0);
  private wake?: () => void;
  private closed = false;
  private readonly onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.wake?.();
  };
  private readonly onClose = () => {
    this.closed = true;
    this.wake?.();
  };

  constructor(private readonly socket: Duplex) {
    socket.on("data", this.onData);
    socket.on("close", this.onClose);
    socket.on("end", this.onClose);
  }

  private async fill(until: () => boolean) {
    while (!until()) {
      if (this.closed) throw new Error("socks: connection closed during the handshake");
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  async read(length: number) {
    await this.fill(() => this.buffer.length >= length);
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return out;
  }

  /** A NUL-terminated string (without the NUL), at most 255 bytes. */
  async readCString() {
    let end = -1;
    await this.fill(() => {
      end = this.buffer.indexOf(0);
      if (end < 0 && this.buffer.length > 255) throw new Error("socks: string too long");
      return end >= 0;
    });
    const out = this.buffer.subarray(0, end).toString("latin1");
    this.buffer = this.buffer.subarray(end + 1);
    return out;
  }

  detach() {
    this.socket.off("data", this.onData);
    this.socket.off("close", this.onClose);
    this.socket.off("end", this.onClose);
    this.socket.pause();
    return this.buffer;
  }
}

const formatHost = (host: string) => (host.includes(":") ? `[${host}]` : host);

/** Canonical (compressed) text of a 16-byte address, e.g. `2001:db8::1`. */
const ipv6 = (bytes: Buffer) => {
  const groups = Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16));
  return new URL(`http://[${groups.join(":")}]`).hostname.slice(1, -1);
};

/**
 * SOCKS handshake for `version` (4, which includes 4a, or 5), without authentication and with the
 * CONNECT command only. Resolves with the target and the bytes already read after the request;
 * rejects after answering the client with the matching error when it asks for anything else.
 * The socket is left paused.
 */
export const socksHandshake = async (socket: Duplex, version: 4 | 5): Promise<{ target: SocksTarget; rest: Buffer }> => {
  const reader = new Reader(socket);
  try {
    const [first] = await reader.read(1);
    if (first !== version) throw new Error(`socks: expected SOCKS${version}, got version ${first}`);
    const target = version === 4 ? await socks4(reader, socket) : await socks5(reader, socket);
    return { target, rest: reader.detach() };
  } catch (error) {
    reader.detach();
    throw error;
  }
};

const socks4 = async (reader: Reader, socket: Duplex): Promise<SocksTarget> => {
  const [command, portHi, portLo, a, b, c, d] = await reader.read(7);
  const reply = (granted: boolean) => socket.write(Buffer.from([0, granted ? 0x5a : 0x5b, 0, 0, 0, 0, 0, 0]));
  await reader.readCString(); // user id
  // SOCKS4a: the address 0.0.0.x (x != 0) means that a domain name follows.
  const domain = a === 0 && b === 0 && c === 0 && d !== 0 ? await reader.readCString() : undefined;
  if (command !== 1) {
    reply(false);
    throw new Error(`socks4: unsupported command ${command}`);
  }
  reply(true);
  return { host: domain ?? `${a}.${b}.${c}.${d}`, port: (portHi! << 8) | portLo! };
};

const socks5 = async (reader: Reader, socket: Duplex): Promise<SocksTarget> => {
  const [count] = await reader.read(1);
  const methods = await reader.read(count!);
  if (!methods.includes(0)) {
    socket.write(Buffer.from([5, 0xff]));
    throw new Error("socks5: no acceptable authentication method (only no-auth is supported)");
  }
  socket.write(Buffer.from([5, 0]));
  const [version, command, , type] = await reader.read(4);
  const reply = (code: number) => socket.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
  if (version !== 5) throw new Error(`socks5: unexpected version ${version}`);
  let host: string;
  if (type === 1) {
    host = [...(await reader.read(4))].join(".");
  } else if (type === 3) {
    const [length] = await reader.read(1);
    host = (await reader.read(length!)).toString("latin1");
  } else if (type === 4) {
    host = ipv6(await reader.read(16));
  } else {
    reply(8);
    throw new Error(`socks5: unsupported address type ${type}`);
  }
  const port = (await reader.read(2)).readUInt16BE(0);
  if (command !== 1) {
    reply(7);
    throw new Error(`socks5: unsupported command ${command}`);
  }
  reply(0);
  return { host, port };
};

/** `host:port` of a target the way the routes see it (the default `:443` is omitted, IPv6 in brackets). */
export const targetName = ({ host, port }: SocksTarget) => `${formatHost(host)}:${port}`.replace(/:443$/, "");
