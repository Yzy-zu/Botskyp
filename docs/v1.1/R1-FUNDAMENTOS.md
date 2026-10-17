# R1 — Fundamentos persistentes

Estado: implementación aislada en `feat/v1.1-natural-router`, desde
`0c1a19ef919f759ac65bee7117ec26c2d70a286b`. Sin despliegue, merge ni R2.

Plan previo:
1. Congelar baseline con tag anotado v1.0.0 y trabajar solo en la rama autorizada.
2. Inspeccionar 001–010 y añadir 011 sin modificar migraciones aplicadas.
3. Persistir turnos independientes de la retención de inbox.
4. Crear ledger con dedupe por proveedor, efecto e identidad interna; linaje separado.
5. Crear artifacts con FKs reales, ámbito y expiración consultada en runtime.
6. Añadir contratos ToolResult, SafeRefs y SemanticTime sin conectar herramientas.
7. Preservar contexto REST Gemini y preparar function results sin loop v2.
8. Validar flags/cuotas conservando defaults; pruebas focalizadas y checks estáticos.
9. Documentar schema, diferencias y evidencia; commit/push y detenerse.

## Baseline y alcance

`main` y `origin/main` se verificaron limpios e idénticos al baseline aprobado.
No existía `v1.0.0`: se creó anotado en ese commit y se publicó sin reescribir
historia. R1 no ejecuta scripts de despliegue/migración de producción, no cambia
Evolution, `.env` activo, servicios ni WhatsApp. Migraciones solo en BD de tests.
Compose versionado reenvía las cinco variables nuevas con defaults históricos;
solo se valida su configuración en lectura, sin aplicarla a contenedores.
Esta instrucción del dueño prevalece sobre los pasos históricos de deploy/merge
por fase; no se modifica la historia de Fases 0–8.

## Schema final real de 011

Único archivo SQL nuevo: `src/db/migrations/011_v1_1_natural_router.sql`.
001–010 permanecen idénticas. Es aditiva: nuevas tablas, funciones, triggers,
columna y constraints, con backfill de la columna nueva. No borra datos ni cambia
columnas/statuses previos. Se prueba upgrade con filas anteriores y conservación
de todos sus campos. El migrador transaccional existente aplica checksum y lock.

### message_turns e inbox

| Campo message_turns | Tipo/regla |
|---|---|
| id | uuid PK, default gen_random_uuid() |
| chat_id | text NOT NULL, chat del envelope original |
| resolved_chat_id | text NOT NULL, chat canónico de procesamiento |
| provider_msg_id | text NOT NULL, clave dedupe existente con namespace INSTANCE |
| source_message_id | text NOT NULL, payload.id original |
| created_at | timestamptz NOT NULL, default now() |

UNIQUE `(chat_id,provider_msg_id)`, `(id,chat_id,provider_msg_id)` y
`(id,resolved_chat_id,source_message_id)`. Sin FK hacia inbox/seen_events efímeros ni
hacia chats: también se reciben mensajes de habilitación antes de crear el chat.

`inbox.turn_id uuid NOT NULL`, índice UNIQUE y FK compuesta
`(turn_id,chat_id,provider_msg_id)` → message_turns. Backfill de todas las filas
existentes antes de NOT NULL. El trigger BEFORE INSERT registra/reutiliza turno
y asigna el UUID; BEFORE UPDATE impide cambiar identidad. No añade DEFAULT UUID
volátil a cada reintento. `processNext()` lee la fila y entrega `turnId` en su
contexto, tanto al router legado como a actividad; nunca lo genera en memoria.
El campo de contexto es opcional para callers legados que no vienen de inbox.
En privado, processNext conserva la resolución existente de actorFor/@lid y
registra el chat resultante en resolved_chat_id, dentro de la misma transacción.
Inbox conserva el chat crudo y su FK; executions/artifacts referencian el chat
resuelto. No se cambian reglas de identidad/permisos ni se expone el JID a Gemini.
Una futura reidentificación que choque con evidencia ya referenciada falla por FK,
sin reescribir historia automáticamente.

Para payloads históricos sin `id`, el backfill usa provider_msg_id como fuente
conocida; no inventa otro identificador. Los mensajes normalizados de producción
siempre tienen `id`. Cambiar la fuente del mismo envelope se rechaza. La tabla
durable queda fuera del cleanup v1; requiere una política futura explícita de
retención junto con el ledger. No se crea un FK que impida limpiar inbox.

### tool_executions

