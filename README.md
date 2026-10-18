# donly-proxy

Proxy HTTP/HTTPS/SOCKS configurable con un manifiesto [DON](https://don.jon.soy/) (`manifest.donly`).
Por defecto responde `ok`; con rutas (`route`) puede responder con un cuerpo fijo, reenviar la
petición a otro servidor o **sacarla por otra vía**: un comando local (`curl`, `node`), un host
remoto por SSH o un pod de Kubernetes.

- [Sintaxis inicial del manifest](#sintaxis-inicial-del-manifest)
- [Pasar el tráfico a un comando: `command_pass`](#pasar-el-tráfico-a-un-comando-command_pass)
- [Kubernetes: `kubectl_pass`](#kubernetes-kubectl_pass)
- [SSH: `ssh_pass`](#ssh-ssh_pass)
- [Instalación](#instalación)

## Sintaxis inicial del manifest

Todo va dentro de un bloque `proxy`. Este es el mínimo útil:

```
proxy {
  listen http 127.0.0.1 8080
  log_file "./logs/proxy.ndjson"

  route http{s}?://example.com/* {
    respond 200 "good"
  }
}
```

```sh
bun start                    # usa ./manifest.donly
bun start otro.donly         # usa otro manifest
curl -x http://127.0.0.1:8080 http://example.com/    # -> good
```

- **`listen [http|https|socks4|socks5] [host] [puerto]`**: protocolo, dirección y puerto del
  listener (por defecto `http 127.0.0.1 0`; el puerto `0` lo asigna el sistema). Se puede repetir
  para abrir varios listeners que comparten las mismas rutas.
- **Varios `proxy`**: un manifest puede declarar más de un bloque `proxy`, cada uno independiente
  (su propio `listen`, `route` y `log_file`).
- **`route [MÉTODO] <patrón> { <acción> }`**: el patrón es un
  [`URLPattern`](https://developer.mozilla.org/docs/Web/API/URLPattern) contra la URL completa;
  gana la primera ruta que coincida y, si ninguna lo hace, responde `200 ok`. Un `route { … }`
  sin argumentos coincide con todo y va al final.
- **Acciones** (exactamente una por ruta): `respond`, `proxy_pass`, `command_pass`, `kubectl_pass`
  y `ssh_pass`.

```
proxy {
  listen http 8080
  listen socks5 1080

  route GET https://api.example.com/* {
    proxy_pass "http://localhost:3000"
  }
  route {
    respond 404 "not found"
  }
}
```

Otras directivas: `auth basic { username "…" password "…" }` (usuario y contraseña),
`listen https` (el cliente habla TLS con el proxy) y `--ui` para ver el log en vivo en el navegador.
Referencia completa: [`docs/manifest.md`](docs/manifest.md) y [`docs/concepts/route.md`](docs/concepts/route.md).

## Pasar el tráfico a un comando: `command_pass`

`command_pass` entrega la petición a un comando que la ejecuta contra su URL original (la conexión
la hace el comando, no el proxy). Los argumentos extra se pasan al comando, uno por cadena.

```
route http://example.com/* {
  command_pass curl "--max-time" "5"
}

route https://example.com/* {
  command_pass node "--no-warnings"
}
```

- `curl` y `node` salen **desde la máquina local**; con `ssh` y `kubectl` salen desde el host o el
  pod, y ahí el motor puede ser `curl`, `node` o `wget` (`engine`; `wget` solo hace GET y POST).
- El comando se lanza **sin shell**; si falla, el cliente recibe `502 bad gateway`.
- Directivas hijas: `concurrency`, `extra_args`, `insecure`, `max_time` y `retry` (solo `curl`),
  `no_warnings` (solo `node`).

Detalle: [`docs/tunnel/command-pass.md`](docs/tunnel/command-pass.md).

## Kubernetes: `kubectl_pass`

Ejecuta la petición **dentro de un pod**, por ejemplo para llegar a un Service `ClusterIP` que no
está expuesto. El proxy usa `kubectl exec`; el `command_pass` hijo (`curl`, `wget` o `node`) dice
qué corre dentro.

```
route http{s}?://api.internal/* {
  kubectl_pass {
    pod_name "my-pod-12345"        # o: pod_match my-pod-*
    context dev
    namespace prod
    command_pass curl "--max-time" "5"
  }
}
```

También acepta el destino como argumento (`kubectl_pass "deploy/api" { … }`). Con `pod_match`
elige el primer pod en ejecución cuyo nombre coincida. Necesita `kubectl` en el `PATH` y, dentro
del contenedor, lo que use el motor (`sh`, `curl`/`wget`/`node`…).
Detalle: [`docs/concepts/kubectl_pass.md`](docs/concepts/kubectl_pass.md).

## SSH: `ssh_pass`

Ejecuta la petición **en otra máquina** por `ssh` (un bastión, un servidor con otra IP…). El host
puede ser un nombre de `~/.ssh/config`, un DNS, una IP o `usuario@host`.

```
route http{s}?://api.internal/* {
  ssh_pass {
    host "203.0.113.10"
    port 2222
    user deploy
    identity_file "./keys/id_ed25519"
    option "StrictHostKeyChecking=accept-new"
    command_pass curl "--max-time" "10"
  }
}
```

Sin `pass`, `ssh` corre en `BatchMode` (solo llaves o agente); con `pass` la contraseña se entrega
por `SSH_ASKPASS` y no aparece en la línea de comandos ni en el log, pero queda en claro en el
manifest, así que prefiere llaves. Detalle: [`docs/concepts/ssh_pass.md`](docs/concepts/ssh_pass.md).

> Con `ssh_pass`, `kubectl_pass` y `command_pass ssh|kubectl` ningún dato de la petición se
> interpola en un shell: la configuración viaja en base64 y el cuerpo por stdin.

## Instalación

Descarga el asset de la última versión publicada y déjalo en `~/donly-proxy/bin/donly-proxy.js`:

```sh
mkdir -p ~/donly-proxy/bin
curl -fL https://github.com/JonDotsoy/donly-proxy/releases/latest/download/donly-proxy.js \
  -o ~/donly-proxy/bin/donly-proxy.js
```

Con la GitHub CLI:

```sh
gh release download --repo JonDotsoy/donly-proxy --pattern donly-proxy.js \
  --dir ~/donly-proxy/bin --clobber
```

El bundle está construido para [Bun](https://bun.sh), así que se ejecuta con:

```sh
bun ~/donly-proxy/bin/donly-proxy.js [manifest.donly]
```

Sin argumentos carga, del directorio actual, el primero que exista entre `proxy.donly`, `.proxy.donly`, `manifest.donly` y `.manifest.donly`, e imprime en consola (stderr) qué manifiesto está leyendo.

Para actualizar, vuelve a ejecutar el comando de descarga.

## Fórmula local de Homebrew (desarrollo)

Para probar la instalación vía Homebrew sin publicar un tap, crea un tap local y coloca ahí la fórmula.

1. Crea el tap local (una sola vez):

```sh
brew tap-new $USER/local
```

2. Copia el `sha256` desde las notas del release (secciones **SHA256** y **Fórmula de Homebrew (template)**, publicadas por el workflow `publish`; la fórmula del release ya viene con versión, url y hash completados): <https://github.com/JonDotsoy/donly-proxy/releases>

3. Crea la fórmula dentro del tap con `brew create` (genera `Formula/donly-proxy.rb` y la abre en tu editor):

```sh
brew create --tap $USER/local --set-name donly-proxy \
  https://github.com/JonDotsoy/donly-proxy/releases/download/v0.0.3/donly-proxy.js
```

   Reemplaza el contenido por este template; **solo debes cambiar el `sha256`** (y `version`/`url` si pruebas otra versión). Para volver a editarla usa `brew edit $USER/local/donly-proxy`:

```ruby
class DonlyProxy < Formula
  desc "Proxy for donly: continuation of the demo proxy"
  homepage "https://github.com/JonDotsoy/donly-proxy"
  version "0.0.3"
  url "https://github.com/JonDotsoy/donly-proxy/releases/download/v0.0.3/donly-proxy.js"
  sha256 "REEMPLAZA_CON_EL_HASH"
  license "MIT"

  depends_on "oven-sh/bun/bun"

  def install
    libexec.install "donly-proxy.js"
    (bin/"donly-proxy").write <<~EOS
      #!/bin/sh
      exec bun "#{libexec}/donly-proxy.js" "$@"
    EOS
  end

  test do
    assert_predicate libexec/"donly-proxy.js", :exist?
  end
end
```

4. Instala (o reinstala tras cambiar el hash):

```sh
brew install --formula $USER/local/donly-proxy
# para volver a probar:
brew reinstall --formula $USER/local/donly-proxy
```

5. Ejecuta y, al terminar, desinstala y elimina el tap:

```sh
donly-proxy manifest.donly
brew uninstall donly-proxy
brew untap $USER/local
```

> Si el release no es público aún, genera el bundle con `bun run build` y usa `url "file:///ruta/absoluta/dist/donly-proxy.js"` junto con el hash de `shasum -a 256 dist/donly-proxy.js` (en un release público el hash ya está en sus notas).
