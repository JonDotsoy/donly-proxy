# Prueba end-to-end de la UI (Playwright)

`e2e/ui.e2e.ts` comprueba el dashboard `--ui` en un navegador real contra el binario construido, sin mocks.

## Qué hace

1. Construye `dist/donly-proxy.js` y lo levanta con `--ui --ui-port 0`, en un directorio temporal, con un manifest que tiene una ruta `proxy_pass` hacia un upstream local y una ruta `kubectl_pass` (motor `node`) servida por un `kubectl` falso al inicio del `PATH`.
2. Envía cuatro peticiones reales por el proxy (dos por `proxy_pass`, dos por `kubectl_pass`), con valores largos sin espacios para forzar desbordes.
3. Abre la UI en Chromium y comprueba:
   - **Lista**: una fila por línea del `.ndjson`, en el mismo orden; al expandir todo, cada JSON es idéntico a su línea; buscador y filtro por tipo.
   - **Línea de tiempo**: una tarjeta por transacción, un carril por span, sin barras abiertas; `?view=timeline` abre la vista directamente y un carril muestra sus líneas.
   - **Ancho**: ni la página ni los detalles expandidos (lista y carriles) se salen de la ventana a 1280, 768 y 390 px.

`e2e/multi-proxy.e2e.ts` levanta el binario con dos bloques `proxy` (`listen http` y `listen https`) y comprueba con `curl --proxy` que cada uno responde su propio `respond` (`ok http` / `ok https`).

`e2e/route-url-formats.e2e.ts` levanta el binario con rutas `URLPattern` y comprueba con `curl --proxy` cómo coincide `route` con solo host, host con puerto, host con ruta, comodines y esquema `http`/`https`.

`e2e/no-route.e2e.ts` levanta el binario con un bloque `proxy { listen http … }` sin ningún `route` y comprueba con `curl --proxy` que arranca y reenvía la petición sin modificarla a su destino (un upstream local), sin responder `200 ok`.

Todos los puertos son dinámicos (`0`) y no hay dependencias externas: el upstream, el `kubectl` y el `node` son locales.

## Cómo ejecutarla

```sh
bun install --frozen-lockfile
bunx playwright-core install chromium   # solo la primera vez
bun run e2e                             # construye y corre la prueba
```

- `bun test` **no** la ejecuta (el archivo no se llama `*.test.ts`), así que no afecta a la suite normal ni a `features:check`.
- Si ya tienes un Chromium (p. ej. `PLAYWRIGHT_BROWSERS_PATH` apunta a uno), no hace falta instalarlo. Para usar un binario concreto: `CHROMIUM_PATH=/ruta/a/chromium bun run e2e`.
- Requiere `node` en el `PATH` (lo usa el motor `node` de `kubectl_pass`).

## CI

El job `e2e` de `.github/workflows/test.yml` instala Chromium con `playwright-core install --with-deps chromium` y corre `bun run e2e` en cada PR.

## Sesiones empíricas (`e2e/sessions`)

`bun run e2e:sessions` graba cómo se comportan los programas **reales** (`kubectl`, `ssh`, `curl`, `wget`, `node`) para tener datos reales con los que construir y validar los CLI falsos (`docs/fake-cli.md`).

- El test prepara un directorio `bin` con un *wrapper* por programa, al inicio del `PATH`. El wrapper (`e2e/sessions/wrapper.ts`) ejecuta el programa real con el módulo `spawn`, deja pasar stdin, stdout y stderr sin tocarlos y guarda cada trozo en `e2e/sessions/__sessions__/<nombre>.session.json` como un arreglo de `{ elapse_nanosecond, type, ... }`: `elapse_nanosecond` son los nanosegundos transcurridos desde que empezó la sesión (API `performance`) y `type` es `command` (abre cada llamada, con `command`, el programa que se ejecutó, y `args: string[]`, los argumentos que recibió), `stdin`, `stdout` o `stderr` (con `chunk`, el mensaje).
- Junto a cada sesión queda `<nombre>.calls.json` con el programa, los argumentos y el código de salida de cada llamada (`kubectl get pods` y `kubectl exec` en una misma sesión de `kubectl_pass`, por ejemplo).
- Cada sesión se ejecuta con un `Bun.$` (solo en el test) o con un manifest: se levanta el proxy y se pide `http://api.ipify.org/?format=json` por él (la IP pública de esta máquina).
- **Una sola vez:** si el archivo de la sesión existe, el test se salta. Para grabarla de nuevo, borra su `.session.json` y su `.calls.json`.
- Una sesión se salta si falta un programa en la máquina (en CI no hay `kubectl` ni `ssh`). Las de `ssh_pass` y `kubectl_pass` piden además `DONLY_E2E_SSH=usuario@host` (y `DONLY_E2E_SSH_ARGS="-p 22 -i ~/.ssh/llave"`) o `DONLY_E2E_KUBECTL_POD=pod/nombre` (y `DONLY_E2E_KUBECTL_ARGS="-n prod"`).
- La grabación solo se mueve a su sitio cuando la sesión completa terminó bien; si falla, se puede repetir.

Los archivos contienen la salida real de cada máquina que graba (versiones, fechas, la IP pública…): revísalos antes de commitearlos.
