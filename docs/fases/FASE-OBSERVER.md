# Observer temporal — caja negra v1.1

Baseline: `73ee8b8`, rama `phase-observer-flight-recorder`. No merge a main.
Autorización: petición BOTSKY 2 — TEMPORARY FLIGHT RECORDER / OBSERVER.

## Operación

`OBSERVER_ENABLED=true` por defecto, retención siete días, presupuesto de spool
512 MiB compartido y segmentos de hasta 16 MiB. App y worker montan el volumen
Docker `botsky_botsky_observer` en `/var/lib/botsky-observer`; no se elimina al
recrear contenedores ni al ejecutar el deploy oficial. Nunca ejecutar `down -v`
para operar el recorder. Directorio 0700 y archivos 0600, usuario node.

Cada evento tiene UUID estable, hora UTC, identidad del proceso y commit inyectado
por deploy. `sequence` combina reloj de alta resolución del host, instancia y
ordinal: el orden total reproducible es `(sequence,event_id)`. App y worker usan
el mismo host/reloj; turnId/sourceMessageId/jobId enlazan las fronteras asíncronas.
Un reloj del host corregido hacia atrás puede afectar el orden cronológico entre
procesos; IDs, etapas y ordinal por proceso siguen disponibles para reconstruirlo.

Primero se redacta una copia; después se añade una línea JSONL con fsync y se
reproduce hacia PostgreSQL usando **otro pool**, máximo una conexión, con timeouts
cortos. El consumidor escribe lotes pequeños con `ON CONFLICT(event_id) DO NOTHING`.
El checkpoint `.ack` solo avanza después de confirmar INSERT y se guarda con
fsync/rename. Dos consumidores pueden repetir lecturas: PostgreSQL deduplica.
Una cola secundaria de hasta 1000 eventos y 2 MiB permite intentar PostgreSQL si el disco
falla. No hay retry de tools, Gemini ni mensajes por parte del observer.

`observer_events` es la fuente append-only: solo INSERT; DELETE se reserva a
retención. `observer_turns` es una vista reconstruible. No hay FK a negocio que
pueda esperar el commit del turno o desaparecer con su rollback. Los recibos antes
de commit dicen `pending_commit`; los eventos de COMMIT/ROLLBACK determinan si
hubo efecto. Una ausencia de commit tras un crash expresa incertidumbre.

## Cobertura

- Ingreso aceptado: cuerpo Evolution sin headers, Msg completo y texto literal.
- ContextV2 serializado/envelope, manifest y hash, SafeRefs públicas e IDs internos,
  sesión, artifacts CURRENT/REPLIED/RECENT, dominios y schemas expuestos.
- Llamadas lógicas y cada intento Gemini: input, sistema, herramientas, modelo,
  ordinal, inicio/fin/latencia, respuesta estructurada cruda previa a Zod, usage,
  finish reason, block reason y thought signatures. Los errores HTTP conservan
  estado y Retry-After; el cuerpo 400 ya leído por el adapter se conserva también.
  No se consume un cuerpo adicional que el adapter normalmente descarta.
- Propuestas, ampliaciones de capability, args originales/adaptados/resueltos,
  Policy, permisos/riesgo/confirmación, decisiones y recibos de handlers.
- Lecturas SessionV2 y estados completos devueltos por sus escrituras; creación,
  aclaración, confirmación, cancelación y expiración. RETURNING no cambia el efecto.
- Registro/selección/fallos de artifacts, referencias al almacenamiento original,
  metadatos y hash de resultados multimedia; sin copiar bytes/base64.
- Recibos de las tools de notas, memoria, recordatorios, encuestas, moderación,
  escuela, economía, Minecraft, Drive y biblioteca. XP registra además saldo
  antes/después y referencia de ledger. No se intercepta ni analiza SQL en runtime.
- Jobs media/Drive y su recuperación, subprocess multimedia y stdout/stderr acotado,
  resultado persistido y outbox; sincronización de biblioteca y gateway Minecraft.
- Outbox: payload, sanitizer antes/después, intento, resultado Evolution, ID saliente,
  reconciliación y estado persistido. Las rutas descartadas también se fotografían.
- Métricas del router, errores/stack redactados y commits/rollbacks independientes.

## Exportación local

Desde el VPS, en el repo:

```bash
npm --silent run observer:turn -- <turnId> > .local/turno.md
npm --silent run observer:user -- '<jid>' --since 2h > .local/usuario.md
npm --silent run observer:chat -- '<jid>' --since 6h > .local/chat.md
npm --silent run observer:errors -- --since 24h > .local/errores.md
npm --silent run observer:turn -- <turnId> --json > .local/turno.json
npm --silent run observer:health
```

El script usa un contenedor efímero separado, sin iniciar Botsky, para aislar la
memoria del exportador de la app productiva. Los exports combinan DB y spool, deduplican UUID y ordenan la timeline. Un export
de errores incluye el turno completo, no solo la excepción. Funciona con PostgreSQL
caído mientras el spool sobreviva. También se puede ejecutar el CLI compilado
con Node dentro del VPS/contenedor. No existen endpoints ni comandos WhatsApp de
consulta. Los archivos solo se comparten cuando el dueño los copia explícitamente.

Para una redirección de shell, usar `.local/` (0700) y `umask 077`. La opción `--out`
del CLI escribe dentro del contenedor, por lo que se recomienda redirigir stdout
desde el host como muestran los ejemplos.

## Fallos y retención

Cualquier error de construcción/redacción/serialización/disco/INSERT/replay queda
contenido. Se informa degradación local sin imprimir secretos ni el evento fallido.
Si se agotan ambos sinks o el disco está lleno, se puede perder evidencia: el bot
sigue trabajando. No se promete persistencia imposible sin un sink disponible.
No se borran segmentos pendientes para liberar espacio. Una cola cortada por crash
se conserva, no se confirma una línea incompleta, y los siguientes archivos siguen
procesándose. El límite global es aproximado por la concurrencia de dos escritores.

Cada hora se eliminan por lotes eventos anteriores a la retención y segmentos
antiguos completamente confirmados. Los pendientes se conservan aunque excedan
siete días. Esta limpieza jamás toca archivos/artifacts del negocio. El borrado de
PostgreSQL está acotado por lote y timeout; un atraso se recupera en ciclos futuros.

Apagar: establecer `OBSERVER_ENABLED=false` en entorno y recrear app/worker mediante
el deploy oficial. No exige recompilación de TypeScript; no se construyen payloads
ni se abren sinks al estar apagado. No se envía el recorder a Gemini ni a otro
servicio externo. Secrets técnicos y valores reales configurados se redactan
centralmente, conservando el texto conversacional normal.

Contratos verificados: [Node fsync/append](https://nodejs.org/docs/latest-v24.x/api/fs.html),
[PostgreSQL INSERT](https://www.postgresql.org/docs/17/sql-insert.html),
[volúmenes Docker](https://docs.docker.com/engine/storage/volumes/).
