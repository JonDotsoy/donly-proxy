# Features

Generado por `bun run features` a partir de `spec_tests.json` (las specs que registra
`testFeature`, ver `src/utils/test_utils/test-feature`). No lo edites a mano.

Cada fila es un test: **Directivas** son las del manifest que el test ejercita.

Specs: **71** · ✅ pasan: **65** · 🔴 fallan: **1** · ⏳ sin resultado: **5** · ⏭️ omitidas: **0**

| Feature | Estado | Directivas |
| --- | --- | --- |
| a 4xx response keeps its status even though wget exits with an error | ✅ | <code>engine wget</code> |
| a body becomes a POST sent from a temporary file | ✅ | <code>engine wget</code> |
| a failing process frees its place for the next request | ✅ | <code>command_pass curl</code><br><code>command_pass curl {</code><br><code>&nbsp;&nbsp;concurrency 2</code><br><code>}</code> |
| a GET becomes a fixed wget command line with quoted values | ✅ | <code>engine wget</code> |
| a later fetch without proxy still adds nothing to the log | ✅ | <code>log_file "./proxy.ndjson"</code> |
| a route without arguments matches every request | ⏳ | <code>route {</code><br><code>&nbsp;&nbsp;respond 202 "catch-all"</code><br><code>}</code> |
| command_pass curl hands the request to curl | ✅ | <code>command_pass curl "--connect-to" "curl.test:80:127.0.0.1:&lt;port&gt;"</code> |
| command_pass curl reports a bad gateway when curl fails | ✅ | <code>command_pass curl "--connect-to" "dead.test:80:127.0.0.1:&lt;port&gt;"</code> |
| command_pass curl runs the curl found in PATH | ✅ | <code>command_pass curl "--max-time" "5"</code> |
| command_pass kubectl uses curl when no engine is given | ✅ | <code>command_pass kubectl "-n" "prod" "--context" "dev" "deploy/api" {</code><br><code>&nbsp;&nbsp;engine curl</code><br><code>}</code><br><code>command_pass kubectl "pod/api-0" {</code><br><code>&nbsp;&nbsp;engine node</code><br><code>}</code><br><code>command_pass kubectl "pod/api-0"</code> |
| command_pass kubectl with engine curl reaches an echo Service in the kind-kind-cluster | ✅ | <code>kubectl_pass "--context" "kind-kind-cluster" "-n" "donly-proxy-test" "pod/echo" {</code><br><code>&nbsp;&nbsp;command_pass curl</code><br><code>}</code> |
| command_pass kubectl with engine curl runs the request inside the pod | ✅ | <code>engine curl</code><br><code>engine node</code> |
| command_pass kubectl with engine node reaches an echo Service in the kind-kind-cluster | ✅ |  |
| command_pass kubectl with engine node runs the request inside the pod | ✅ | <code>engine curl</code><br><code>engine node</code> |
| command_pass kubectl with engine wget reaches an echo Service in the kind-kind-cluster | ✅ | <code>kubectl_pass "--context" "kind-kind-cluster" "-n" "donly-proxy-test" "pod/echo" {</code><br><code>&nbsp;&nbsp;command_pass wget</code><br><code>}</code> |
| command_pass node performs https requests with https.request | ⏳ | <code>command_pass node "--no-warnings"</code><br><code>command_pass node "--no-warnings"</code> |
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
| fetch through the proxy goes through it and is logged | ✅ | <code>log_file "./proxy.ndjson"</code> |
| fetch without proxy reaches the local server and writes no log | ✅ | <code>log_file "./proxy.ndjson"</code> |
| GET http://example.com through the proxy is answered by the route | ✅ | <code>respond 201 "created"</code><br><code>respond 200 "good"</code> |
| GET https://example.com through the proxy is answered by the route | ⏳ | <code>ssl {</code><br><code>&nbsp;&nbsp;cert "./certs/cert.pem"</code><br><code>&nbsp;&nbsp;key "./certs/key.pem"</code><br><code>}</code><br><code>&nbsp;&nbsp;respond 201 "created"</code><br><code>&nbsp;&nbsp;respond 200 "good"</code> |
| its pattern is a real wildcard, not the text 'undefined' | ✅ | <code>route {</code><br><code>&nbsp;&nbsp;respond 202 "catch-all"</code><br><code>}</code> |
| kubectl failures are reported as a bad gateway | ✅ | <code>command_pass kubectl "-n" "prod" "--context" "dev" "deploy/api" {</code><br><code>&nbsp;&nbsp;engine curl</code><br><code>}</code><br><code>command_pass kubectl "pod/api-0" {</code><br><code>&nbsp;&nbsp;engine node</code><br><code>}</code><br><code>command_pass kubectl "pod/api-0"</code> |
| kubectl_pass with a nested command_pass curl runs the request inside the pod with the curl options | ✅ | <code>kubectl_pass "-n" "prod" "deploy/api" {</code><br><code>&nbsp;&nbsp;command_pass curl "--max-time" "5"</code><br><code>}</code> |
| loadConfig reads concurrency, defaulting to 1 | ✅ | <code>concurrency 2</code> |
| log_file and ssl are resolved relative to the manifest, not the cwd | ✅ | <code>log_file "../out/rel.ndjson"</code><br><code>ssl {</code><br><code>&nbsp;&nbsp;cert "../ssl/cert.pem"</code><br><code>&nbsp;&nbsp;key "../ssl/key.pem"</code><br><code>}</code> |
| log_file only supports .ndjson | ✅ | <code>log_file "./proxy.log"</code> |
| log_file records request and response sharing a transaction id | ✅ | <code>log_file "./logs/proxy.ndjson"</code> |
| log_file snapshot | ⏳ | <code>log_file "./snap.ndjson"</code> |
| logs the curl command that was executed | ✅ | <code>log_file "./proxy.ndjson"</code><br><code>&nbsp;&nbsp;command_pass curl "--max-time" "5"</code><br><code>&nbsp;&nbsp;command_pass node "--no-warnings"</code><br><code>&nbsp;&nbsp;command_pass ssh "-p" "2222" "user@remote.test"</code><br><code>&nbsp;&nbsp;command_pass kubectl "-n" "prod" "deploy/api"</code> |
| logs the kubectl command that was executed | ✅ | <code>log_file "./proxy.ndjson"</code><br><code>&nbsp;&nbsp;command_pass curl "--max-time" "5"</code><br><code>&nbsp;&nbsp;command_pass node "--no-warnings"</code><br><code>&nbsp;&nbsp;command_pass ssh "-p" "2222" "user@remote.test"</code><br><code>&nbsp;&nbsp;command_pass kubectl "-n" "prod" "deploy/api"</code> |
| logs the node command that was executed | ✅ | <code>log_file "./proxy.ndjson"</code><br><code>&nbsp;&nbsp;command_pass curl "--max-time" "5"</code><br><code>&nbsp;&nbsp;command_pass node "--no-warnings"</code><br><code>&nbsp;&nbsp;command_pass ssh "-p" "2222" "user@remote.test"</code><br><code>&nbsp;&nbsp;command_pass kubectl "-n" "prod" "deploy/api"</code> |
| logs the ssh command that was executed, including the remote command | ✅ | <code>log_file "./proxy.ndjson"</code><br><code>&nbsp;&nbsp;command_pass curl "--max-time" "5"</code><br><code>&nbsp;&nbsp;command_pass node "--no-warnings"</code><br><code>&nbsp;&nbsp;command_pass ssh "-p" "2222" "user@remote.test"</code><br><code>&nbsp;&nbsp;command_pass kubectl "-n" "prod" "deploy/api"</code> |
| manifest validation for kubectl | ✅ | <code>command_pass kubectl</code> |
| manifest validation for kubectl_pass | ✅ | <code>kubectl_pass {</code><br><code>command_pass curl</code><br><code>}</code> |
| manifest validation for ssh and engine | ✅ | <code>command_pass ssh</code> |
| manifest.donly configures the proxy | ✅ | <code>host "127.0.0.1"</code><br><code>port 0</code><br><code>ssl {</code><br><code>&nbsp;&nbsp;cert "./certs/cert.pem"</code><br><code>&nbsp;&nbsp;key "./certs/key.pem"</code><br><code>}</code> |
| methods other than GET and POST are refused | ✅ | <code>engine wget</code> |
| proxy_pass forwards method, path, query and body to the target | ✅ | <code>proxy_pass "http://127.0.0.1:&lt;port&gt;"</code><br><code>proxy_pass "http://127.0.0.1:&lt;port&gt;/fixed"</code> |
| proxy_pass with a target path replaces the path | ✅ | <code>proxy_pass "http://127.0.0.1:&lt;port&gt;"</code><br><code>proxy_pass "http://127.0.0.1:&lt;port&gt;/fixed"</code> |
| proxy_pass works through an https tunnel | ⏳ | <code>proxy_pass "http://127.0.0.1:&lt;port&gt;"</code><br><code>proxy_pass "http://127.0.0.1:&lt;port&gt;/fixed"</code> |
| request data cannot break out of the shell quoting | ✅ | <code>engine wget</code> |
| request data never reaches the command line or a shell | ✅ | <code>command_pass kubectl "-n" "prod" "--context" "dev" "deploy/api" {</code><br><code>&nbsp;&nbsp;engine curl</code><br><code>}</code><br><code>command_pass kubectl "pod/api-0" {</code><br><code>&nbsp;&nbsp;engine node</code><br><code>}</code><br><code>command_pass kubectl "pod/api-0"</code> |
| request data never reaches the remote command line or a shell | ✅ | <code>command_pass ssh "-p" "2222" "user@remote.test" {</code><br><code>&nbsp;&nbsp;engine curl</code><br><code>}</code><br><code>command_pass ssh "user@remote.test" {</code><br><code>&nbsp;&nbsp;engine node</code><br><code>}</code><br><code>command_pass ssh "user@remote.test"</code> |
| requests that match no route respond ok | ✅ | <code>route https?://pass.test/ {</code><br><code>&nbsp;&nbsp;proxy_pass "http://127.0.0.1:&lt;port&gt;"</code><br><code>}</code><br><code>route http://fixed.test/ {</code><br><code>&nbsp;&nbsp;proxy_pass "http://127.0.0.1:&lt;port&gt;/fixed"</code><br><code>}</code><br><code>route http://curl.test/ {</code><br><code>&nbsp;&nbsp;command_pass curl "--connect-to" "curl.test:80:127.0.0.1:&lt;port&gt;"</code><br><code>}</code><br><code>route POST http://example.com/ {</code><br><code>&nbsp;&nbsp;respond 201 "created"</code><br><code>}</code><br><code>route https?://example.com/ {</code><br><code>&nbsp;&nbsp;respond 200 "good"</code><br><code>}</code> |
| route can be limited by method | ✅ | <code>route https?://pass.test/ {</code><br><code>&nbsp;&nbsp;proxy_pass "http://127.0.0.1:&lt;port&gt;"</code><br><code>}</code><br><code>route http://fixed.test/ {</code><br><code>&nbsp;&nbsp;proxy_pass "http://127.0.0.1:&lt;port&gt;/fixed"</code><br><code>}</code><br><code>route http://curl.test/ {</code><br><code>&nbsp;&nbsp;command_pass curl "--connect-to" "curl.test:80:127.0.0.1:&lt;port&gt;"</code><br><code>}</code><br><code>route POST http://example.com/ {</code><br><code>&nbsp;&nbsp;respond 201 "created"</code><br><code>}</code><br><code>route https?://example.com/ {</code><br><code>&nbsp;&nbsp;respond 200 "good"</code><br><code>}</code> |
| routes without command_pass log no command | ✅ | <code>log_file "./proxy.ndjson"</code><br><code>&nbsp;&nbsp;respond 200 "plain"</code> |
| runs one process at a time by default | ✅ | <code>command_pass curl</code><br><code>command_pass curl {</code><br><code>&nbsp;&nbsp;concurrency 2</code><br><code>}</code> |
| should default the host to 127.0.0.1 when the manifest has none | ✅ |  |
| should default the port to 0 when the manifest has none | ✅ |  |
| should keep the host declared in the manifest | ✅ | <code>host "0.0.0.0"</code> |
| should keep the port declared in the manifest | ✅ | <code>port 3456</code> |
| should listen on 127.0.0.1 when the manifest has no host | ✅ |  |
| should listen on a random free port when the manifest has none | ✅ |  |
| should load the proxy block of the manifest | ✅ | <code>proxy {</code><br><code>&nbsp;&nbsp;host "127.0.0.1"</code><br><code>&nbsp;&nbsp;port 3000</code><br><code>}</code> |
| should read the port from the manifest | 🔴 | <code>port 3000</code> |
| should read the port from the manifest | ✅ | <code>port 3000</code> |
| ssh failures are reported as a bad gateway | ✅ | <code>command_pass ssh "-p" "2222" "user@remote.test" {</code><br><code>&nbsp;&nbsp;engine curl</code><br><code>}</code><br><code>command_pass ssh "user@remote.test" {</code><br><code>&nbsp;&nbsp;engine node</code><br><code>}</code><br><code>command_pass ssh "user@remote.test"</code> |
| the status and headers are read from the last response printed by -S | ✅ | <code>engine wget</code> |
| waiting requests are served in arrival order | ✅ | <code>command_pass curl</code><br><code>command_pass curl {</code><br><code>&nbsp;&nbsp;concurrency 2</code><br><code>}</code> |
| wget answers GET requests and reports the status of failed ones | ✅ | <code>kubectl_pass "--context" "kind-kind-cluster" "-n" "donly-proxy-test" "pod/echo" {</code><br><code>&nbsp;&nbsp;command_pass wget</code><br><code>}</code> |
| without a status line the failure is reported | ✅ | <code>engine wget</code> |