| Campo | Tipo/regla |
|---|---|
| id | uuid PK, default gen_random_uuid() |
| turn_id | uuid NOT NULL; FK compuesta con chat/source a message_turns |
| call_origin | text NOT NULL: llm, fast_path, session, internal |
| provider_call_id | text nullable no vacío; solo llm puede tenerlo |
| execution_key | text NOT NULL no vacío, UNIQUE |
| source_message_id, chat_id, actor_id | text NOT NULL |
| tool_name | text NOT NULL no vacío |
| risk_level | text NOT NULL: read, write, destructive (nombres reales v1) |
| args_hash | text NOT NULL, SHA-256 hexadecimal de 64 caracteres |
| status | text NOT NULL: ok, denied, needs_confirmation, needs_clarification, not_found, queued, uncertain, error |
| result_json | jsonb NOT NULL default {} |
| parent_execution_id | uuid nullable, FK de linaje, distinto de sí mismo |
| logical_action_id | uuid NOT NULL default gen_random_uuid() |
| created_at | timestamptz NOT NULL default clock_timestamp() |
| finished_at | timestamptz nullable, no anterior a created_at |

Dedupe UNIQUE `(chat_id,actor_id,source_message_id,tool_name,args_hash)` y UNIQUE
parcial `(turn_id,provider_call_id) WHERE provider_call_id IS NOT NULL`.
Índices normales de linaje `(logical_action_id,created_at,id)` y padre.
FK del padre incluye `(parent_execution_id,logical_action_id,chat_id,actor_id)`
para impedir unir confirmaciones ajenas. Trigger preserva identidad y terminales;
si el padre requiere confirmación exige turno nuevo y misma tool/hash.
`queued`/`uncertain` pueden resolverse, sin modificar su identidad.

`executionKey()` valida y calcula SHA-256 sobre versión, turno, chat, actor,
mensaje, tool, hash, origen y provider ID opcional. No depende de reloj o random.
El hash de args reutiliza la canonicalización existente de sesiones (ordena
objetos recursivamente; conserva arrays). Las tres claves son complementarias:
un retry con otro provider ID/origen también choca con la clave del efecto.
No hay función que ejecute tools ni resuelva automáticamente un conflicto como
éxito; eso corresponde al executor futuro. Un child debe copiar explícitamente
el logical_action_id del padre, no usar el default de una raíz nueva.

### chat_artifacts

| Campo | Tipo/regla |
|---|---|
| id | uuid PK, default gen_random_uuid() |
| chat_id | text NOT NULL FK chats(id) |
| actor_id | text NOT NULL |
| turn_id | uuid NOT NULL; FK compuesta con chat/source a message_turns |
| source_message_id | text NOT NULL |
| media_attachment_id | uuid nullable, FK compuesta con chat/actor al backing real |
| school_attachment_id | uuid nullable, FK compuesta con chat/actor al backing real |
| parent_artifact_id | uuid nullable, FK compuesta con chat/actor a chat_artifacts |
| kind, mime | text NOT NULL |
| created_at | timestamptz NOT NULL default clock_timestamp() |
| expires_at | timestamptz NOT NULL, posterior a created_at |

CHECK exactamente un backing no NULL y padre distinto de sí mismo.
UNIQUE `(id,chat_id,actor_id)` permite FK del padre aislada por ámbito.
Índice B-tree `(chat_id,actor_id,created_at DESC,id DESC,expires_at)` e índice
normal por parent_artifact_id. No hay índices parciales de expiración.
`lastChatArtifact()` implementa la base de A_LAST con expiración en query,
backing vigente y bytes disponibles. Empates usan ID para orden estable.

Backing escolar **sí existe** en 004: `school_attachments.id uuid`, chat_id text,
owner_id text. Multimedia en 007: `media_attachments.id uuid`, mismos tipos de
ámbito. Se agregan UNIQUE `(chat_id,owner_id,id)` a ambas tablas para FKs reales
que además comprueban ownership. No se crea UUID escolar flotante ni tabla
escolar inventada. Las FKs no tienen ON DELETE CASCADE; no borran historia.

## Diferencias y límites documentados

- Se añade message_turns durable porque inbox se limpia a los 30 días. Una FK
  directa del ledger a inbox habría bloqueado el cleanup v1 o perdido evidencia.
- Se distinguen chat del envelope y chat resuelto: v1 ya canonicaliza privados
  con aliases verificados. El turno persiste ambas identidades sin cambiar resolución.
- El ID inbox.provider_msg_id ya es hash con INSTANCE; el mensaje crudo está en
  payload.id. Se reutilizan ambos exactamente con funciones distintas.
