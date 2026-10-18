# Runbook: grabar escenarios empíricos reales de `kubectl_pass` y `ssh_pass`

Cuándo usarlo: para grabar cómo responden `kubectl` y `ssh` reales y contrastarlo con `createFakeCli`.
Contexto: [empirical.md](empirical.md), [fake-cli.md](fake-cli.md). Estado: **pendiente de ejecutar**.

## Reglas

- `ssh_pass` se prueba **directo contra el droplet**, nunca con un workflow de GitHub (preferencia del proyecto).
- Las claves viven en `/mnt/project-files/donly-proxy/ssh-test-keys/`. No se copian al repo ni a un escenario.
- Solo se ejecutan comandos de lectura (`curl` a `api.ipify.org`, `--version`); nada que modifique el destino.
- `bun test` sigue usando solo los fakes.

## Requisitos

| Qué | Para qué |
| --- | --- |
| Máquina con `ssh`, `kubectl`, `curl`, `bun` | Los entornos de la nube no traen `ssh` ni `kubectl` |
| Acceso al droplet y su clave | Escenario `ssh_pass` |
| Un pod con `curl` (p. ej. en `kind`) | Escenario `kubectl_pass` |

Comprobar: `command -v ssh kubectl curl bun`.

## Paso 1. Escenarios sin destino

```sh
bun run empirical
```

Graba `ssh-version`, `ssh-connection-refused`, `kubectl-version` y `kubectl-unreachable-cluster` en
`empirical/__scenarios__/`.
Verificar: existen las 4 carpetas con `scenario.json` y la sesión de `ssh`/`kubectl`.

## Paso 2. `ssh_pass` contra el droplet

```sh
DONLY_E2E_SSH=usuario@host \
DONLY_E2E_SSH_ARGS="-i <ruta-clave> -o BatchMode=yes" \
bun run empirical
```

Verificar: existe `manifest-ssh-pass-public-ip` y su stdout muestra una IP.
Si falla con `ssh … exited with 255`: revisar clave, host y puerto.

## Paso 3. `kubectl_pass` contra un pod

```sh
kind create cluster
kubectl run curl-pod --image=curlimages/curl --command -- sleep 3600
kubectl wait --for=condition=Ready pod/curl-pod
DONLY_E2E_KUBECTL_POD=pod/curl-pod bun run empirical
```

Verificar: existe `manifest-kubectl-pass-public-ip` con una IP en stdout.
Limpiar al terminar: `kind delete cluster`.

## Paso 4. Revisar antes de compartir

Buscar en las carpetas grabadas rutas de claves, IPs privadas y usuarios:

```sh
grep -rEn "\.ssh|id_|BEGIN .*KEY|usuario@" empirical/__scenarios__/manifest-ssh-* empirical/__scenarios__/ssh-*
```

Salida esperada: nada que no deba verse. Si aparece algo, no commitear.

## Paso 5. Contrastar con el fake

Comparar cada sesión con lo que produce `createFakeCli`: argumentos (`exec -i -q …`, `-o BatchMode=yes …`),
código de salida y primera línea de stderr en `--version` y en conexión rechazada. Comparar la forma,
no el texto exacto (cambia con la versión).
Si difieren: corregir `src/utils/test_utils/fake-cli/fake-cli.ts` y los tests de
`src/proxy/tunnel/kubectl/kubectl.test.ts` y `ssh/ssh.test.ts`; luego `bun test` y `bun run features:check`.

## Paso 6. Versionar y documentar

- Commitear solo las sesiones sin destino privado (`*-version`, `*-unreachable-cluster`, `*-connection-refused`):
  `git add -f empirical/__scenarios__/<nombre>` (el `.gitignore` las excluye por patrón).
- Los `manifest-*` con host o pod reales no se versionan.
- Añadirlas a `docs/empirical.md`. Commit en español con prefijo `docs:` o `test:`.

## Si algo sale mal

| Síntoma | Causa probable | Acción |
| --- | --- | --- |
| El escenario aparece como "unavailable" | Falta la variable `DONLY_E2E_*` | Exportarla y repetir |
| `Permission denied (publickey)` | Clave incorrecta | Revisar `DONLY_E2E_SSH_ARGS` |
| `kubectl` pide contexto | `kubectl` sin clúster activo | `kubectl config use-context` o pasar `DONLY_E2E_KUBECTL_ARGS="--context …"` |
| Escenario ya existe | Se graba una sola vez | Borrar la carpeta o usar `force` |

## Pendiente de decidir

- ¿`kind` local o un clúster existente para `kubectl_pass`?
- ¿Se versiona alguna sesión con destino real, anonimizada?
