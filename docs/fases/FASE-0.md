# Fase 0 — Esqueleto

**Estado: núcleo de Fase 0 implementado y operativo en Botsky Lab.**
El dueño confirmó `bot ping` → `pong`. La app usa Evolution real y su webhook
apunta directamente a `http://botsky-app:3000/webhook`; el capturador quedó detenido.
El cierre completo sigue pendiente de revisión del arquitecto y respaldo/restauración
externos. Rama `phase-0-esqueleto`, sin fusión a `main`, sin Fase 1 ni grupos reales.

## Plan previo
1. Verificar Evolution 2.3.7 y contrato instalado contra fuentes oficiales.
2. Respaldar configuración del webhook y capturar únicamente laboratorio/owner.
3. Crear TypeScript estricto, Fastify, configuración validada y PostgreSQL 17 propio.
4. Persistir recepción y dedupe juntos; procesar ping en orden por chat.
5. Persistir outbox, separar reintentos seguros de envíos inciertos y reconciliar.
6. Añadir worker de concurrencia 1, mock y fixtures reales anonimizados.
7. Verificar reinicios, duplicados, aislamiento, mensajes viejos y fallos de entrega.
8. Desplegar con respaldo, probar rollback controlado y restauración aislada.
9. Documentar evidencia y solicitar revisión del arquitecto antes de fusionar.

## Implementado y validado

- Node 24, TypeScript estricto, Fastify 5, Zod 4 y SQL parametrizado con `pg`.
- App y worker separados, imágenes ARM64, límites de CPU/RAM, logs sin cuerpos,
  credenciales ni cabeceras. Worker único; no hay tipos de trabajo pesado habilitados.
- PostgreSQL 17 dedicado, volumen propio y red interna. Alias exclusivo `botsky-db`;
  no se reutiliza el PostgreSQL 15 ni Redis de Evolution.
- Migración inicial SQL transaccional, bloqueo de migración y checksum de archivos.
- Webhook autenticado con secreto en cabecera; inbox y dedupe en una transacción
  antes del 200. El procesamiento y creación de respuesta en outbox son atómicos.
- Activación Unicode determinista y `ping` → `pong` sobre mensajes normalizados.
- Chats habilitados; solo el laboratorio puede habilitarse en Fase 0. Privados:
  dueño, aprobación manual o pertenencia activa comprobada; desconocidos en silencio.
- Normalización de webhooks reales: texto privado/grupo, adjuntos y reacción. Cita y
  mención verificadas también con registros REST originales; no se mezclan textos citados.
- Fixture real anonimizado de participantes/admins; asociación `@lid` solo con
  `phoneNumber` aportado por el proveedor y sin aceptar conflictos de identidad.
- Outbox persistente, ritmo por chat, reintentos de rechazos seguros y recuperación
  de envíos interrumpidos como `uncertain`. Sin reenvío ciego; alerta honesta al dueño.
- Mock REST alimentado con fixtures originales y transporte con fallos inyectables; en la prueba de reinicio su estado se
  persiste separado de la app, representando un proveedor que sobrevive a ella.
- Backup verificado, restauración en una BD nueva, emergencia persistida y scripts
  de despliegue con rollback a imagen/configuración anteriores por ID inmutable.

## Inspección y contrato de Evolution

El 16/10/2026 se verificaron mediante REST autenticado:

| Capacidad | Evidencia / contrato |
|---|---|
| Versión instalada | `GET /`: 2.3.7; imagen local `botsky/evolution-native-tables:2.3.7-c1` |
| Conexión | `GET /instance/connectionState/botsky`: `open` |
| Laboratorio y roles | `GET /group/findGroupInfos/botsky?groupJid=…`: bot admin, dueño superadmin |
| Webhook previo | `GET /webhook/find/botsky`: JSON `null` |
| Webhook con cabecera | `POST /webhook/set/botsky`, cuerpo `{webhook:{enabled,url,headers,byEvents,base64,events}}`; configuración releída |
| Enviar texto | Verificado `POST /message/sendText/{instance}`: cuatro entregas reales, citadas, con ID del proveedor |
| Consultar historial | Verificado `POST /chat/findMessages/{instance}`: `messages.records`, `key.fromMe`, texto y `contextInfo.stanzaId`; reconciliación por cita exacta |
| Participantes | Documentado `GET /group/participants/{instance}?groupJid=…`; snapshot real obtenido por `findGroupInfos` |
| Expulsar | Documentado `POST /group/updateParticipant/{instance}?groupJid=…`, `action=remove`, `participants`; NO ejecutado |
| Invitación | Documentados `GET /group/inviteCode/{instance}` y `GET /group/acceptInviteCode/{instance}`; NO ejecutados |

