# Plan: escenarios empíricos reales de `kubectl_pass` y `ssh_pass`

Estado: **pendiente** (no implementado). Contexto: `docs/empirical.md`, `docs/fake-cli.md`.

## Objetivo

Hoy `kubectl_pass` y `ssh_pass` solo se prueban contra los binarios falsos de `createFakeCli`. Eso fija
los argumentos y el flujo, pero no demuestra que el programa real los acepte ni cómo responde. El plan
es grabar, con `Scenario`, una sesión de cada uno contra un destino real y dejarla como referencia
versionada de lo que dicen `kubectl` y `ssh` de verdad.

## Qué existe ya

- `empirical/scenarios.empirical.ts` ya declara `manifest-ssh-pass-public-ip` y
  `manifest-kubectl-pass-public-ip`; se saltan salvo que existan `DONLY_E2E_SSH` (+ `DONLY_E2E_SSH_ARGS`)
  o `DONLY_E2E_KUBECTL_POD` (+ `DONLY_E2E_KUBECTL_ARGS`).
- `.gitignore` ignora `manifest-*`, `kubectl-*` y `ssh-*` en `empirical/__scenarios__/`, así que lo
  grabado no se commitea por accidente.
- No hay `kubectl` ni `ssh` instalados en el entorno de la nube, por eso quedó pendiente.

## Alcance

1. Grabar `ssh-version`, `ssh-connection-refused`, `kubectl-version` y `kubectl-unreachable-cluster`
   (no necesitan destino) en una máquina que tenga los programas.
2. Grabar `manifest-ssh-pass-public-ip` contra un host real.
3. Grabar `manifest-kubectl-pass-public-ip` contra un pod real.
4. Contrastar cada sesión con el fake: mismos argumentos (`exec -i -q …`, `-o BatchMode=yes …`),
   mismo mensaje de error en fallos (`ssh curl exited with 255: …`, `kubectl curl exited with 1: …`).
5. Corregir `createFakeCli` y los tests de `kubectl.test.ts`/`ssh.test.ts` donde difieran.

Fuera de alcance: crear infraestructura nueva, workflows de GitHub, y cualquier comando que modifique el destino.

## Decisiones

- **`ssh_pass`: se prueba directo contra el droplet, no con workflow de GitHub** (preferencia de Jona,
  guardada en la memoria del proyecto). Las claves y el detalle de acceso viven en
  `/mnt/project-files/donly-proxy/ssh-test-keys/`; nunca se copian al repo ni a un escenario.
- **`kubectl_pass`: hace falta un clúster.** Opción recomendada: `kind` local en la máquina de Jona
  (los tests de clúster ya se saltan con `testFeature.cluster`). Alternativa: un pod en un clúster existente.
- Los escenarios con host o pod reales siguen ignorados por git; solo se versionan los que no dependen de un
  destino privado (`*-version`, `*-unreachable-cluster`, `*-connection-refused`).

## Pasos

1. En la máquina con los programas: `bun run empirical` sin variables y revisar que graba los cuatro
   escenarios sin destino. Versionar sus carpetas (retirar su patrón del `.gitignore` o forzar con `git add -f`).
2. Con el droplet: `DONLY_E2E_SSH=usuario@host DONLY_E2E_SSH_ARGS="-i <clave> -o BatchMode=yes" bun run empirical`.
   Revisar que `scenario.json` y las sesiones no contengan la ruta de la clave ni IPs privadas antes de compartirlas.
3. Con el clúster: `kind create cluster`, `kubectl run` de una imagen con `curl`, luego
   `DONLY_E2E_KUBECTL_POD=pod/<nombre> bun run empirical`.
4. Comparar con el fake (alcance 4) y abrir un PR con las correcciones.
5. Actualizar `docs/empirical.md` con los escenarios versionados nuevos.

## Cómo se prueba

- `bun test` sigue sin depender de ssh ni kubectl reales: solo usa los fakes.
- Cada escenario nuevo pasa por `validateSession` (ya lo hace `Scenario.load`).
- Un test de contraste en `src/proxy/tunnel/` lee la sesión grabada versionada y comprueba que el fake
  produce la misma forma (código de salida y primera línea de stderr) para `--version` y conexión rechazada.

## Riesgos

- Credenciales en los logs: ssh puede imprimir rutas de claves o hosts en stderr. Revisar siempre antes de commitear.
- Las salidas de `kubectl version`/`ssh -V` cambian con la versión; el contraste debe comparar la forma, no el texto exacto.
- El `script` de un escenario puede contener rutas temporales que ensucian `scenario.json` (pendiente aparte).

## Preguntas abiertas

- ¿Se usa `kind` local o un clúster ya existente para `kubectl_pass`?
- ¿Se versiona alguna sesión con destino real, ya anonimizada, o solo las que no lo necesitan?
