# donly-proxy
Proxy for donly: continuation of the demo proxy

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

Para actualizar, vuelve a ejecutar el comando de descarga.

## Fórmula local de Homebrew (desarrollo)

Para probar la instalación vía Homebrew sin publicar un tap, crea un tap local y coloca ahí la fórmula.

1. Crea el tap local (una sola vez):

```sh
brew tap-new $USER/local
```

2. Calcula el hash del bundle de la versión que quieres probar:

```sh
curl -fL https://github.com/JonDotsoy/donly-proxy/releases/download/v0.0.3/donly-proxy.js | shasum -a 256
```

3. Crea `$(brew --repository)/Library/Taps/$USER/homebrew-local/Formula/donly-proxy.rb` con este template; **solo debes cambiar el `sha256`** (y `version`/`url` si pruebas otra versión):

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

> Si el release no es público aún, genera el bundle con `bun run build` y usa `url "file:///ruta/absoluta/dist/donly-proxy.js"` junto con el hash de `shasum -a 256 dist/donly-proxy.js`.
