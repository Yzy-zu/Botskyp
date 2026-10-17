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
ejecución. El router y resultados visibles siguen siendo v1. No hay Policy
Engine nuevo, ejecución natural v2, loop ni presenter nuevo. Detalle y pruebas
en [R2-TOOL-REGISTRY](R2-TOOL-REGISTRY.md).

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
futuro deberá reclamar antes de efectos, persistir resultados y reconciliar
incertidumbre; el esquema por sí solo no promete exactly-once para servicios
externos. `queued` demuestra encolado, nunca entrega. R1 no ejecuta ni registra
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
`v1_1_shadow` observa Fast Path v2, dominios, schemas y tamaño aproximado sin
consultas adicionales ni llamadas Gemini/efectos nuevos; la respuesta y ejecución
visibles continúan por v1. `v1_1` está reservado y no se activa: también conserva
v1 hasta autorización posterior. Los shortcuts legacy no se modifican.

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
La autorización final sigue siendo backend; R3 aún no se implementa.

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
por la compatibilidad exigida. La decisión natural final corresponde a R5.

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
