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
