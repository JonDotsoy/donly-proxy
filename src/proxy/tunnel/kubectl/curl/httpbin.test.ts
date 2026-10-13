import { expect } from "bun:test";
import { cluster, httpbinManifest, useKind } from "../kind-fixture";

const kind = useKind("curl", httpbinManifest);

// The request leaves the cluster from the echo pod, so it needs outbound internet access.
for (const scheme of ["https", "http"] as const) {
  cluster(httpbinManifest, ["/proxy/route/kubectl_pass"], `should call ${scheme}://httpbin.io/get through kubectl_pass from the pod`, async () => {
    const url = `${scheme}://httpbin.io/get`;
    const before = kind.readLog().length;
    const res = await fetch(url, { proxy: kind.proxy(), tls: { rejectUnauthorized: false } });
    const text = await res.clone().text();
    expect(res.status, text).toBe(200);
    expect(await res.json()).toMatchObject({ method: "GET", url, headers: { Host: ["httpbin.io"] } });

    // It was the curl in the pod that made the request, not the proxy.
    const [request, response] = kind.readLog().slice(before);
    expect(request).toMatchObject({ type: "request", method: "GET", url });
    expect(response.command.slice(0, 3)).toEqual(["kubectl", "exec", "-i"]);
    expect(response.command).toContain("pod/echo");
    expect(response.command.join(" ")).toContain("curl ");
  }, 30_000);
}
