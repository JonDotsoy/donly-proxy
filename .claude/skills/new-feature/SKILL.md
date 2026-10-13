---
name: new-feature
description: Declara una nueva feature de donly-proxy a partir de un ejemplo de manifest.donly y de lo que se espera que ocurra. Registra la feature en docs/system/features.md, escribe el test que declara lo esperado (rojo), la implementa y deja la tabla al día. Úsalo cuando se pida agregar, declarar o soportar una nueva directiva, comando o comportamiento del proxy.
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
   (tabla de features) y el test más parecido en `src/**/*.test.ts`.
2. **Elige el id** de la feature: minúsculas, puntos como jerarquía, p. ej. `route.headers`,
   `command_pass.ssh.timeout`. Revisa que no exista ya en la tabla.
3. **Declárala en la tabla** (`docs/system/features.md`) con una fila nueva, en el grupo que
   corresponda y con **Soportada ❌** (aún no implementada):

   ```
   | `id.de.la.feature` | Descripción en una línea | ❌ | | |
   ```

   Las columnas *Probada* y *Tests* las rellena el script; no las escribas.
4. **Escribe el/los test(s) que declaran lo esperado**, usando el manifest del ejemplo. El título
   **debe llevar el id entre corchetes**: `test("[id.de.la.feature] qué comprueba", …)`
   (un título puede llevar varios ids). Cubre al menos:
   - el camino feliz del ejemplo;
   - los errores que el usuario haya declarado (manifest inválido → `loadConfig(...)` rechaza con
     el mensaje esperado; destino caído → `502`, etc.).

   Cada comportamiento distinto que describa la feature merece su propia fila en la tabla y su
   propio test (p. ej. `x`, `x.error`, `x.validation`).
5. **Ejecuta los tests y comprueba que fallan por la razón correcta** (`bun test <archivo>`). Un
   test que pasa antes de implementar no declara nada.
6. **Implementa** hasta que pasen. Código en `src/` (config en `loadConfig` de `src/proxy/server.ts`,
   acciones de ruta en el handler de `createProxyServer`, comandos externos en `src/proxy/tunnel/`:
   `curl/`, `wget/`, `node/`, `ssh/`, `kubectl/` y `remote.ts`). Sigue el estilo del código
   vecino.
7. **Marca la feature como soportada** (`❌` → `✅` en *Soportada*) y **documéntala**: referencia en
   `docs/manifest.md` y, si es un `proxy_pass`/`command_pass`, en `docs/tunnel/`. Cuida que
   los mensajes de error del manifest estén en la tabla "Errores de arranque".
8. **Actualiza la tabla**: `bun run features`. Debe terminar sin errores y dejar la feature con
   *Probada* ✅. Luego `bun test` completo y `bun run features:check` (es lo que corre CI).
9. **Commit** en la rama de trabajo. No abras PR salvo que se pida.

## Plantilla de test

El manifest se escribe en una carpeta temporal (las rutas relativas se resuelven contra ella) y
el proxy escucha en el puerto 0:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyServer, loadConfig } from "./server";

const dir = mkdtempSync(join(tmpdir(), "donly-proxy-feature-"));
const manifest = join(dir, "manifest.donly");
writeFileSync(
  manifest,
  `proxy {
  host "127.0.0.1"
  port 0
  ssl {
    cert "./certs/cert.pem"
    key "./certs/key.pem"
  }
  # <-- el ejemplo de manifest de la feature
}
`,
);

let server: ReturnType<typeof createProxyServer>;
let proxy: string;

beforeAll(async () => {
  server = createProxyServer(await loadConfig(manifest));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

test("[id.de.la.feature] lo que se espera", async () => {
  const res = await fetch("http://example.com/", { proxy });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("…");
});

test("[id.de.la.feature.validation] manifest inválido", async () => {
  const bad = join(dir, "bad.donly");
  writeFileSync(bad, `proxy {\n  …\n}\n`);
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
  (`bun test -u`) revisando el diff a mano.
- Los títulos de los tests definen la columna *Probada*: un test sin `[id]` o con un id que no
  está en la tabla hace fallar `bun run features`.

## Al terminar

Resume en pocas líneas: id(s) declarados, manifest de ejemplo, comportamiento cubierto por los
tests, qué quedó sin probar (si algo) y el resultado de `bun test` y `bun run features:check`.
