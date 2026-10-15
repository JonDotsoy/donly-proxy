# Features

Generado por `bun run features` a partir de `spec_tests.json` (las specs que registra
`testFeature`, ver `src/utils/test_utils/test-feature`). No lo edites a mano.

Cada fila es un test: **Directivas** son las del manifest que el test ejercita.

Specs: **198** · ✅ pasan: **198** · 🔴 fallan: **0** · ⏳ sin resultado: **0**

| Feature | Estado | Directivas |
| --- | --- | --- |
| a 4xx response keeps its status even though wget exits with an error | ✅ | <code>engine wget</code> |
| a body becomes a POST sent from a temporary file | ✅ | <code>engine wget</code> |
| a failing process frees its place for the next request | ✅ | <code>command_pass curl</code><br><code>command_pass curl {</code><br><code>&nbsp;&nbsp;concurrency 2</code><br><code>}</code> |
| a GET becomes a fixed wget command line with quoted values | ✅ | <code>engine wget</code> |
| a later fetch without proxy still adds nothing to the log | ✅ | <code>log_file "./proxy.ndjson"</code> |
| a route without arguments matches every request | ✅ | <code>route {</code><br><code>&nbsp;&nbsp;respond 202 "catch-all"</code><br><code>}</code> |
| command_pass curl ends with command_end carrying exit_code and console_log | ✅ | <code>log_file "./proxy.ndjson"</code><br><code>&nbsp;&nbsp;command_pass curl</code> |
| command_pass curl hands the request to curl | ✅ | <code>command_pass curl "--connect-to" "curl.test:80:127.0.0.1:&lt;port&gt;"</code> |
| command_pass curl reports a bad gateway when curl fails | ✅ | <code>command_pass curl "--connect-to" "dead.test:80:127.0.0.1:&lt;port&gt;"</code> |
| command_pass curl runs the curl found in PATH | ✅ | <code>command_pass curl "--max-time" "5"</code> |
| command_pass kubectl uses curl when no engine is given | ✅ | <code>command_pass kubectl "-n" "prod" "--context" "dev" "deploy/api" {</code><br><code>&nbsp;&nbsp;engine curl</code><br><code>}</code><br><code>command_pass kubectl "pod/api-0" {</code><br><code>&nbsp;&nbsp;engine node</code><br><code>}</code><br><code>command_pass kubectl "pod/api-0"</code> |
| command_pass kubectl with engine curl reaches an echo Service in the kind-kind-cluster | ✅ | <code>kubectl_pass "--context" "kind-kind-cluster" "-n" "donly-proxy-test" "pod/echo" {</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code> |
| command_pass kubectl with engine curl runs the request inside the pod | ✅ | <code>engine curl</code><br><code>engine node</code> |
| command_pass kubectl with engine node reaches an echo Service in the kind-kind-cluster | ✅ |  |
| command_pass kubectl with engine node runs the request inside the pod | ✅ | <code>engine curl</code><br><code>engine node</code> |
| command_pass kubectl with engine wget reaches an echo Service in the kind-kind-cluster | ✅ | <code>kubectl_pass "--context" "kind-kind-cluster" "-n" "donly-proxy-test" "pod/echo" {</code><br><code>&nbsp;&nbsp;command_pass wget</code><br><code>}</code> |
| command_pass node logs its console in command_end without changing the response | ✅ | <code>log_file "./proxy.ndjson"</code><br><code>&nbsp;&nbsp;command_pass node</code> |
| command_pass node performs https requests with https.request | ✅ | <code>command_pass node "--no-warnings"</code><br><code>command_pass node "--no-warnings"</code> |
| command_pass node performs the request with http.request | ✅ | <code>command_pass node "--no-warnings"</code><br><code>command_pass node "--no-warnings"</code> |
| command_pass node reports a bad gateway when the request fails | ✅ | <code>command_pass node</code> |
| command_pass only supports known commands | ✅ | <code>command_pass wget</code> |
| command_pass ssh uses curl when no engine is given | ✅ | <code>command_pass ssh "-p" "2222" "user@remote.test" {</code><br><code>&nbsp;&nbsp;engine curl</code><br><code>}</code><br><code>command_pass ssh "user@remote.test" {</code><br><code>&nbsp;&nbsp;engine node</code><br><code>}</code><br><code>command_pass ssh "user@remote.test"</code> |
| command_pass ssh with engine curl runs the request on the remote host | ✅ | <code>engine curl</code><br><code>engine node</code> |
| command_pass ssh with engine node runs the request on the remote host | ✅ | <code>engine curl</code><br><code>engine node</code> |
| concurrency <n> allows n processes in parallel | ✅ | <code>concurrency 2</code> |
| concurrency must be a positive integer | ✅ | <code>concurrency 0</code> |
| each route has its own limit | ✅ | <code>command_pass curl</code><br><code>command_pass curl {</code><br><code>&nbsp;&nbsp;concurrency 2</code><br><code>}</code> |
| earlier routes win and the catch-all takes the rest | ✅ | <code>route http://specific.test/ {</code><br><code>&nbsp;&nbsp;respond 200 "specific"</code><br><code>}</code><br><code>route {</code><br><code>&nbsp;&nbsp;respond 202 "catch-all"</code><br><code>}</code><br><code>route http://never.test/ {</code><br><code>&nbsp;&nbsp;respond 200 "unreachable"</code><br><code>}</code> |
| echo-pod is not reachable directly but answers through kubectl_pass into conn-pod | ✅ | <code>kubectl_pass "conn-pod" {</code><br><code>&nbsp;&nbsp;context kind-kind-cluster</code><br><code>&nbsp;&nbsp;namespace donly-proxy-two-pods</code><br><code>&nbsp;&nbsp;command_pass node</code><br><code>}</code> |
| echo-pod logs every request it receives | ✅ | <code>kubectl_pass "conn-pod" {</code><br><code>&nbsp;&nbsp;context kind-kind-cluster</code><br><code>&nbsp;&nbsp;namespace donly-proxy-two-pods</code><br><code>&nbsp;&nbsp;command_pass node</code><br><code>}</code> |
| fetch through the proxy goes through it and is logged | ✅ | <code>log_file "./proxy.ndjson"</code> |
| fetch without proxy reaches the local server and writes no request log | ✅ | <code>log_file "./proxy.ndjson"</code> |
| GET http://example.com through the proxy is answered by the route | ✅ | <code>respond 201 "created"</code><br><code>respond 200 "good"</code> |
| GET https://example.com through the proxy is answered by the route | ✅ | <code>ssl {</code><br><code>&nbsp;&nbsp;cert "./certs/cert.pem"</code><br><code>&nbsp;&nbsp;key "./certs/key.pem"</code><br><code>}</code><br><code>&nbsp;&nbsp;respond 201 "created"</code><br><code>&nbsp;&nbsp;respond 200 "good"</code> |
| its pattern is a real wildcard, not the text 'undefined' | ✅ | <code>route {</code><br><code>&nbsp;&nbsp;respond 202 "catch-all"</code><br><code>}</code> |
| kubectl command_end logs the console (stdout, stderr and stdin) without changing the response | ✅ | <code>log_file "./console.ndjson"</code><br><code>&nbsp;&nbsp;command_pass kubectl "pod/api-0"</code> |
| kubectl failures are reported as a bad gateway | ✅ | <code>command_pass kubectl "-n" "prod" "--context" "dev" "deploy/api" {</code><br><code>&nbsp;&nbsp;engine curl</code><br><code>}</code><br><code>command_pass kubectl "pod/api-0" {</code><br><code>&nbsp;&nbsp;engine node</code><br><code>}</code><br><code>command_pass kubectl "pod/api-0"</code> |
| kubectl_pass with a nested command_pass curl runs the request inside the pod with the curl options | ✅ | <code>kubectl_pass "-n" "prod" "deploy/api" {</code><br><code>&nbsp;&nbsp;command_pass curl "--max-time" "5"</code><br><code>}</code><br><code>kubectl_pass {</code><br><code>&nbsp;&nbsp;pod_name "my-pod-12345"</code><br><code>&nbsp;&nbsp;context local-my-context</code><br><code>&nbsp;&nbsp;namespace the-namespace</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>kubectl_pass {</code><br><code>&nbsp;&nbsp;pod_match my-pod-*</code><br><code>&nbsp;&nbsp;context local-my-context</code><br><code>&nbsp;&nbsp;namespace the-namespace</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code> |
| kubectl_pass with pod_match answers 502 when kubectl get pods fails | ✅ | <code>pod_match my-pod-*</code> |
| kubectl_pass with pod_match lists the pods and runs in the first one that matches | ✅ | <code>pod_match my-pod-*</code> |
| kubectl_pass with pod_match logs the kubectl get pods command before the kubectl exec | ✅ | <code>log_file "./podmatch.ndjson"</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;pod_match my-pod-*</code> |
| kubectl_pass without a positional argument takes the pod from pod_name | ✅ | <code>pod_name "my-pod-12345"</code> |
| loadConfig reads concurrency, defaulting to 1 | ✅ | <code>concurrency 2</code> |
| log_file and ssl are resolved relative to the manifest, not the cwd | ✅ | <code>log_file "../out/rel.ndjson"</code><br><code>ssl {</code><br><code>&nbsp;&nbsp;cert "../ssl/cert.pem"</code><br><code>&nbsp;&nbsp;key "../ssl/key.pem"</code><br><code>}</code> |
| log_file only supports .ndjson | ✅ | <code>log_file "./proxy.log"</code> |
| log_file records request and response sharing a transaction id | ✅ | <code>log_file "./logs/proxy.ndjson"</code> |
| log_file snapshot | ✅ | <code>log_file "./snap.ndjson"</code> |
| logs request, kubectl, node, end node, end kubectl and response as nested transactions | ✅ | <code>log_file "./proxy.ndjson"</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;command_pass node</code> |
| logs request, request proxy_pass, response proxy_pass and response as nested transactions | ✅ | <code>log_file "./proxy.ndjson"</code><br><code>&nbsp;&nbsp;proxy_pass "http://127.0.0.1:&lt;port&gt;"</code> |
| logs the curl command that was executed | ✅ | <code>log_file "./proxy.ndjson"</code><br><code>&nbsp;&nbsp;command_pass curl "--max-time" "5"</code><br><code>&nbsp;&nbsp;command_pass node "--no-warnings"</code><br><code>&nbsp;&nbsp;command_pass ssh "-p" "2222" "user@remote.test"</code><br><code>&nbsp;&nbsp;command_pass kubectl "-n" "prod" "deploy/api"</code> |
| logs the kubectl command that was executed | ✅ | <code>log_file "./proxy.ndjson"</code><br><code>&nbsp;&nbsp;command_pass curl "--max-time" "5"</code><br><code>&nbsp;&nbsp;command_pass node "--no-warnings"</code><br><code>&nbsp;&nbsp;command_pass ssh "-p" "2222" "user@remote.test"</code><br><code>&nbsp;&nbsp;command_pass kubectl "-n" "prod" "deploy/api"</code> |
| logs the node command that was executed | ✅ | <code>log_file "./proxy.ndjson"</code><br><code>&nbsp;&nbsp;command_pass curl "--max-time" "5"</code><br><code>&nbsp;&nbsp;command_pass node "--no-warnings"</code><br><code>&nbsp;&nbsp;command_pass ssh "-p" "2222" "user@remote.test"</code><br><code>&nbsp;&nbsp;command_pass kubectl "-n" "prod" "deploy/api"</code> |
| logs the ssh command of ssh_pass with its arguments, without the password | ✅ | <code>log_file "./proxy.ndjson"</code><br><code>&nbsp;&nbsp;ssh_pass logged-host "-v" {</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;port 2200</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;user deploy</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;pass "top-secret"</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;command_pass curl "--max-time" "5"</code><br><code>&nbsp;&nbsp;}</code> |
| logs the ssh command that was executed, including the remote command | ✅ | <code>log_file "./proxy.ndjson"</code><br><code>&nbsp;&nbsp;command_pass curl "--max-time" "5"</code><br><code>&nbsp;&nbsp;command_pass node "--no-warnings"</code><br><code>&nbsp;&nbsp;command_pass ssh "-p" "2222" "user@remote.test"</code><br><code>&nbsp;&nbsp;command_pass kubectl "-n" "prod" "deploy/api"</code> |
| manifest validation for kubectl | ✅ | <code>command_pass kubectl</code> |
| manifest validation for kubectl_pass | ✅ | <code>kubectl_pass {</code><br><code>command_pass curl</code><br><code>}</code> |
| manifest validation for pod_match | ✅ | <code>pod_match ""</code> |
| manifest validation for pod_name | ✅ |  |
| manifest validation for ssh and engine | ✅ | <code>command_pass ssh</code> |
| manifest.donly configures the proxy | ✅ | <code>host "127.0.0.1"</code><br><code>port 0</code><br><code>ssl {</code><br><code>&nbsp;&nbsp;cert "./certs/cert.pem"</code><br><code>&nbsp;&nbsp;key "./certs/key.pem"</code><br><code>}</code> |
| methods other than GET and POST are refused | ✅ | <code>engine wget</code> |
| proxy_pass forwards method, path, query and body to the target | ✅ | <code>proxy_pass "http://127.0.0.1:&lt;port&gt;"</code><br><code>proxy_pass "http://127.0.0.1:&lt;port&gt;/fixed"</code> |
| proxy_pass with a target path replaces the path | ✅ | <code>proxy_pass "http://127.0.0.1:&lt;port&gt;"</code><br><code>proxy_pass "http://127.0.0.1:&lt;port&gt;/fixed"</code> |
| proxy_pass works through an https tunnel | ✅ | <code>proxy_pass "http://127.0.0.1:&lt;port&gt;"</code><br><code>proxy_pass "http://127.0.0.1:&lt;port&gt;/fixed"</code> |
| request data cannot break out of the shell quoting | ✅ | <code>engine wget</code> |
| request data never reaches the command line or a shell | ✅ | <code>command_pass kubectl "-n" "prod" "--context" "dev" "deploy/api" {</code><br><code>&nbsp;&nbsp;engine curl</code><br><code>}</code><br><code>command_pass kubectl "pod/api-0" {</code><br><code>&nbsp;&nbsp;engine node</code><br><code>}</code><br><code>command_pass kubectl "pod/api-0"</code> |
| request data never reaches the remote command line or a shell | ✅ | <code>command_pass ssh "-p" "2222" "user@remote.test" {</code><br><code>&nbsp;&nbsp;engine curl</code><br><code>}</code><br><code>command_pass ssh "user@remote.test" {</code><br><code>&nbsp;&nbsp;engine node</code><br><code>}</code><br><code>command_pass ssh "user@remote.test"</code> |
| requests that match no route respond ok | ✅ | <code>route https?://pass.test/ {</code><br><code>&nbsp;&nbsp;proxy_pass "http://127.0.0.1:&lt;port&gt;"</code><br><code>}</code><br><code>route http://fixed.test/ {</code><br><code>&nbsp;&nbsp;proxy_pass "http://127.0.0.1:&lt;port&gt;/fixed"</code><br><code>}</code><br><code>route http://curl.test/ {</code><br><code>&nbsp;&nbsp;command_pass curl "--connect-to" "curl.test:80:127.0.0.1:&lt;port&gt;"</code><br><code>}</code><br><code>route POST http://example.com/ {</code><br><code>&nbsp;&nbsp;respond 201 "created"</code><br><code>}</code><br><code>route https?://example.com/ {</code><br><code>&nbsp;&nbsp;respond 200 "good"</code><br><code>}</code> |
| route can be limited by method | ✅ | <code>route https?://pass.test/ {</code><br><code>&nbsp;&nbsp;proxy_pass "http://127.0.0.1:&lt;port&gt;"</code><br><code>}</code><br><code>route http://fixed.test/ {</code><br><code>&nbsp;&nbsp;proxy_pass "http://127.0.0.1:&lt;port&gt;/fixed"</code><br><code>}</code><br><code>route http://curl.test/ {</code><br><code>&nbsp;&nbsp;command_pass curl "--connect-to" "curl.test:80:127.0.0.1:&lt;port&gt;"</code><br><code>}</code><br><code>route POST http://example.com/ {</code><br><code>&nbsp;&nbsp;respond 201 "created"</code><br><code>}</code><br><code>route https?://example.com/ {</code><br><code>&nbsp;&nbsp;respond 200 "good"</code><br><code>}</code> |
| routes without command_pass log no command | ✅ | <code>log_file "./proxy.ndjson"</code><br><code>&nbsp;&nbsp;respond 200 "plain"</code> |
| runs one process at a time by default | ✅ | <code>command_pass curl</code><br><code>command_pass curl {</code><br><code>&nbsp;&nbsp;concurrency 2</code><br><code>}</code> |
| should accept an http request through an https proxy | ✅ | <code>listen https 127.0.0.1 0 {</code><br><code>&nbsp;&nbsp;ssl {</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;cert "./certs/cert.pem"</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;key "./certs/key.pem"</code><br><code>&nbsp;&nbsp;}</code><br><code>}</code><br><code>&nbsp;&nbsp;respond 200 "secure good"</code><br><code>&nbsp;&nbsp;respond 200 "plain good"</code> |
| should accept namespaces as an alias of namespace | ✅ | <code>namespace prod</code><br><code>namespace staging</code><br><code>namespace the-namespace</code><br><code>namespace the-namespace</code> |
| should accept the IPv4-mapped IPv6 notation ::ffff:127.0.0.1 | ✅ | <code>host "::ffff:127.0.0.1"</code> |
| should accept the IPv6 notation ::0001 | ✅ | <code>host "::0001"</code> |
| should accept the IPv6 notation [::1] | ✅ | <code>host "[::1]"</code> |
| should accept the IPv6 notation 0::1 | ✅ | <code>host "0::1"</code> |
| should accept the IPv6 notation 0:0:0:0:0:0:0:1 | ✅ | <code>host "0:0:0:0:0:0:0:1"</code> |
| should accept the IPv6 notation 0000:0000:0000:0000:0000:0000:0000:0001 | ✅ | <code>host "0000:0000:0000:0000:0000:0000:0000:0001"</code> |
| should add the extra_args to the ssh options, keeping the destination last | ✅ | <code>extra_args "-p" 2222</code> |
| should answer 404 for unknown ui paths | ✅ | <code>log_file "./proxy.ndjson"</code> |
| should call http://httpbin.io/get through kubectl_pass from the pod | ✅ | <code>kubectl_pass "--context" "kind-kind-cluster" "-n" "donly-proxy-test" "pod/echo" {</code><br><code>&nbsp;&nbsp;command_pass curl {</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;retry 3</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;extra_args --retry-all-errors --retry-delay 2</code><br><code>&nbsp;&nbsp;}</code><br><code>}</code> |
| should call https://httpbin.io/get through kubectl_pass from the pod | ✅ | <code>kubectl_pass "--context" "kind-kind-cluster" "-n" "donly-proxy-test" "pod/echo" {</code><br><code>&nbsp;&nbsp;command_pass curl {</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;retry 3</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;extra_args --retry-all-errors --retry-delay 2</code><br><code>&nbsp;&nbsp;}</code><br><code>}</code> |
| should call kubectl exec with --context and --namespace when both are defined | ✅ | <code>context dev</code><br><code>namespace prod</code><br><code>namespace staging</code><br><code>context dev</code><br><code>namespace the-namespace</code><br><code>context the-context</code><br><code>namespace the-namespace</code> |
| should combine max_time with the options given as arguments | ✅ | <code>command_pass curl {</code><br><code>&nbsp;&nbsp;max_time 5</code><br><code>}</code><br><code>command_pass curl "--insecure" {</code><br><code>&nbsp;&nbsp;max_time 2.5</code><br><code>}</code><br><code>command_pass curl</code> |
| should default the host to 127.0.0.1 when the manifest has none | ✅ |  |
| should default the port to 0 when the manifest has none | ✅ |  |
| should fail --ui with a clear error when the manifest has no log_file | ✅ | <code>port 0</code> |
| should fail --ui with a clear error when the ui port is already in use | ✅ | <code>log_file "./proxy.ndjson"</code> |
| should hand the pass of ssh_pass to ssh through an askpass program, never on the command line | ✅ | <code>pass "s3cr3t pa$$"</code> |
| should keep BatchMode and no askpass in ssh_pass without pass | ✅ | <code>ssh_pass myserver {</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>ssh_pass myserver {</code><br><code>&nbsp;&nbsp;port 2222</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>ssh_pass myserver {</code><br><code>&nbsp;&nbsp;user jon</code><br><code>&nbsp;&nbsp;port 2200</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>ssh_pass myserver "-v" {</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>ssh_pass myserver {</code><br><code>&nbsp;&nbsp;user jon</code><br><code>&nbsp;&nbsp;pass "s3cr3t pa$$"</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code> |
| should keep the host declared in the manifest | ✅ | <code>host "0.0.0.0"</code> |
| should keep the options of command_pass kubectl without selectors | ✅ | <code>command_pass kubectl "deploy/api" {</code><br><code>&nbsp;&nbsp;context dev</code><br><code>&nbsp;&nbsp;namespace prod</code><br><code>}</code><br><code>command_pass kubectl "--kubeconfig" "/tmp/kube" "deploy/api" {</code><br><code>&nbsp;&nbsp;namespace staging</code><br><code>&nbsp;&nbsp;engine curl</code><br><code>}</code><br><code>command_pass kubectl "deploy/api" {</code><br><code>&nbsp;&nbsp;extra_args --request-timeout 5s</code><br><code>&nbsp;&nbsp;namespace prod</code><br><code>}</code><br><code>command_pass kubectl "-n" "prod" "deploy/api"</code> |
| should keep the options-then-destination form of ssh_pass | ✅ | <code>ssh_pass "-p" "22" "user@remote.test" {</code><br><code>&nbsp;&nbsp;port 2222</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code> |
| should keep the port declared in the manifest | ✅ | <code>port 3456</code> |
| should keep the target of command_pass kubectl last with extra_args and selectors | ✅ | <code>namespace prod</code><br><code>namespace staging</code><br><code>extra_args --request-timeout 5s</code><br><code>namespace prod</code> |
| should listen on 127.0.0.1 when the manifest has no host | ✅ |  |
| should listen on a random free port when the manifest has none | ✅ |  |
| should listen on the IPv6 host :: | ✅ | <code>host "::"</code> |
| should listen on the IPv6 host ::1 | ✅ | <code>host "::1"</code> |
| should load the proxy block of the manifest | ✅ | <code>proxy {</code><br><code>&nbsp;&nbsp;host "127.0.0.1"</code><br><code>&nbsp;&nbsp;port 3000</code><br><code>}</code> |
| should log a listening line with the host and port when the server starts | ✅ | <code>port 0</code><br><code>log_file "./proxy.ndjson"</code> |
| should log the script sent to node through stdin right after its command | ✅ | <code>log_file "./proxy.ndjson"</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;command_pass node</code> |
| should not let the extra_args values reach a shell | ✅ | <code>extra_args --foo tar --biz lol</code><br><code>extra_args --retry 3</code><br><code>extra_args "--header" "x-evil: a b; touch /tmp/donly-proxy-extra-args-&lt;random&gt;/pwned" "$(touch /tmp/donly-proxy-extra-args-&lt;random&gt;/pwned)"</code> |
| should not pass --context or --namespace without the selectors | ✅ | <code>kubectl_pass "deploy/api" {</code><br><code>&nbsp;&nbsp;context dev</code><br><code>&nbsp;&nbsp;namespace prod</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>kubectl_pass "pod/api-0" {</code><br><code>&nbsp;&nbsp;namespace staging</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>kubectl_pass "--kubeconfig" "/tmp/kube" "deploy/api" {</code><br><code>&nbsp;&nbsp;context dev</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>kubectl_pass "pod/api-0" {</code><br><code>&nbsp;&nbsp;namespaces the-namespace</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>kubectl_pass "pod/api-0" {</code><br><code>&nbsp;&nbsp;namespace the-namespace</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>kubectl_pass "pod/api-0" {</code><br><code>&nbsp;&nbsp;context the-context</code><br><code>&nbsp;&nbsp;namespace the-namespace</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>kubectl_pass "deploy/api" {</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code> |
| should not pass --insecure to curl with insecure false | ✅ | <code>insecure</code><br><code>insecure true</code><br><code>insecure false</code> |
| should not pass --insecure to curl without insecure | ✅ | <code>command_pass curl {</code><br><code>&nbsp;&nbsp;insecure</code><br><code>}</code><br><code>command_pass curl {</code><br><code>&nbsp;&nbsp;insecure true</code><br><code>}</code><br><code>command_pass curl {</code><br><code>&nbsp;&nbsp;insecure false</code><br><code>}</code><br><code>command_pass curl</code> |
| should not pass --max-time to curl without max_time | ✅ | <code>command_pass curl {</code><br><code>&nbsp;&nbsp;max_time 5</code><br><code>}</code><br><code>command_pass curl "--insecure" {</code><br><code>&nbsp;&nbsp;max_time 2.5</code><br><code>}</code><br><code>command_pass curl</code> |
| should not pass --no-warnings to node with no_warnings false | ✅ | <code>no_warnings</code><br><code>no_warnings true</code><br><code>no_warnings false</code><br><code>no_warnings</code> |
| should not pass --no-warnings to node without no_warnings | ✅ | <code>command_pass node {</code><br><code>&nbsp;&nbsp;no_warnings</code><br><code>}</code><br><code>command_pass node {</code><br><code>&nbsp;&nbsp;no_warnings true</code><br><code>}</code><br><code>command_pass node {</code><br><code>&nbsp;&nbsp;no_warnings false</code><br><code>}</code><br><code>command_pass node "--max-old-space-size=64" {</code><br><code>&nbsp;&nbsp;extra_args --no-deprecation</code><br><code>&nbsp;&nbsp;no_warnings</code><br><code>}</code><br><code>command_pass node</code> |
| should not pass --retry to curl without retry | ✅ | <code>command_pass curl {</code><br><code>&nbsp;&nbsp;retry 5</code><br><code>}</code><br><code>command_pass curl {</code><br><code>&nbsp;&nbsp;retry 0</code><br><code>}</code><br><code>command_pass curl</code> |
| should only deliver a log line once it is complete | ✅ | <code>log_file "./proxy.ndjson"</code> |
| should parse the syntax: host directive + port keeps the host | ✅ | <code>host "::1"</code><br><code>port 0</code> |
| should parse the syntax: listen 0 | ✅ | <code>listen 0</code> |
| should parse the syntax: listen 8080 | ✅ | <code>listen 8080</code> |
| should parse the syntax: listen host overrides the host directive | ✅ | <code>host "::1"</code><br><code>listen http 127.0.0.1 0</code> |
| should parse the syntax: listen http ::1 0 | ✅ | <code>listen http ::1 0</code> |
| should parse the syntax: listen http 0 | ✅ | <code>listen http 0</code> |
| should parse the syntax: listen http 127.0.0.1 0 | ✅ | <code>listen http 127.0.0.1 0</code> |
| should parse the syntax: listen https 0 (self-signed) | ✅ | <code>listen https 0</code> |
| should parse the syntax: listen https 0 with ssl | ✅ | <code>listen https 0 {</code><br><code>&nbsp;&nbsp;ssl {</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;cert "./my/c.pem"</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;key "./my/k.pem"</code><br><code>&nbsp;&nbsp;}</code><br><code>}</code> |
| should parse the syntax: listen https 127.0.0.1 0 | ✅ | <code>listen https 127.0.0.1 0</code> |
| should parse the syntax: listen https 127.0.0.1 0 with ssl | ✅ | <code>listen https 127.0.0.1 0 {</code><br><code>&nbsp;&nbsp;ssl {</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;cert "./my/c.pem"</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;key "./my/k.pem"</code><br><code>&nbsp;&nbsp;}</code><br><code>}</code> |
| should parse the syntax: listen https without port | ✅ | <code>listen https</code> |
| should parse the syntax: listen without arguments | ✅ | <code>listen</code> |
| should parse the syntax: port 0 (alias of listen http) | ✅ | <code>port 0</code> |
| should parse the syntax: port 8080 (alias of listen http) | ✅ | <code>port 8080</code> |
| should parse the syntax: port http 0 | ✅ | <code>port http 0</code> |
| should parse the syntax: port https 0 with ssl | ✅ | <code>port https 0 {</code><br><code>&nbsp;&nbsp;ssl {</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;cert "./my/c.pem"</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;key "./my/k.pem"</code><br><code>&nbsp;&nbsp;}</code><br><code>}</code> |
| should pass --context and --namespace to kubectl before the target | ✅ | <code>context dev</code><br><code>namespace prod</code><br><code>namespace staging</code><br><code>context dev</code><br><code>namespace the-namespace</code><br><code>context the-context</code><br><code>namespace the-namespace</code> |
| should pass --context and --namespace to kubectl in command_pass kubectl | ✅ | <code>context dev</code><br><code>namespace prod</code><br><code>namespace staging</code><br><code>namespace prod</code> |
| should pass --insecure to curl when command_pass curl has insecure | ✅ | <code>insecure</code><br><code>insecure true</code><br><code>insecure false</code> |
| should pass --insecure to curl with insecure true | ✅ | <code>insecure</code><br><code>insecure true</code><br><code>insecure false</code> |
| should pass --insecure to the curl run by kubectl_pass | ✅ | <code>insecure</code> |
| should pass --max-time 5 to curl when command_pass curl has max_time 5 | ✅ | <code>max_time 5</code><br><code>max_time 2.5</code> |
| should pass --max-time to the curl run by kubectl_pass | ✅ | <code>max_time 5</code> |
| should pass --no-warnings to node when command_pass node has no_warnings | ✅ | <code>no_warnings</code><br><code>no_warnings true</code><br><code>no_warnings false</code><br><code>no_warnings</code> |
| should pass --no-warnings to node with no_warnings true | ✅ | <code>no_warnings</code><br><code>no_warnings true</code><br><code>no_warnings false</code><br><code>no_warnings</code> |
| should pass --no-warnings to the node run by kubectl_pass | ✅ | <code>no_warnings</code> |
| should pass --no-warnings to the node run by ssh_pass | ✅ | <code>no_warnings</code> |
| should pass --retry 0 to curl with retry 0 | ✅ | <code>retry 5</code><br><code>retry 0</code> |
| should pass --retry 5 to curl when command_pass curl has retry 5 | ✅ | <code>retry 5</code><br><code>retry 0</code> |
| should pass --retry to the curl run by kubectl_pass | ✅ | <code>retry 5</code> |
| should pass only --namespace when kubectl_pass has no context | ✅ | <code>namespace prod</code><br><code>namespace staging</code><br><code>namespace the-namespace</code><br><code>namespace the-namespace</code> |
| should pass the extra_args to the curl run by kubectl_pass | ✅ | <code>extra_args --foo tar</code> |
| should pass the extra_args values to curl as separate arguments | ✅ | <code>extra_args --foo tar --biz lol</code><br><code>extra_args --retry 3</code><br><code>extra_args "--header" "x-evil: a b; touch /tmp/donly-proxy-extra-args-&lt;random&gt;/pwned" "$(touch /tmp/donly-proxy-extra-args-&lt;random&gt;/pwned)"</code> |
| should pass the port subdirective of ssh_pass as -p | ✅ | <code>port 2222</code><br><code>port 2200</code> |
| should pass the user subdirective of ssh_pass as -l | ✅ | <code>port 2222</code><br><code>user jon</code><br><code>port 2200</code><br><code>user jon</code> |
| should proxy_pass through an https proxy | ✅ | <code>listen https 127.0.0.1 0 {</code><br><code>&nbsp;&nbsp;ssl {</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;cert "./certs/cert.pem"</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;key "./certs/key.pem"</code><br><code>&nbsp;&nbsp;}</code><br><code>}</code><br><code>&nbsp;&nbsp;proxy_pass http://127.0.0.1:&lt;port&gt;/</code> |
| should put no_warnings after the arguments of the line and the extra_args | ✅ | <code>command_pass node {</code><br><code>&nbsp;&nbsp;no_warnings</code><br><code>}</code><br><code>command_pass node {</code><br><code>&nbsp;&nbsp;no_warnings true</code><br><code>}</code><br><code>command_pass node {</code><br><code>&nbsp;&nbsp;no_warnings false</code><br><code>}</code><br><code>command_pass node "--max-old-space-size=64" {</code><br><code>&nbsp;&nbsp;extra_args --no-deprecation</code><br><code>&nbsp;&nbsp;no_warnings</code><br><code>}</code><br><code>command_pass node</code> |
| should put the arguments after the host of ssh_pass before the host as ssh options | ✅ | <code>ssh_pass myserver {</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>ssh_pass myserver {</code><br><code>&nbsp;&nbsp;port 2222</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>ssh_pass myserver {</code><br><code>&nbsp;&nbsp;user jon</code><br><code>&nbsp;&nbsp;port 2200</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>ssh_pass myserver "-v" {</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>ssh_pass myserver {</code><br><code>&nbsp;&nbsp;user jon</code><br><code>&nbsp;&nbsp;pass "s3cr3t pa$$"</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code> |
| should put the extra_args after the arguments of the line and before max_time | ✅ | <code>command_pass curl {</code><br><code>&nbsp;&nbsp;extra_args --foo tar --biz lol</code><br><code>}</code><br><code>command_pass curl "--insecure" {</code><br><code>&nbsp;&nbsp;extra_args --retry 3</code><br><code>&nbsp;&nbsp;max_time 5</code><br><code>}</code><br><code>command_pass curl {</code><br><code>&nbsp;&nbsp;extra_args "--header" "x-evil: a b; touch /tmp/donly-proxy-extra-args-&lt;random&gt;/pwned" "$(touch /tmp/donly-proxy-extra-args-&lt;random&gt;/pwned)"</code><br><code>}</code> |
| should put the selectors after the options given as arguments | ✅ | <code>kubectl_pass "deploy/api" {</code><br><code>&nbsp;&nbsp;context dev</code><br><code>&nbsp;&nbsp;namespace prod</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>kubectl_pass "pod/api-0" {</code><br><code>&nbsp;&nbsp;namespace staging</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>kubectl_pass "--kubeconfig" "/tmp/kube" "deploy/api" {</code><br><code>&nbsp;&nbsp;context dev</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>kubectl_pass "pod/api-0" {</code><br><code>&nbsp;&nbsp;namespaces the-namespace</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>kubectl_pass "pod/api-0" {</code><br><code>&nbsp;&nbsp;namespace the-namespace</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>kubectl_pass "pod/api-0" {</code><br><code>&nbsp;&nbsp;context the-context</code><br><code>&nbsp;&nbsp;namespace the-namespace</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>kubectl_pass "deploy/api" {</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code> |
| should put the selectors of command_pass kubectl after the options given as arguments | ✅ | <code>namespace prod</code><br><code>namespace staging</code><br><code>namespace prod</code> |
| should read the concurrency and the options of the nested command_pass in ssh_pass | ✅ | <code>command_pass curl {</code><br><code>&nbsp;&nbsp;concurrency 3</code><br><code>&nbsp;&nbsp;max_time 5</code><br><code>&nbsp;&nbsp;extra_args --foo tar</code><br><code>}</code> |
| should read the port from the manifest | ✅ | <code>port 3000</code> |
| should refuse a plain http connection to an https proxy | ✅ | <code>listen https 127.0.0.1 0 {</code><br><code>&nbsp;&nbsp;ssl {</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;cert "./certs/cert.pem"</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;key "./certs/key.pem"</code><br><code>&nbsp;&nbsp;}</code><br><code>}</code> |
| should reject a context of command_pass kubectl that is not a name | ✅ | <code>context ""</code> |
| should reject a context that is not a name | ✅ | <code>context 5</code> |
| should reject a listen with too many arguments | ✅ | <code>listen http a b 0</code> |
| should reject a listen without a numeric port | ✅ | <code>listen https 127.0.0.1</code> |
| should reject a max_time that is not a positive number | ✅ | <code>max_time 0</code> |
| should reject a namespace of command_pass kubectl that is not a name | ✅ | <code>namespace 5</code> |
| should reject a namespace that is not a name | ✅ | <code>namespace 5</code> |
| should reject a nested command_pass that is not curl, wget or node | ✅ | <code>ssh_pass "user@remote.test" {</code><br><code>&nbsp;&nbsp;command_pass ssh</code><br><code>}</code> |
| should reject a no_warnings that is not true or false | ✅ | <code>no_warnings maybe</code> |
| should reject a pass that is empty or not a text | ✅ | <code>pass ""</code> |
| should reject a port that is not between 1 and 65535 | ✅ | <code>port 0</code> |
| should reject a retry that is not a non-negative integer | ✅ | <code>retry -1</code> |
| should reject a route that combines ssh_pass with another action | ✅ | <code>route / {</code><br><code>&nbsp;&nbsp;respond 200 "x"</code><br><code>&nbsp;&nbsp;ssh_pass "user@remote.test" {</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;command_pass curl</code><br><code>&nbsp;&nbsp;}</code><br><code>}</code> |
| should reject a user that is not a name | ✅ | <code>user ""</code> |
| should reject an insecure that is not true or false | ✅ | <code>insecure maybe</code> |
| should reject context and namespace outside kubectl | ✅ | <code>namespace prod</code> |
| should reject insecure outside command_pass curl | ✅ | <code>insecure</code> |
| should reject listen and port declared together | ✅ | <code>listen 0</code><br><code>port 0</code> |
| should reject max_time outside command_pass curl | ✅ | <code>max_time 5</code> |
| should reject no_warnings outside command_pass node | ✅ | <code>no_warnings</code> |
| should reject retry outside command_pass curl | ✅ | <code>retry 5</code> |
| should reject ssh_pass without a destination | ✅ | <code>ssh_pass {</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code> |
| should reject ssh_pass without a nested command_pass | ✅ | <code>ssh_pass "user@remote.test"</code> |
| should replay only the last lines of a long log and survive a truncation | ✅ | <code>log_file "./proxy.ndjson"</code> |
| should run the request over ssh with the curl of the nested command_pass | ✅ | <code>ssh_pass "-p" "2222" "user@remote.test" {</code><br><code>&nbsp;&nbsp;command_pass curl "--max-time" "5"</code><br><code>}</code> |
| should send the namespace to kubectl exec when namespace is defined | ✅ | <code>namespace prod</code><br><code>namespace staging</code><br><code>namespace the-namespace</code><br><code>namespace the-namespace</code> |
| should serve http on the IPv6 loopback with listen http ::1 0 | ✅ | <code>listen http ::1 0</code> |
| should serve https on the IPv6 loopback with listen https ::1 0 | ✅ | <code>listen https ::1 0</code> |
| should serve https with a self-signed certificate generated next to the manifest | ✅ | <code>listen https 127.0.0.1 0</code> |
| should serve the log viewer page on the ui port | ✅ | <code>log_file "./proxy.ndjson"</code> |
| should stream the existing log lines and then the new ones as server-sent events | ✅ | <code>log_file "./proxy.ndjson"</code> |
| should tunnel an https request through an https proxy | ✅ | <code>listen https 127.0.0.1 0 {</code><br><code>&nbsp;&nbsp;ssl {</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;cert "./certs/cert.pem"</code><br><code>&nbsp;&nbsp;&nbsp;&nbsp;key "./certs/key.pem"</code><br><code>&nbsp;&nbsp;}</code><br><code>}</code><br><code>&nbsp;&nbsp;respond 200 "secure good"</code><br><code>&nbsp;&nbsp;respond 200 "plain good"</code> |
| should use the curl engine of the nested command_pass in ssh_pass | ✅ | <code>command_pass curl</code> |
| should use the first argument of ssh_pass as the host, so ~/.ssh/config applies | ✅ | <code>ssh_pass myserver {</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>ssh_pass myserver {</code><br><code>&nbsp;&nbsp;port 2222</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>ssh_pass myserver {</code><br><code>&nbsp;&nbsp;user jon</code><br><code>&nbsp;&nbsp;port 2200</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>ssh_pass myserver "-v" {</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code><br><code>ssh_pass myserver {</code><br><code>&nbsp;&nbsp;user jon</code><br><code>&nbsp;&nbsp;pass "s3cr3t pa$$"</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code> |
| should use the node engine of the nested command_pass in ssh_pass | ✅ | <code>command_pass node</code> |
| should use the wget engine of the nested command_pass in ssh_pass | ✅ | <code>command_pass wget</code> |
| ssh failures are reported as a bad gateway | ✅ | <code>command_pass ssh "-p" "2222" "user@remote.test" {</code><br><code>&nbsp;&nbsp;engine curl</code><br><code>}</code><br><code>command_pass ssh "user@remote.test" {</code><br><code>&nbsp;&nbsp;engine node</code><br><code>}</code><br><code>command_pass ssh "user@remote.test"</code> |
| the status and headers are read from the last response printed by -S | ✅ | <code>engine wget</code> |
| waiting requests are served in arrival order | ✅ | <code>command_pass curl</code><br><code>command_pass curl {</code><br><code>&nbsp;&nbsp;concurrency 2</code><br><code>}</code> |
| wget answers GET requests and reports the status of failed ones | ✅ | <code>kubectl_pass "--context" "kind-kind-cluster" "-n" "donly-proxy-test" "pod/echo" {</code><br><code>&nbsp;&nbsp;command_pass wget</code><br><code>}</code> |
| without a status line the failure is reported | ✅ | <code>engine wget</code> |
