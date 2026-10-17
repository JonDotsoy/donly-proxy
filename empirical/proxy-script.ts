export const sh = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export interface ProxyRequest {
  host: string;
  path: string;
  /** Defaults to `GET`. */
  method?: string;
  /** Sent as the body (needs `client`). */
  body?: string;
  /** Asks for `https://<host><path>` through a `CONNECT` tunnel, trusting the self-signed certificate of the proxy (needs `client`). */
  https?: boolean;
}

/**
 * Bash that starts the proxy with the `manifest.donly` of `dir` (on `port 0`: the real port is read from its first line),
 * asks it for each request (a plain `GET` goes through a raw socket; HTTPS, bodies and other methods use the `client` curl), prints the answers, runs `after` (more script) and stops it.
 */
export const proxyScript = ({ dir, bun, main, requests, after = "", client }: { dir: string; bun: string; main: string; requests: ProxyRequest[]; after?: string; client?: string }) => {
  const asks = requests
    .map(({ host, path, method = "GET", body, https }) => {
      if (!https && body === undefined && method === "GET") {
        return `exec 3<>/dev/tcp/127.0.0.1/$port\nprintf ${sh(`GET http://${host}${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)} >&3\ncat <&3\nexec 3>&-`;
      }
      if (!client) throw new Error("a request with https, a body or a method other than GET needs a client");
      // The client is the real curl (its absolute path), so only the calls of the proxy are recorded.
      return `${sh(client)} -sS -i -k -x "http://127.0.0.1:$port" -X ${method}${body === undefined ? "" : ` --data-binary ${sh(body)}`} ${sh(`${https ? "https" : "http"}://${host}${path}`)} < /dev/null`;
    })
    .join("\n");
  return `cd ${sh(dir)}
${sh(bun)} ${sh(main)} manifest.donly > proxy.out 2>&1 &
proxy=$!
port=
for _ in $(seq 40); do
  port=$(sed -n 's/.*listening on [^ :]*:\\([0-9]*\\) .*/\\1/p' proxy.out | head -n 1)
  [ -n "$port" ] && break
  sleep 0.1
done
[ -n "$port" ] || { echo "the proxy did not start" >&2; kill $proxy; exit 1; }
${asks}
${after}
kill $proxy
wait $proxy
exit 0`;
};
