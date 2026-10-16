# Fixtures de Evolution 2.3.7

- `participants.json`: respuesta real de `group/findGroupInfos`; evidencia explícita
  `id @lid` ↔ `phoneNumber`, con roles admin/superadmin.
- `text-group.json`, `text-private.json`, `audioMessage.json`, `imageMessage.json`,
  `documentMessage.json`, `reactionMessage.json`: webhooks originales capturados.
- `history.json`: respuesta REST original de `chat/findMessages`, que incluye las
  citas, menciones y el `pong` real confirmado por el dueño. Se conserva como REST,
  sin fabricar envelopes de webhook. La cita del mensaje propio permite probar
  reconciliación con una entrega real.
- `manifest.json`: procedencia y SHA-256 de los archivos fuente privados.

Solo se conservan campos necesarios. JIDs e IDs se sustituyen consistentemente;
se retiran credenciales, bytes, metadatos criptográficos y nombres personales.
Las fuentes originales viven bajo `.local/` con acceso restringido, fuera de Git.
Los tests distinguen fixtures originales de modificaciones sintéticas destinadas
exclusivamente a simular errores. No se ha capturado un voto nativo.
