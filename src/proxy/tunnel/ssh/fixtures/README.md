# Llave SSH de pruebas

`id_ed25519` / `id_ed25519.pub` es un par ed25519 sin passphrase, generado solo para las pruebas de `ssh_pass`: las pruebas la pasan como identidad (`ssh -i`) a un servidor sshd falso o local; **nunca debe usarse fuera de las pruebas** (la clave privada es pública en el repo, no autentica nada real).
