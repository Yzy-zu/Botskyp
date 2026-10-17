# Botsky v1.1 — Natural-First

Arquitectura aprobada conceptualmente por el dueño el 17-10-2026:

```text
Lenguaje natural → Gemini (intención/tool) → Policy Engine backend
→ Tool Executor → ToolResult → Presenter/LLM → WhatsApp
```

El backend conserva autoridad sobre identidad, chat, membresía, permisos,
propiedad, dinero, fechas, confirmaciones y efectos. Gemini recibe referencias
opacas y semántica; nunca necesita JIDs reales. El resultado debe demostrar
qué ocurrió en el turno actual antes de afirmar un efecto al usuario.

R1 introduce persistencia y contratos. R2 añade un catálogo v2 declarativo de
las 98 tools, 96 visibles/dos internas, más `core.load_capability`, selección
dinámica con máximo 20 schemas, Fast Path exacto independiente y shadow sin
ejecución. R3 añade Policy Engine read-only, executor aislado, confirmaciones con dos
turnos y ledger real. R4 añade contexto estructurado, Artifact Chain y Session v2. R5 conecta esos
componentes con Gemini function calling y Composer v2 exclusivamente cuando
ROUTER_MODE=v1_1. La producción conserva su configuración; no hay despliegue R5.
Detalle en [R2-TOOL-REGISTRY](R2-TOOL-REGISTRY.md) y
[R3-POLICY-ENGINE](R3-POLICY-ENGINE.md).

## Identidad y veracidad

Un turno identifica un mensaje recibido, no una ejecución ni una sesión.
`message_turns` conserva su identidad después de la retención de `inbox`.
Cada ejecución referencia turno, chat resuelto y mensaje real con FK compuesta.
El registro conserva además el chat crudo del envelope; processNext anota el chat
canónico usando la resolución privada existente de v1, sin cambiar permisos.
`source_message_id` es `payload.id`; `provider_msg_id` es la clave de dedupe
existente: SHA-256 de `[INSTANCE, chatId, msg.id]`. No se confunden estos IDs
con el ID de function call de Gemini.

Tres barreras complementarias en el ledger:

- `execution_key`: identidad interna determinista para los cuatro orígenes.
- `(turn_id, provider_call_id)`: misma llamada del proveedor, si existe ID.
- `(chat_id, actor_id, source_message_id, tool_name, args_hash)`: mismo efecto
  solicitado por un mensaje, aunque cambie ID del proveedor u origen del retry.

Las llamadas del proveedor están delimitadas por turno; no se presupone que un
ID local del proveedor sea único entre conversaciones independientes. Los IDs
se conservan literalmente, sin normalización ni sustitución. Un modelo puede
omitir el ID; sigue habiendo las otras barreras. Fast path, sesión y callback
interno usan exclusivamente claves internas, con `provider_call_id=NULL`.

Un `needs_confirmation` del turno 1 permanece inmutable. Aceptar en turno 2
crea una hija con el mismo `logical_action_id`, `parent_execution_id` y el
mismo chat, actor, tool y hash. Solo el resultado de esa hija puede justificar
el efecto del turno 2. Los estados terminales son inmutables; `queued` y
`uncertain` permiten registrar resolución sin alterar la identidad.

Estas constraints reservan identidad y evitan duplicar registros. El executor
R3 reclama antes de efectos, persiste resultados y conserva la incertidumbre;
el esquema por sí solo no promete exactly-once para servicios externos. `queued` demuestra encolado, nunca entrega. R1 no ejecuta ni registra
las herramientas v1 en este ledger.

## Contratos

`core/tool-result.ts` define `ToolResult<T>` y validación Zod para los ocho
estados de R1, tool, dominio, código, datos tipados, artifact opcional y síntesis
LLM opcional. Coexiste con el contrato legado de `core/tools.ts`; no lo reemplaza.

`core/safe-refs.ts` crea snapshots opacos desde registros confiables del backend.
Resuelve `SELF` desde el actor autenticado, y soporta member/artifact/note/
reminder/memory/poll/task/subject/drive/destination/op refs. Aplica chat siempre
y propiedad personal cuando corresponda; nombres duplicados exigen aclaración.
Las listas para el modelo contienen solo ref, tipo y etiqueta saneada de JIDs.
Resolver devuelve el ID únicamente al backend. No existe fallback de un texto
arbitrario a un ID. Estas refs no conceden permisos: cada loader y el Policy
Engine futuro deberán revalidar existencia, membresía, propiedad y permisos al
usar un snapshot. No se implementan loaders de las 98 tools en R1.

