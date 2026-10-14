# Errores conocidos

Problemas que ya se han visto al usar donly-proxy, con su síntoma, causa, cómo reproducirlos y
cómo salir de ellos. Los hosts de los ejemplos son ficticios (`servicio.example.com`).

| Error | Resumen |
| --- | --- |
| [`tlsv1 alert protocol version` / cuelgue tras `Client hello`](tls-alert-protocol-version.md) | `curl: (35)` o `curl` colgado justo después de un `CONNECT` con `200`. Causa confirmada: Bun 1.3.x no completa el handshake TLS sobre el socket del túnel; corregido. |
