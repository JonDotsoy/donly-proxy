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

Las pruebas que graban programas reales (antes `e2e/sessions`) son las **pruebas empíricas**: ver [empirical.md](empirical.md).
