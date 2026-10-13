---
name: new-feature
description: Declara una nueva feature de donly-proxy a partir de un ejemplo de manifest.donly y de lo que se espera que ocurra. Escribe el test con testFeature que declara lo esperado (rojo), lo implementa y regenera docs/system/features.md. Úsalo cuando se pida agregar, declarar o soportar una nueva directiva, comando o comportamiento del proxy.
argument-hint: "<manifest de ejemplo> + <comportamiento esperado>"
---

# Declarar una nueva feature

Una feature se declara con **dos cosas obligatorias**. Sin ambas no se empieza:

1. **Un ejemplo de `manifest.donly`** que use la feature (el bloque `proxy { … }` completo o el
   fragmento relevante).
2. **Lo esperado**: qué petición se hace al proxy y qué debe pasar. Debe ser comprobable:
   estado, cabeceras y/o cuerpo de la respuesta, líneas del log, error de arranque del manifest, o
   cómo debe ser invocado un comando externo.

Si el usuario no entregó alguna de las dos (`$ARGUMENTS` incompleto), **pídela** antes de seguir.
No inventes el manifest ni el resultado esperado. Si falta precisión (¿qué estado devuelve en
caso de error?, ¿qué pasa con HTTPS?), pregunta; lo que se declare es el contrato.

## Flujo

1. **Lee el contexto.** `docs/manifest.md` (referencia del manifest), `docs/system/features.md`
   (specs ya declaradas: qué directivas ejercita cada test) y el test más parecido en
   `src/**/*.test.ts`.
2. **Elige los paths de la feature**: rutas donly de las directivas que el test ejercita, p. ej.
   `/proxy/route/respond`, `/proxy/route/command_pass/engine`, `/proxy/log_file`. Admiten `*`,
   `|`, `(args)` y `{…}` (ver `findAllDirectives` en `donly`); `/proxy/route()` es la ruta sin
   argumentos. Una directiva con bloque se marca completa, hijos incluidos.
3. **Escribe el/los test(s) con `testFeature`** (`src/utils/test_utils/test-feature`), usando el
   manifest del ejemplo como payload:

   ```ts
   testFeature(payload, ["/proxy/route/respond"], "should answer with the configured body", async (payload) => { … });
   ```

   - La descripción es el nombre del test (`should …`); **sin prefijos `[id]`**. Es también la
     clave del snapshot, si usa `toMatchSnapshot`.
   - El payload debe ser el manifest que el test usa. Si lleva puertos dinámicos, hoístalo a una
     función `manifestPayload(port)`; el lint enmascara `127.0.0.1:<puerto>`.
   - Cubre al menos el camino feliz y los errores que el usuario haya declarado (manifest
     inválido → `loadConfig(...)` rechaza con el mensaje esperado; destino caído → `502`, etc.).
     Cada comportamiento distinto merece su propio `testFeature`.
   - Para tests que dependen de infraestructura externa usa `testFeature.skip` (o `cluster` en
     `kubectl/kind-fixture.ts`); admite un `timeout` como quinto argumento.
4. **Ejecuta los tests y comprueba que fallan por la razón correcta** (`bun test <archivo>`). Un
   test que pasa antes de implementar no declara nada.
5. **Implementa** hasta que pasen. Código en `src/` (config en `loadConfig` de `src/proxy/server.ts`,
   acciones de ruta en el handler de `createProxyServer`, comandos externos en `src/proxy/tunnel/`:
   `curl/`, `wget/`, `node/`, `ssh/`, `kubectl/` y `remote.ts`). Sigue el estilo del código
   vecino.
6. **Documéntala**: referencia en `docs/manifest.md` y, si es un `proxy_pass`/`command_pass`, en
   `docs/tunnel/`. Cuida que los mensajes de error del manifest estén en la tabla "Errores de
   arranque".
7. **Regenera `docs/system/features.md`**: `bun run features` (corre `bun test` y lee
   `__test_features__/spec_tests.json`; no edites el documento a mano). Debe terminar sin
   errores y mostrar la spec como ✅. Luego `bun run features:check` (es lo que corre CI).
8. **Commit** en la rama de trabajo. No abras PR salvo que se pida.

## Plantilla de test

El payload es el manifest; el test lo escribe en una carpeta temporal (las rutas relativas se
resuelven contra ella) y el proxy escucha en el puerto 0:

```ts
import { afterAll, beforeAll, expect } from "bun:test";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testFeature } from "../utils/test_utils/test-feature/test-feature";
import { createProxyServer, loadConfig } from "./server";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-feature-"));
const manifest = join(dir, "manifest.donly");
// <-- el ejemplo de manifest de la feature
const manifestPayload = `proxy {
  host "127.0.0.1"
  port 0
  ssl {
    cert "./certs/cert.pem"
    key "./certs/key.pem"
  }
}
`;
writeFileSync(manifest, manifestPayload);

let server: ReturnType<typeof createProxyServer>;
let proxy: string;

beforeAll(async () => {
  server = createProxyServer(await loadConfig(manifest));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

testFeature(manifestPayload, ["/proxy/route/respond"], "should answer the request", async () => {
  const res = await fetch("http://example.com/", { proxy });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("…");
});

const badPayload = `proxy {\n  …\n}\n`;
testFeature(badPayload, ["/proxy/route"], "should reject an invalid manifest", async (payload) => {
  const bad = join(dir, "bad.donly");
  writeFileSync(bad, payload);
  expect(loadConfig(bad)).rejects.toThrow("mensaje esperado");
});
```

## Trampas conocidas

- **`NO_PROXY`**: `fetch` ignora el `proxy` para los hosts de `NO_PROXY`/`no_proxy` (a menudo
  `localhost` y `127.0.0.1`). Si la prueba apunta a un host local, vacía ambas variables en
  `beforeAll` (`process.env.NO_PROXY = process.env.no_proxy = ""`) y restáuralas en `afterAll`.
- **HTTPS**: el cliente debe aceptar el certificado autofirmado del proxy:
  `fetch(url, { proxy, tls: { rejectUnauthorized: false } })`. La URL de la ruta es
  `https://host/…` (el `:443` se omite; otros puertos se conservan).
- **Destino local**: levanta un `http.createServer` en el puerto 0 dentro del test (nunca puertos
  fijos) y construye el manifest después de conocer su puerto.
- **Comandos externos (`curl`, `node`, `ssh`, `kubectl`)**: no dependas del binario real. Pon un
  script falso al inicio del `PATH` que registre sus argumentos (`printf '%s\0' "$@"`) y ejecute lo
  necesario; restaura `PATH` en `afterAll`. Mira `src/proxy/tunnel/curl/curl.test.ts`,
  `src/proxy/tunnel/ssh/ssh.test.ts` y `src/proxy/tunnel/kubectl/kubectl.test.ts`.
- **Datos de la petición** (URL, cabeceras, cuerpo) nunca deben interpolarse en una línea de
  comandos ni en un shell; si la feature ejecuta comandos, agrega un test `no-shell-injection`.
- **Log**: si la feature afecta al log, comprueba las líneas `.ndjson` o actualiza el snapshot
  (`bun test -u`; la clave del snapshot es la descripción del test, no la cambies sin renombrarla) revisando el diff a mano.
- Un test que agota el tiempo (5 s) no pasa por el `catch` de `testFeature`: su spec queda
  `pending` en `features.md` y `bun run features` falla igual.

## Al terminar

Resume en pocas líneas: tests (`testFeature`) y paths declarados, manifest de ejemplo, comportamiento cubierto por los
tests, qué quedó sin probar (si algo) y el resultado de `bun test` y `bun run features:check`.