`modules/reminders/semantic-time.ts` acepta semántica estructurada, validada de
forma estricta, y un reloj backend explícito. Resuelve exclusivamente en
`America/Mexico_City`. No usa ISO generado por el modelo. Hora 1–12 sin periodo
produce aclaración; `24h` explícito elimina esa ambigüedad. Hoy/pasado nunca
se desplazan silenciosamente a mañana. Próximo día de semana es estrictamente
posterior (el mismo día significa siete días después). La presentación usa
fecha/hora local legible. La implementación previa de reminders no cambia.

## Contexto Gemini

El adapter actual usa `fetch` contra REST `v1beta/...:generateContent`.
`package.json` no contiene SDK Google: no hay preservación automática de sesión.
El esquema anterior conservaba campos extra de parts pero quitaba el `id` de
`functionCall` y campos extra de content. R1 conserva content, parts y function
calls completos con esquemas passthrough, incluidos `thoughtSignature`, `thought`,
campos desconocidos y orden. `LlmReply.providerContext` expone ese contenido
completo y los índices de parts que contienen function calls.

El loop futuro añadirá `providerContext.modelContent` íntegro a `contents` y
luego los function results, sin reconstruir `{name,args}`, combinar parts,
extraer/reubicar firmas ni reenviar thoughts como texto visible. El helper
`geminiFunctionResult` copia literalmente el `id` recibido a `functionResponse.id`;
si falta, lo omite. El helper no envía solicitudes ni implementa el loop.

