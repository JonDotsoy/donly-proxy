export const sh = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export interface ProxyRequest {
  host: string;
  path: string;
}

/**
 * Bash that starts the proxy with the `manifest.donly` of `dir` (on `port 0`: the real port is read from its first line),
 * asks it for `GET http://<host><path>` for each request, prints the answers, runs `after` (more script) and stops it.
 */
export const proxyScript = ({ dir, bun, main, requests, after = "" }: { dir: string; bun: string; main: string; requests: ProxyRequest[]; after?: string }) => {
  const asks = requests
    .map(({ host, path }) => `exec 3<>/dev/tcp/127.0.0.1/$port\nprintf ${sh(`GET http://${host}${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)} >&3\ncat <&3\nexec 3>&-`)
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