Fuentes oficiales consultadas:
- [OpenAPI vigente](https://github.com/EvolutionAPI/docs-evolution/blob/main/openapi/openapi-v2.json).
- [Código de webhook en 2.3.7](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/integrations/event/webhook/webhook.controller.ts).
- [DTO de mensajes en 2.3.7](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/dto/sendMessage.dto.ts).
- [Orden de inicio de Compose](https://docs.docker.com/compose/how-tos/startup-order/).
- [Imagen oficial de PostgreSQL y ARM64](https://hub.docker.com/_/postgres).
- [Transacciones con pg](https://node-postgres.com/features/transactions).

OpenAPI aún declara 2.1.1 y difiere del código 2.3.7 para webhook. Se verificó el
contrato del código y su aceptación real; no se asumió el cuerpo antiguo del OpenAPI.
El adaptador real se implementó después de obtener capturas y respuestas REST
originales. Las fuentes se identifican en `tests/fixtures/manifest.json`.

## Cambio mínimo y reversible del webhook

El estado anterior se conserva en `.local/webhook-before.json` (600, fuera de Git).
Solo se modificó el webhook local de `botsky`:

- `enabled=true`; URL final `http://botsky-app:3000/webhook`. El capturador
  `http://botsky-capture:3001/webhook` se usó temporalmente y quedó detenido.
- `byEvents=false`, `base64=false`.
- Cabecera `x-webhook-secret`, generada localmente; no se pone en la URL.
- Eventos `MESSAGES_UPSERT`, `SEND_MESSAGE`, `CONNECTION_UPDATE`,
  `GROUP_PARTICIPANTS_UPDATE`.

Primero se probó una URL sobre la pasarela del host. Al fallar la conectividad
contenedor→host, se sustituyó únicamente esa URL por el nombre del capturador en
la red existente. Se verificaron `GET /health` y `POST /webhook` autenticado desde
el propio contenedor Evolution, ambos HTTP 200. El probe no se guarda como fixture.
Durante la captura, el registrador filtró laboratorio/privado del dueño y
eliminó credenciales, claves multimedia, URLs y bytes antes de guardar. Al exportar
fixtures se aplica además una lista explícita de campos permitidos, retirando
metadatos criptográficos de mensajes y anonimizando JIDs/IDs.
Los eventos quedan bajo `.local/captures/` (archivos 600). No se imprimen cuerpos.

Reversión: `python3 scripts/evolution-admin.py restore`. La API conserva una fila
deshabilitada cuando originalmente devolvía `null`; equivale a no emitir webhooks.
No se reinició Evolution ni se modificaron sus archivos, sesión o Redis. No se
accedió directamente a su BD; el único cambio persistente autorizado fue el
webhook mediante la API.
La autenticación fallida por alias DNS del despliegue inicial está registrada en
`docs/INCIDENTES.md`; no llegó a ejecutar migraciones sobre Evolution.

## Operación y recuperación

- `scripts/deploy.sh`: backup previo, actualización de rama si tiene upstream,
  build, migración, arranque y healthcheck de app/worker. Guarda configuración resuelta
  privada e imagen inmutable. Bootstrap de BD vacía solo en el primer despliegue.
- `--database-only`: crea/verifica únicamente la BD dedicada y su respaldo.
- `--capture`: inicia únicamente el capturador diagnóstico tras verificar respaldo.
- `--test-rollback`: construye una imagen distinta, provoca salida 42 de la app y
  comprueba el fallo real de salud y el retorno a los servicios anteriores.
- `scripts/backup.sh`: dump custom, lectura con `pg_restore --list` y SHA-256.
- `scripts/restore-test.sh backups/botsky-….dump`: crea una BD con nombre nuevo;
  no puede sobrescribir producción. La conserva para inspección.
- `scripts/panic.sh`: guarda emergencia en BD y detiene solo app/worker.
- El despliegue sano programa un backup local diario a las 09:17 del host sin
  reemplazar otros trabajos del dueño. Backups y logs operativos son privados.

El `.env` heredado contenía separadores inválidos para Compose. Se preservó completo
como `.local/legacy-env-backup.json`; el activo usa solo las variables de Fase 0.
La configuración de Gemini y otras credenciales heredadas no se utilizan.
Node 24 local se descargó del sitio oficial y se verificó con SHA-256 en `.local/`;
no se sustituyó Node 20 del sistema. El capturador diagnóstico usa la imagen Node 20
que ya existía; app y worker ejecutan Node 24.

## Evidencia real y límites de cierre

- El dueño envió los eventos solicitados y confirmó un `pong` en Botsky Lab.
- Se registró esa respuesta en outbox `sent`, un intento, con ID del proveedor.
- Se encolaron deliberadamente tres respuestas diagnósticas, cada una citando un
  mensaje real distinto del laboratorio. Tras la primera se interrumpió la app con
  SIGKILL y se volvió a iniciar. Las tres quedaron `sent`, un intento por fila y
  exactamente una coincidencia por cita en el historial real de Evolution.
- `docker kill` suprime el reinicio automático por tratarse de una parada manual;
  el simulacro se completó con inicio explícito. No se cambió la política
  `unless-stopped`, necesaria para que el apagado de emergencia permanezca detenido.
- El replay de un webhook original de audio viejo devolvió `ignored` y no creó
  outbox. La ráfaga HTTP/inbox con SIGKILL también está cubierta por tests aislados.
- `/health` real: base de datos y Evolution `true`; app y worker sanos.
- El capturador, su reenvío temporal y la excepción estrecha de firewall se retiraron
  del recorrido activo. Evolution no se reinició; no se alteraron su sesión o BD
  salvo la configuración autorizada del webhook mediante su API.
- Un conflicto nuevo de alias suspende su uso para privilegios, conservando el
  vínculo previo para revisión; nunca se reasigna a otra persona automáticamente.

Pendientes que impiden declarar cerrada toda la fase:

1. Revisión del arquitecto sobre identidad, dedupe/outbox, redes, scripts y recuperación.
   La PR permanece sin aprobar y no se fusiona.
2. Configurar copia externa en Drive. No hay `rclone`/remoto autorizado disponible;
   los respaldos diarios locales sí están instalados y verificados. Se conservan
   todas las copias; queda pendiente aplicar la política de siete copias.
3. Restauración en un VPS de pruebas con identidad SSH verificada. Se probó en una
   base aislada del mismo VPS. El candidato `jssi-1` no tiene clave de host conocida
   localmente; la conexión con verificación estricta se rechazó, sin aceptarla a ciegas.

Pruebas manuales opcionales restantes: mención real `@Botsky ping` y respuesta a un
`pong` citándolo con `ping`; ambas rutas pasan pruebas automáticas con datos reales.
No se capturó voto nativo ni se habilitó su procesamiento (corresponde a fases posteriores).
No se implementan Gemini, tools, sesiones, multimedia, XP ni funciones de Fase 1.

## Corrección de revisión — cuatro hallazgos

1. Probar y corregir FIFO ante incertidumbre agotada, conservando su registro.
2. Llevar identidades operativas a configuración privada y auditar el árbol/diff actual.
3. Iniciar Fastify aunque falle el primer refresco de Evolution; probar recuperación periódica.
4. Limpiar únicamente bases de tests estrictamente identificadas, sin conexiones activas.
5. Ejecutar validaciones completas, desplegar por el script, verificar salud y actualizar la misma PR.
No se fusiona ni se inicia Fase 1; se devuelve al arquitecto para nueva revisión.

### Resultado de las correcciones (2026-10-16)

- FIFO: un `uncertain` con intentos agotados deja pasar mensajes posteriores del
  mismo chat. Se conserva la fila incierta para diagnóstico; con intentos disponibles
  sigue bloqueando. Regresiones en el límite y por encima del límite.
- Scripts administrativos: identidades en entorno/`.env`; mapa del exportador en
  `.local/fixture-identities.json` o parámetro privado. El árbol actual y las líneas
  añadidas contra `main` no contienen las identidades reales conocidas ni JIDs largos
  literales. Las versiones históricas anteriores se conservan sin reescritura.
- Arranque: falla inicial de miembros produce advertencia y Fastify inicia. Salud
  degradada 503; al recuperarse Evolution, el refresco periódico sincroniza y salud 200.
- Tests: teardown de la base de cada ejecución; recogida de bases inactivas de más
  de 24 horas, con patrón estricto y verificaciones del PostgreSQL dedicado.
- Typecheck, lint, build y suite completa: 71 pruebas en 10 archivos. Incluyen
  reinicio SIGKILL, dedupe, reconciliación y limpieza real de bases aisladas.
- Desplegado `9d1b422` mediante `scripts/deploy.sh`, respaldo previo verificado.
  App, worker y PostgreSQL sanos; `/health` HTTP 200 con base y Evolution `true`.
  Evolution sigue `open`; no se cambió su webhook, sesión ni base de datos.
- No hacen falta nuevas acciones manuales para validar estas cuatro correcciones.
  PR #1 actualizada en la misma rama; pendiente nueva revisión, sin fusión ni Fase 1.
Los pendientes externos anteriores de copia y restauración siguen sin cambio.