La referencia REST oficial define el ID opcional y su correspondencia en
functionResponse, además de firmas opacas en parts. Se conserva el contrato
del endpoint instalado; las guías actuales priorizan Interactions, que no es
el endpoint usado aquí. No se cambian modelo ni API por esa diferencia.
Fuentes verificadas: [GenerateContent, Part, FunctionCall y FunctionResponse](https://ai.google.dev/api/generate-content#FunctionCall),
[Thinking: diferencias entre generateContent e Interactions](https://ai.google.dev/gemini-api/docs/thinking).
Los tests usan respuestas REST simuladas, firmas sintéticas y segunda solicitud
capturada; no se afirma validación del loop por Google ni nuevas llamadas reales.

## Configuración y activación

`ROUTER_MODE` valida `v1 | v1_1_shadow | v1_1`, default `v1`.
En R2, `v1` usa exclusivamente los shortcuts, declaraciones y ejecución legacy.
`v1_1_shadow` observa Fast Path v2, dominios, schemas y tamaño aproximado con
lecturas acotadas de contexto en R4, sin llamadas Gemini/efectos nuevos; la respuesta y ejecución
visibles continúan por v1. Desde R5, `v1_1` selecciona el router natural completo
en entornos controlados. No se activa en producción ni cambia `.env`. Los
shortcuts legacy no se modifican.

Cuotas configurables con defaults históricos: `LLM_USER_RPM=8`,
`LLM_GLOBAL_RPM=5`, `LLM_DAILY_LIMIT=20`, `LLM_INPUT_TOKENS_PER_MINUTE=65536`
y `LLM_RESERVED_INPUT_TOKENS=32768`. R2 acepta enteros positivos acotados hacia
arriba o abajo; falla rápido si son inválidos. Los aliases `GEMINI_*` de R1 se
conservan y `LLM_*` explícito prevalece. Reserva es fallback; el adapter v1 sigue
reservando según estimación, como antes. No se alteran valores reales de `.env`,
servicios ni cuota de proveedor. Compose versionado se prepara sin aplicarlo.

El catálogo v2 conserva todos los PermissionKey históricos (snapshot R1 en
`tests/fixtures/v1.1/permissions-r1.json`). Los dominios agrupan schemas, nunca
conceden permisos. Las tools restringidas relevantes pueden ser visibles para
members con metadata de restricción; admin irrelevante se omite por tokens.
La autorización final se implementa en R3 usando permitted() histórico.

La base definitiva contiene ayuda, crear nota, crear recordatorio, recordar
memoria, buscar web, saldo y daily, más la meta-tool. Se filtran módulos/scope,
excepto la meta-tool. Los dominios priorizan sesión, artifact, entidad activa,
señal léxica y admin; un representante por dominio evita monopolios, luego se
completan en prioridad hasta 20. `ToolExposureTurn` permite una expansión válida
por turno sin efectos y con el mismo tope. Los schemas explícitos usan SafeRefs
y SemanticTime; el traductor bloquea campos internos incluso anidados.

El Fast Path v2 solo devuelve propuestas de comandos exactos con vocativo.
Cualquier frase natural/parcial devuelve undefined. Memoria y notas compartidas
se distinguen en descripciones/pistas semánticas; v2 nunca ejecuta notes.create
por una frase de memoria en R2. El bug legacy permanece visible en v1/shadow
por la compatibilidad exigida. La decisión natural final se conecta en R5.

## Artifact chain

`chat_artifacts` describe un archivo respaldado por exactamente un adjunto
real de multimedia o escuela, con padre opcional del mismo actor y chat.
Permite original DOCX → PDF → PDF comprimido sin almacenar bytes duplicados.
Las FKs compuestas validan chat y propietario del backing. `A_LAST` es una
query backend ordenada por creación e ID, filtrada por chat, actor y
`expires_at>now()`, que además requiere backing con bytes y vigencia.
Un archivo expirado/limpiado nunca se devuelve aunque sus metadatos sigan vivos.

No hay predicado de índice dependiente del reloj; el índice B-tree normal
soporta búsqueda por chat/actor y orden reciente. PostgreSQL exige funciones
inmutables en índices, por lo que la expiración se consulta en runtime.
[Referencia PostgreSQL 17 CREATE INDEX](https://www.postgresql.org/docs/17/sql-createindex.html).


## Policy y executor R3

`policy-v2/executor.ts` mantiene privado el registry de negocio. La evaluación
pública reconstruye contexto desde inbox y no ejecuta handlers. La ejecución
pública reevalúa dentro de una transacción (la de inbox en R5 o una propia
para callers aislados); no acepta decisiones anteriores
como credencial. Los callers v2 no reciben un handler ni un dispatch sin policy.
El executor se invoca explícitamente en tests y desde el puente backend de
confirmaciones Session v2 R4 y el router natural R5. v1/v1_1_shadow rechazan
efectos aunque un caller invoque esa entrada. Solo v1_1 conecta Gemini a esa
autoridad; no habilita módulos, chats ni proveedores por sí mismo.

Orden: system → chat → module → identidad/membresía → permitted(PermissionKey)
→ SafeRefs vivas/scoped → ownership → business → economic → cooldown
→ confirmation decision → replay/admisión → confirmation gate → handler
→ normalización ToolResult → resultado durable en tool_executions.
Evaluación usa SELECT sin crear wallets ni reservar recursos; handlers conservan
sus transacciones/locks/colas como autoridad final de atomicidad.

La migración 012 añade request_hash (inmutable) e índice de propuesta para
replays después de un cambio de estado, unicidad de hija efectiva por acción y
un store tool_confirmations_v2 independiente de sessions. No se modifica 011 ni
el contrato visible legacy. La hija confirmada nace en un turno distinto con
el padre y logical_action_id de A; se revalidan identidad, permiso, módulo,
controles, recursos y cooldown y se recalcula hash canónico con ámbito/versiones.
Una fila needs_confirmation nunca se convierte retrospectivamente en éxito.

El ledger reclama uncertain/EXECUTION_IN_PROGRESS en la misma transacción que
la mutación DB o el encolado y el resultado. No añade status new a R1. Un lock
de admisión global evita carreras entre claves de dedupe; un savepoint revierte
mutaciones parciales al fallar el handler. No hay exactly-once universal externo:
los workers conservan outbox uncertain, Minecraft review y reconciliación
histórica; queued solo significa encolado y no se actualiza a ok por suposición.

La traducción v2 valida schemas de modelo y legacy, convierte refs y fechas
semánticas a argumentos backend y ofrece resultados estructurados del conjunto
representativo. R3 dejó 89 contratos adaptados y nueve puentes cerrados.
R5 integra media.process y conserva ocho cerrados, como se detalla abajo. Los otros resultados
habilitados usan normalización legacy provisional sin texto libre sensible. Nuclear prepara/encola con servicios históricos
solo después de confirmar en B y sin abrir una sesión legacy. El nuevo parámetro
de draft conserva su comportamiento anterior por default.

Logs de policy: solo nombres estáticos, decisiones/códigos, confirmación requerida,
conteo de exposición y origen. Sin args, identidades, contenido ni hashes. Shadow
R2 conserva su cálculo puro; R4 agrega observación de contexto mediante SELECTs
y savepoint. La evaluación explícita R3 también es read-only. Límites y evidencia en [R3-POLICY-ENGINE](R3-POLICY-ENGINE.md).


## Contexto, sesiones y archivos R4

Detalle contractual, límites y evidencia en
[R4-CONTEXT-SESSIONS-ARTIFACTS](R4-CONTEXT-SESSIONS-ARTIFACTS.md).
El envelope es `SYSTEM_RULES` / `REFERENCE_DATA` / `CURRENT_USER_TURN`;
`serializeContextV2` excluye runtime backend y mapa de SafeRefs. Presupuesto de
16 000 caracteres, máximo cinco artifacts/notas/recordatorios/entidades y cuatro
eventos/extractos. La carga es scoped, relevante y acotada. Historial legacy libre
no se reinyecta: solo eventos de acciones ok con resúmenes constantes y extractos
textuales R4 limitados. Ningún function call o prompt antiguo se reconstruye.

Artifact Chain usa backing media/escolar real. La migración 013 añade metadata,
unicidad por backing y mapping artifact/outbox con FKs por chat. Captura de
entrada y finalización de worker registran bajo v1_1; shadow no registra nada.
Un derivado binario del propio actor se convierte en el último archivo; leerlo
produce contextResult limitado sin reemplazar su fuente como A_LAST. Los replies
salientes se resuelven con el provider ID persistido, también tras reconciliación.

Resolución: actual → reply → SafeRef explícita → último compatible por MIME.
A_LAST siempre filtra chat+actor, backing/retención y ventana de 24 h. Reply
explícito admite un artifact público del mismo grupo sujeto a permisos; nunca
cruza chats o privados. Las refs personales y padres de derivaciones conservan
propiedad R1. Reenvío es capacidad interna con outbox/dedupe/revalidación, sin
nueva tool, worker o ejecución Python.

Session v2 vive en sessions_v2 y no altera sessions v1 ni juegos. Continuación
inequívoca resuelve slots; un intent distinto devuelve not_consumed. Afirmación
con cambios no autoriza los argumentos anteriores. Confirmaciones vinculan
hash/linaje/expiry R3 y pasan por executeToolV2 con reevaluación completa; nunca
por un handler directo. Cancelación invalida pending; expiración no revive.
TTL de aclaración/confirmación: 5/2 min. R4 prepara media_collect, sin conectar
su collector al tráfico real.

Memoria personal completa ausente en grupos. DM solo actor autorizado y señal
relevante dentro de límites. Visión prepara imagen actual/citada/reciente del
actor (10 min), sin ninguna condición de raza de mascota. El nuevo shadow
construye y mide mediante lecturas, aísla errores y conserva respuestas/calls v1.
No hay consumo de sesiones, artifacts, jobs, confirmaciones, respuestas ni
llamadas Gemini adicionales. R5, deploy, merge y activaciones siguen fuera de
esta autorización.


## Integración Natural Router R5

Orden: ingreso/activación vigente → SessionV2 inequívoca → Exact Fast Path →
ContextBuilderV2 → selectToolsForTurn → Gemini → expansión o Policy/executor →
ToolResult del turno actual → Composer → sanitizer → outbox. No se añaden regex
que traduzcan paráfrasis a tools: las señales léxicas solo seleccionan dominios.
Las confirmaciones y AM/PM tienen gramática deliberadamente exacta.

El inbox toma el lock de admisión antes de locks de chat/wallets. Los efectos,
ledger y outbox comparten su transacción. Los callers aislados mantienen la
transacción propia del executor. Ningún flag de transacción viene del modelo.

Hasta tres propuestas de funciones (incluidas meta/denegadas), una expansión y
un retry por acción sin tool. Hasta tres generaciones, respetando además las
reservas/cuotas históricas. El content completo con partes/firmas opacas se
conserva dentro del turno; functionResponse mantiene ID/name correspondientes.
No se importan function calls históricas. Migración 014 agrega llm_usage.turn_id
para vincular cada petición REST del router con su turno durable.

Composer usa familias locales para datos deterministas y mutaciones: no permite
que Gemini reescriba el recibo de una acción. La conversación exige un outcome
JSON estricto sin efectos; resultados ok/queued se contrastan con el ledger del
turno actual. El detector textual adicional es diagnóstico conservador, no prueba
de persistencia. Web y varias lecturas pueden usar síntesis, exclusivamente con
proyección visible de datos y sin ejecutar tools devueltas durante síntesis.
Cualquier fallo posterior a un ToolResult conserva la presentación local.

Media.process incorpora selección autenticada de artifacts, fuentes almacenadas
media/escolares y resend. La confirmación escolar, colecciones/selecciones y
subida Drive permanecen bloqueadas: ocho de los nueve puentes R3, detallados en
[R5-NATURAL-ROUTER](R5-NATURAL-ROUTER.md). No se altera LibreOffice ni DOCX.
La entrega de textos cortos usa chat con revalidación de backing/retención;
textos largos usan preview y .txt. Progreso diferido a 2,5 segundos y cancelado
si ya hay resultado. No se muestran job IDs ni estados técnicos.


La admisión R5 también respeta los contratos legacy que deduplican por mensaje:
una segunda acción distinta de esa familia no puede reutilizar el primer recibo.
Los replays exactos conservan su resultado; la identidad del artifact entra al hash.
Importes de XP/juegos/biblioteca se presentan localmente incluso en respuestas
con varias herramientas. Mensaje y datos de functionResponse pasan por el mismo
saneamiento antes de llegar al proveedor. Evidencia de cierre y límites en R5.
