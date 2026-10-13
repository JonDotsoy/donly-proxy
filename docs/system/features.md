# Features

Tabla de las features del proxy, si están **soportadas** y si están **probadas**.

- Las columnas **Feature**, **Descripción** y **Soportada** se escriben a mano.
- Las columnas **Probada** y **Tests** las genera `bun run features` a partir de los títulos de
  los tests; no las edites.
- Un test pertenece a una feature cuando su título lleva el id de la feature entre corchetes,
  por ejemplo `test("[proxy_pass.https] proxy_pass works through an https tunnel", …)`. Un título
  puede llevar varios ids. El script falla si un test no lleva ningún id, si el id no está en la
  tabla o si algún test falla.
- **Probada**: ✅ hay al menos un test y todos pasan · 🔴 algún test de la feature falla · ❌ no hay
  tests.

Para declarar una feature nueva a partir de un ejemplo de manifest y de lo esperado, usa el skill
`/new-feature` (`.claude/skills/new-feature/SKILL.md`). Para agregarla a mano: añade una fila `| \`id\` | descripción | ✅ | | |` y ejecuta
`bun run features`. `bun run features:check` (usado en CI) falla si el archivo está desactualizado.

<!-- features:summary -->
Soportadas: **52** · Soportadas y probadas: **38** · Sin pruebas: **14**
<!-- /features:summary -->

