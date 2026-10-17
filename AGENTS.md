# AGENTS.md

Guía para agentes que trabajan en **donly-proxy**: un proxy HTTP/HTTPS configurable con un
manifiesto [DON](https://don.jon.soy/) (`manifest.donly`). Corre sobre [Bun](https://bun.sh)
(TypeScript, ESM). Responde en español en commits, PRs y docs, igual que el resto del repo.

## Estructura del proyecto

| Ruta | Qué hay |
| --- | --- |
| `src/cli/main.ts` | Punto de entrada: `bun start [manifest.donly]`. |
| `src/proxy/server.ts` | `loadConfig` (lee y valida el manifest) y `createProxyServer` (HTTP, `CONNECT`/TLS, rutas, log). |
| `src/spawn/` | Módulo `spawn` (`ShellRequest`, `SystemSpawn`, `spawn`): única vía para lanzar procesos (ver [Procesos del sistema](#procesos-del-sistema-módulo-spawn)). Referencia en `docs/spawn.md`. |
| `src/proxy/command-pass/` | Plugins de `command_pass`: `CommandPass` (interfaz `start`/`request`), `plugins.ts` (registro `plugins` y `aliases`) y el plugin `proxy`. Adaptan las funciones de `tunnel/`. |
| `src/proxy/tunnel/` | Acciones que ejecutan la petición fuera del proceso: `curl/`, `wget/`, `node/`, `ssh/`, `kubectl/`, más `run.ts`, `remote.ts`, `quote.ts`, `types.ts`. |
| `src/proxy/*.test.ts` | Tests del servidor (un archivo por tema). Los de `tunnel/` viven junto a su código. |
| `src/utils/test_utils/test-feature/` | `testFeature`: registra cada test como una *spec* de feature. |
| `src/utils/test_utils/fake-cli/` | `createFakeCli`: binarios `kubectl` y `ssh` falsos para tests (ver `docs/fake-cli.md`). |
| `e2e/sessions/` | `bun run e2e:sessions`: graba sesiones `{ perf, type, chunk }` de los programas reales con wrappers en el `PATH` (ver `docs/e2e.md`). |
| `src/utils/test_utils/lint-features/` | Convierte el payload + paths de un test en el "lint" que se ve en la tabla. |
| `docs/` | Referencia: `manifest.md`, `overview.md`, `concepts/` (`route`, `proxy_pass`, `command_pass`, `kubectl_pass`, `ssh_pass`), `tunnel/`. |
| `e2e/ui.e2e.ts` | Prueba end-to-end de `--ui` con Playwright (`bun run e2e`, ver `docs/e2e.md`). No la corre `bun test`. |
| `docs/system/features.md` | Tabla de features **generada**. No se edita a mano. |
| `scripts/features.ts` | Genera/verifica `docs/system/features.md`. |
| `scripts/release-notes.ts` | Arma las notas de cada release (ver [Títulos de PR](#títulos-de-pr)). |
| `.github/workflows/` | `test.yml` (PRs) y `publish.yml` (release manual). |
| `.claude/skills/new-feature/` | Skill con el flujo detallado para declarar una feature nueva. |
| `manifest.donly` | Manifest de ejemplo (puerto 8080). `certs/`, `logs/` y `dist/` están en `.gitignore`. |

Rama base: `develop`.

## Comandos

```sh
bun install --frozen-lockfile  # dependencias (lo mismo que hace CI)
bun start                      # levanta el proxy con ./manifest.donly
bun test                       # todos los tests (timeout por test: 5 s)
bun test src/proxy/server.test.ts   # un archivo
bun run features               # corre bun test y REESCRIBE docs/system/features.md
bun run features:check         # igual, pero falla si features.md está desactualizado
bun run build                  # dist/donly-proxy.js (bundle para Bun)
bun run e2e                    # build + prueba end-to-end de la UI en Chromium (docs/e2e.md)
```

CI (`test.yml`, en cada PR) ejecuta `bun test` y `bun run features:check`. Antes de abrir o
actualizar un PR, corre ambos en local. Los tests que necesitan infraestructura externa
(clúster kind, IPv6) se saltan solos con `testFeature.skip`/`cluster`, y cuentan como pasados.

## Manifest: la directiva `route`

Referencia completa en `docs/concepts/route.md` y `docs/manifest.md`. Lo esencial al tocar código o docs:

```
route [MÉTODO] <patrón> {
  <acción>
}
```

- El patrón es un **`URLPattern`** (WHATWG) contra la URL completa (`https://host/ruta?x=1`); sin
  esquema es un atajo por host (`example.com` = `*://example.com/*`) y la ruta debe coincidir
  completa (`/api/*` para prefijos). El método es opcional.
- Se evalúan **en orden y gana la primera** que coincida. Sin coincidencia, responde `200 ok`.
- `route { … }` sin argumentos coincide con todo: va **al final**; lo declarado después es inalcanzable.
- Cada ruta lleva **exactamente una acción**: `respond`, `proxy_pass`, `command_pass`, `kubectl_pass`
  o `ssh_pass`. Con cero o varias, el arranque falla; esos mensajes están en la tabla "Errores de
  arranque" de `docs/manifest.md` (si añades un error nuevo, agrégalo ahí).

## Regla: cada feature nueva lleva test y tabla regenerada

Cualquier directiva, comando o comportamiento nuevo del proxy **debe** entrar con:

1. Un test con `testFeature(payload, paths, "should …", fn)`: `payload` es el manifest que usa el
   test, `paths` son las rutas donly que ejercita (p. ej. `["/proxy/route/respond"]`). La
   descripción es el nombre del test, sin prefijos `[id]`.
2. Docs actualizadas (`docs/manifest.md` y, si aplica, `docs/concepts/` o `docs/tunnel/`).
3. `docs/system/features.md` regenerado con `bun run features` y commiteado junto al cambio.
   Si no lo regeneras, `features:check` rompe CI. Nunca edites ese archivo a mano.

Para el flujo paso a paso (test en rojo primero, plantilla y trampas) usa el skill
`.claude/skills/new-feature/SKILL.md`. Resumen de las trampas más comunes:

- `fetch` ignora `proxy` para hosts de `NO_PROXY`: vacíalo en `beforeAll` y restáuralo en `afterAll`.
- Para HTTPS usa `tls: { rejectUnauthorized: false }`.
- Puertos siempre dinámicos (0); nunca fijos. Un test que agota el tiempo deja su spec `pending` y `features` falla.
- Comandos externos: no dependas del binario real; usa un script falso al inicio del `PATH`.
- Datos de la petición jamás se interpolan en un shell; agrega un test `no-shell-injection`.
- Snapshots: la clave es la descripción del test; actualiza con `bun test -u` revisando el diff.

## Títulos de PR

Los PRs se mergean con merge commit y el workflow `publish` agrupa las notas del release
(`scripts/release-notes.ts`) leyendo el **título del PR** (lo consulta con `gh`). Usa el formato
de commit convencional `tipo: descripción` (el scope `tipo(scope):` también vale):

| Prefijo | Sección en las notas |
| --- | --- |
| `feat` | ✨ Novedades |
| `fix` | 🐛 Correcciones |
| `perf` | ⚡ Rendimiento |
| `docs` | 📚 Documentación |
| `test` | 🧪 Pruebas |
| `ci`, `build`, `publish` | 🔧 CI y build |
| `chore`, `refactor`, `style` | 🧹 Mantenimiento |

Cualquier otro título (o sin prefijo) cae en "📦 Otros cambios", sin limpiar. Escribe la descripción en
español, en minúscula inicial y sin punto final, p. ej. `feat: soporta wget como engine`.
Los commits `release: vX.Y.Z` los crea el workflow y se omiten de las notas.

## Procesos del sistema: módulo `spawn`

Todo lo que lance un proceso del sistema (tráfico Shell: `curl`, `ssh`, `kubectl`, `openssl`, `bash`…) **debe**
pasar por `src/spawn/`: construye un `ShellRequest` y ejecútalo con `spawn(request, { logger })`
(`SystemSpawn.defaultChildProcess` por defecto, `SystemSpawn.fromResponse(...)` para comandos anidados).
Así cada comando queda en el log `.ndjson` (`command_start`/`command_end`) y se prueba en un solo sitio.

- No uses `node:child_process`, `Bun.spawn`, `Bun.spawnSync`, `Bun.$` ni equivalentes fuera de `src/spawn/`.
- Pasa siempre el `logger` cuando la ejecución es parte de una petición del proxy.
- Argumentos separados en `ShellRequest.commands`; nunca una cadena de shell (ver [Estilo y seguridad](#estilo-y-seguridad)).
- Referencia: `docs/spawn.md`.

## Log `.ndjson`: nombres de los tipos

Formato en `docs/log-format.md`. Al añadir un tipo de línea que abre y cierra algo, nómbralo con
los sufijos `_start` y `_end` (`command_start`/`command_end`, `script_start`/`script_end`), y
documéntalo en `docs/log-format.md` y `docs/manifest.md`. Excepciones: `request`/`response` y
`proxy_pass_request`/`proxy_pass_response` (el `proxy_pass`). Los eventos sueltos no llevan sufijo.

## Publicación

`publish.yml` es manual (`workflow_dispatch`, bump `patch|minor|major`): instala, corre
`bun test` y `features:check`, construye `dist/donly-proxy.js`, hace `npm version`, empuja el tag y
crea el release con el bundle, su SHA256 y las notas. No lo ejecutes ni cambies la versión de
`package.json` a mano.

## Estilo y seguridad

- Sigue el estilo del código vecino (TypeScript estricto, ESM, comentarios escasos y en inglés
  en el código; docs en español).
- No agregues dependencias sin necesidad; la única es `donly`.
- El proxy ejecuta procesos y termina TLS: lee `SECURITY.md` antes de tocar `src/proxy/tunnel/`.
  Mantén argumentos separados (nunca una cadena de shell) y valida las entradas del manifest en `loadConfig`.
- No commitees `certs/`, `logs/` ni `dist/`.