- El índice parcial temporal de la especificación se sustituye por B-tree normal.
- Hay backing escolar UUID compatible; se integra con FK real más ownership.
- El adapter es REST, no SDK. Se corrige la pérdida de call.id en parsing y se
  conserva content entero; no se implementa tool loop ni se cambian modelos.
- El contrato ToolResult nuevo coexiste con el legado; las 98 tools no se migran.
- SafeRefs es infraestructura de snapshots de datos confiables. No sustituye
  loaders/permisos ni tiene integración en prompts o tools v1.
- La configuración de cuota solo permite reducir topes históricos en R1. No son
  límites publicados de la cuenta gratuita. Sin llamadas reales nuevas ni cobros.
- Los triggers de identidad hacen inmutables los turnos/ejecuciones aceptados;
  el ledger no promete exactly-once remoto sin un executor/reconciliador futuro.

## Contratos e invariantes probados

ToolResult valida ocho estados y datos tipados. SafeRefs prueba todos los once
tipos, SELF autenticado, aislamiento entre chat/actor, nombres duplicados,
referencias inexistentes/IDs/JIDs arbitrarios, personal sin ownership rechazado y
listado sin IDs reales. No elige candidatos aleatoriamente.

SemanticTime prueba 20 minutos; mañana 8 pm; mañana 8 ambiguo; noche 20:00;
12 am/pm; pasado rechazado; próximo viernes (también desde viernes); hoy a una
hora vencida; pasado mañana; fecha local explícita; entradas inválidas; formato
humano local sin UTC ISO. El reloj de prueba es fijo y backend.

Persistencia prueba upgrade real 001–010 → 011 con backfill, webhooks concurrentes,
rollback de processNext y retry con conexión nueva, identidad tras purgar inbox,
separación de mismo raw ID entre chats, dedupe concurrente para cuatro orígenes,
colisiones independientes de las tres claves, estados, FKs, linaje y terminal
needs_confirmation inmutable. Artifacts prueba cadena con backing escolar/media,
A_LAST, expiry propio/backing, bytes limpiados y separación por chat/actor.
Gemini prueba partes completas, campos desconocidos, thought/tool signatures,
IDs literales, llamada sin ID y cuerpo de una segunda petición simulada.
Los tres ROUTER_MODE producen pong v1 y no escriben el ledger.

## Evidencia automática final

Comandos ejecutados con Node 24 local (`.local/node/bin`):

```text
npm test -- tests/natural-foundations.test.ts tests/tool-result.test.ts tests/safe-refs.test.ts tests/semantic-time.test.ts tests/config.test.ts tests/llm.test.ts tests/persistence.test.ts tests/core.test.ts tests/reminder-time.test.ts tests/connection-cleanup.test.ts tests/startup.test.ts tests/restart.test.ts
```

Resultado: **172/172**, 12 archivos, 164,01 s. Después se añadió el caso privado
con @lid canónico y se repitieron únicamente los afectados por ese ajuste:

```text
npm test -- tests/natural-foundations.test.ts tests/persistence.test.ts tests/connection-cleanup.test.ts tests/core.test.ts
```

Resultado: **108/108**, cuatro archivos, 116,25 s. En total **173 pruebas distintas**
verificadas entre ambas rondas. No se ejecutó la suite completa de 700+ pruebas.
En la primera ronda preliminar falló una fixture que hacía coincidir creación y
expiración del artifact; se corrigió la fixture para representar expiración válida
anterior al reloj actual. No se relajó el CHECK de schema. Typecheck preliminar
se corrigió anotando DateTime y el tipo string de IDs de fixtures.

Comprobaciones finales: `npm run typecheck`, `npm run lint`, `npm run build`,
`npm run audit:secrets`, `git diff --check` y `docker compose config --quiet`
correctas. Sin dependencias nuevas. Auditoría del árbol versionado: cero archivos
con hallazgos; no se reescribe ni se declara saneado el historial heredado.
Los tests usan PostgreSQL 17 aislado con nombre botsky_test_, proveedores mock y
fixtures sintéticas; no envían WhatsApp ni peticiones reales a Gemini.

Se conserva main y el tag apuntando al baseline. No se ejecuta healthcheck como
prueba de R1 desplegada: no existe despliegue R1. No hay prueba manual de WhatsApp
requerida para estos fundamentos desconectados. Las pruebas del router/loop real,
la política y la migración a producción corresponden a etapas futuras autorizadas.
No se solicita ninguna acción del dueño. Al publicar esta rama el constructor se
detiene, sin R2 ni merge.