| Feature | Descripción | Soportada | Probada | Tests |
| --- | --- | --- | --- | --- |
| `http.proxy` | Proxy HTTP: peticiones con URL absoluta | ✅ | ✅ | fetch through the proxy goes through it and is logged<br>GET http://example.com through the proxy is answered by the route |
| `https.tunnel` | Proxy HTTPS: túnel `CONNECT` con el TLS terminado en el proxy | ✅ | 🔴 | 🔴 GET https://example.com through the proxy is answered by the route |
| `http2` | HTTP/2 y HTTP/3 | ❌ | ❌ |  |
| `manifest.load` | Configuración con `manifest.donly` (`host`, `port`) | ✅ | ✅ | manifest.donly configures the proxy |
| `manifest.relative-paths` | Rutas de `log_file` y `ssl` relativas a la carpeta del manifest | ✅ | ✅ | log_file and ssl are resolved relative to the manifest, not the cwd |
| `ssl.autogen` | Certificado autofirmado generado con `openssl` si no existe | ✅ | ✅ | log_file and ssl are resolved relative to the manifest, not the cwd |
| `route.regex` | `route` con patrón regex sobre la URL completa | ✅ | 🔴 | GET http://example.com through the proxy is answered by the route<br>🔴 GET https://example.com through the proxy is answered by the route |
| `route.method` | `route` limitada a un método HTTP | ✅ | ✅ | route can be limited by method |
| `route.first-match-wins` | Gana la primera `route` que coincide | ✅ | ❌ |  |
| `route.no-match-ok` | Sin ruta que coincida responde `200 ok` | ✅ | ✅ | requests that match no route respond ok |
| `route.catch-all` | `route { … }` sin argumentos coincide con todas las peticiones (HTTP y HTTPS, cualquier método) | ✅ | 🔴 | 🔴 a route without arguments matches every request<br>its pattern is a real wildcard, not the text 'undefined' |
| `route.catch-all.order` | Las rutas declaradas antes tienen prioridad; la ruta sin argumentos recoge el resto | ✅ | ✅ | earlier routes win and the catch-all takes the rest |
| `route.respond` | `respond <estado> "<cuerpo>"` | ✅ | 🔴 | GET http://example.com through the proxy is answered by the route<br>🔴 GET https://example.com through the proxy is answered by the route |
| `route.validation.single-action` | Cada `route` exige exactamente una acción (`respond`, `proxy_pass`, `command_pass` o `kubectl_pass`) | ✅ | ❌ |  |
| `proxy_pass` | Reenvía método, ruta, query, cabeceras y cuerpo a otro servidor | ✅ | ✅ | proxy_pass forwards method, path, query and body to the target |
| `proxy_pass.https` | `proxy_pass` sobre tráfico HTTPS (túnel) | ✅ | 🔴 | 🔴 proxy_pass works through an https tunnel |
| `proxy_pass.target-path` | La ruta del destino reemplaza a la original | ✅ | ✅ | proxy_pass with a target path replaces the path |
| `proxy_pass.error` | `502 bad gateway` si el destino falla | ✅ | ❌ |  |
| `proxy_pass.redirects` | Seguir las redirecciones del destino | ❌ | ❌ |  |
| `command_pass.curl` | `command_pass curl`: la petición pasa por el comando `curl` | ✅ | ✅ | command_pass curl runs the curl found in PATH<br>command_pass curl hands the request to curl |
| `command_pass.curl.head` | `curl` con peticiones `HEAD` (`--head`) | ✅ | ❌ |  |
| `command_pass.curl.error` | `502 bad gateway` si `curl` falla | ✅ | ✅ | command_pass curl reports a bad gateway when curl fails |
| `command_pass.node` | `command_pass node`: proceso `node` con `http.request` | ✅ | ✅ | command_pass node performs the request with http.request |
| `command_pass.node.https` | `command_pass node` con `https.request` | ✅ | 🔴 | 🔴 command_pass node performs https requests with https.request |
| `command_pass.node.compressed` | `node` descomprime respuestas `gzip` / `deflate` / `br` | ✅ | ❌ |  |
| `command_pass.node.error` | `502 bad gateway` si `node` falla | ✅ | ✅ | command_pass node reports a bad gateway when the request fails |
| `command_pass.ssh.curl` | `command_pass ssh` con `engine curl` | ✅ | ✅ | command_pass ssh with engine curl runs the request on the remote host |
| `command_pass.ssh.node` | `command_pass ssh` con `engine node` | ✅ | ✅ | command_pass ssh with engine node runs the request on the remote host |
| `command_pass.wget` | `engine wget` en `ssh` y `kubectl` (solo GET y POST; el cuerpo y las cabeceras no pasan por el shell) | ✅ | ✅ | a GET becomes a fixed wget command line with quoted values<br>a body becomes a POST sent from a temporary file<br>request data cannot break out of the shell quoting<br>methods other than GET and POST are refused<br>the status and headers are read from the last response printed by -S<br>a 4xx response keeps its status even though wget exits with an error<br>without a status line the failure is reported |
| `command_pass.ssh.default-engine` | `ssh` usa `curl` si no hay `engine` | ✅ | ✅ | command_pass ssh uses curl when no engine is given |
| `command_pass.ssh.no-shell-injection` | Los datos de la petición no llegan al shell remoto de `ssh` | ✅ | ✅ | request data never reaches the remote command line or a shell |
| `command_pass.ssh.error` | `502 bad gateway` si `ssh` falla | ✅ | ✅ | ssh failures are reported as a bad gateway |
| `command_pass.ssh.validation` | Validación del manifest para `ssh` y `engine` | ✅ | ✅ | manifest validation for ssh and engine |
| `command_pass.ssh.password` | Autenticación por contraseña en `ssh` (solo llaves o agente) | ❌ | ❌ |  |
| `command_pass.kubectl.curl` | `command_pass kubectl` con `engine curl` | ✅ | ✅ | command_pass kubectl with engine curl runs the request inside the pod |
| `command_pass.kubectl.node` | `command_pass kubectl` con `engine node` | ✅ | ✅ | command_pass kubectl with engine node runs the request inside the pod |
| `command_pass.kubectl.default-engine` | `kubectl` usa `curl` si no hay `engine` | ✅ | ✅ | command_pass kubectl uses curl when no engine is given |
| `command_pass.kubectl.no-shell-injection` | Los datos de la petición no llegan al shell del contenedor | ✅ | ✅ | request data never reaches the command line or a shell |
| `command_pass.kubectl.error` | `502 bad gateway` si `kubectl` falla | ✅ | ✅ | kubectl failures are reported as a bad gateway |
| `command_pass.kubectl.kind` | `command_pass kubectl` contra un Service echo desplegado con podman en el cluster `kind-kind-cluster` (se omite si no existe) | ✅ | ✅ | command_pass kubectl with engine curl reaches an echo Service in the kind-kind-cluster<br>command_pass kubectl with engine wget reaches an echo Service in the kind-kind-cluster<br>command_pass kubectl with engine node reaches an echo Service in the kind-kind-cluster<br>wget answers GET requests and reports the status of failed ones |
| `kubectl_pass` | `kubectl_pass <opciones> <destino> { command_pass curl\|wget\|node [opciones] }`: ejecuta la petición dentro del pod con el comando anidado | ✅ | ✅ | kubectl_pass with a nested command_pass curl runs the request inside the pod with the curl options |
| `kubectl_pass.validation` | Validación del manifest para `kubectl_pass` (destino, `command_pass` hijo, `concurrency`) | ✅ | ✅ | manifest validation for kubectl_pass |
| `command_pass.kubectl.validation` | Validación del manifest para `kubectl` y `engine` | ✅ | ✅ | manifest validation for kubectl |
| `command_pass.concurrency.default` | `command_pass` ejecuta un proceso a la vez por defecto; las demás peticiones esperan en cola | ✅ | ✅ | runs one process at a time by default |
| `command_pass.concurrency.limit` | `concurrency <n>` permite hasta `n` procesos en paralelo por ruta | ✅ | 🔴 | 🔴 concurrency <n> allows n processes in parallel<br>each route has its own limit<br>loadConfig reads concurrency, defaulting to 1 |
| `command_pass.concurrency.queue` | Las peticiones en espera se atienden en orden de llegada y un fallo libera el lugar | ✅ | ✅ | waiting requests are served in arrival order<br>a failing process frees its place for the next request |
| `command_pass.concurrency.validation` | `concurrency` debe ser un entero positivo | ✅ | ✅ | concurrency must be a positive integer |
| `log_file.command` | La línea `response` de un `command_pass` registra el comando ejecutado (`curl`, `node`, `ssh` o `kubectl`) con todos sus argumentos | ✅ | ✅ | logs the curl command that was executed<br>logs the node command that was executed<br>logs the ssh command that was executed, including the remote command<br>logs the kubectl command that was executed |
| `log_file.command.only-command-pass` | Las rutas sin `command_pass` no registran `command` | ✅ | ✅ | routes without command_pass log no command |
| `command_pass.validation` | `command_pass` rechaza comandos desconocidos | ✅ | ✅ | command_pass only supports known commands |
| `log_file.transactions` | Una línea `request` y otra `response` por transacción, con `transaction_id` compartido | ✅ | ✅ | fetch through the proxy goes through it and is logged<br>log_file records request and response sharing a transaction id |
| `log_file.ndjson-only` | `log_file` solo admite la extensión `.ndjson` | ✅ | ✅ | log_file only supports .ndjson |
| `log_file.snapshot` | Formato exacto del log (snapshot) | ✅ | 🔴 | 🔴 log_file snapshot |
| `log_file.no-proxy-no-log` | Las peticiones que no pasan por el proxy no escriben log | ✅ | ✅ | fetch without proxy reaches the local server and writes no log<br>a later fetch without proxy still adds nothing to the log |
| `log_file.payload-base64` | Cuerpos que no son UTF-8 se guardan en base64 | ✅ | ❌ |  |
