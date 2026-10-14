# Errores conocidos

Problemas que ya se han visto al usar donly-proxy, con su síntoma, causa, cómo reproducirlos y
cómo salir de ellos. Los hosts de los ejemplos son ficticios (`servicio.example.com`).

| Error | Resumen |
| --- | --- |
| [`tlsv1 alert protocol version`](tls-alert-protocol-version.md) | `curl: (35)` justo después de un `CONNECT` con `200`: el handshake TLS con el proxy falla. Causa sin confirmar; incluye lo no reproducido y cómo diagnosticar. |
