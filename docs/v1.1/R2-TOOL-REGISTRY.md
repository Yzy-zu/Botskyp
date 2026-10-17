# R2 — Tool Registry v2 y selección sin ejecución

## Plan previo

1. Trabajar solo en `feat/v1.1-natural-router`, base R1 `92cde7e` aprobada.
2. Congelar permisos históricos y aislar catálogo/schema v2 de handlers v1.
3. Declarar 98 tools de negocio, 96 visibles, dos internas y una meta-tool.
4. Crear Fast Path exacto independiente; sin match completo devolver undefined.
5. Seleccionar dominios/schemas con módulos, contexto y máximo 20.
6. Implementar expansión única, validada y sin ejecución de negocio.
7. Observar decisiones shadow sin datos personales ni llamadas adicionales.
8. Habilitar cuotas configurables conservando defaults y aliases históricos.
9. Ejecutar pruebas focalizadas, typecheck/lint/build; documentar resultados.
10. Commit/push a la rama autorizada y detenerse; sin merge, deploy ni R3.

## Catálogo y permisos

`createToolRegistryV2(createRegistry())` produce 98 entradas de solo metadata,
sin `run`/`execute`. Todas declaran nombre, dominio, descripción para modelo,
riesgo, visibilidad, exposición, PermissionKey, módulo, confirmación, schema del
modelo, campos solo backend, presenter, obligación de resultado, ejecución
inmediata e idempotencia. Presenter/idempotencia son contratos declarativos;
R2 no implementa presenter ni executor nuevos. Los seis riesgos v2 son metadata;
el ledger R1 conserva sus tres valores históricos y no recibe ejecuciones v2.
Su traducción deberá resolverse antes de habilitar un executor posterior. Los handlers y `modelCallable`
históricos permanecen intactos.

Hay **96 tools de negocio visibles**, **dos internas** (`school.schedule_commit`
y `bulk.confirm`) y **una meta-tool adicional** (`core.load_capability`), fuera
del conteo de 98. La traducción de catálogo excluye internas y traducir una
interna individualmente falla. La meta-tool no tiene PermissionKey ni handler.

El snapshot `tests/fixtures/v1.1/permissions-r1.json` fija las 98 relaciones
`toolName -> PermissionKey` del HEAD R1 `92cde7e7f559e172664c76bc0143b73ff5657478`.
Su cambio requiere una decisión explícita posterior a DEC-059; el test fija
además el SHA-256 canónico por decisión y exige su entrada en DECISIONES.md. El test compara
el snapshot tanto con v1 como con v2. No se deriva autorización desde `risk`.

| Área | Contrato histórico conservado |
|---|---|
| Minecraft | status/players `minecraft.read`; toda otra infraestructura `infra.minecraft` owner-only |
| Escuela | crear/editar `school.write`; editar ajenas sigue validando owner/admin dentro del handler; borrar `school.manage` + DESTRUCTIVE; destino `school.manage` |
| Polls | create/close `polls.manage`; vote/results `polls.use` |
| Library | open/cancel de cooperacha y rain `chat.configure`; sync/sync_status `config.global` |
| Drive | upload `drive.use`; configure `chat.configure` |
| Control | control.modules/diag.cuota `config.global` |

## Dominios, base y selección

`CapabilityDomain` contiene `core`, `productivity`, `web`, `economy`, `polls`,
`school`, `games`, `media`, `library`, `moderation`, `minecraft`, `drive`, `admin`
y `messaging`. Notas, recordatorios y memoria pertenecen a productividad;
`memory` es una pista semántica, no un permiso ni un dominio independiente.

La base exacta es `core.help`, `notes.create`, `reminders.create`,
`memory.remember`, `web.search`, `xp.balance`, `xp.daily`, más la meta-tool.
Se filtran módulo y scope; la meta-tool permanece. No se carga admin por saludar
al owner: se requiere contexto o señal relevante y queda al final de las
señales léxicas. Las tools admin se omiten para no-owner por ahorro de tokens.

El selector puro recibe texto/cita, rol, tipo de chat, módulos resueltos por el
backend, adjunto/artifact actual, sesión, encuesta/juego/cooperacha activos y
artifacts recientes. No resuelve artifacts ni carga entidades desde BD en R2.
Orden de relevancia: base/core, sesión, artifacts/adjuntos, entidades activas,
señales léxicas más fuertes, admin. Texto actual pesa dos frente a uno de cita;
los empates usan el orden estable del enum. Primero se reserva un schema
representativo por dominio relevante no-admin, en ese orden, y después se
completan los dominios en orden de prioridad. Esto evita que las 14 tools de
escuela desplacen totalmente un adjunto que requiere media. Las preferencias
estables por dominio incluyen status/players/restart de Minecraft, play/status
de games, vote/results de polls, estado/aporte de cooperacha, nuclear y media.
No se seleccionan operaciones o argumentos a partir de esas preferencias.

`MAX_TOOLS_PER_TURN = 20`, **incluida la meta-tool**, sin duplicados ni internas.
Las pistas solo cargan dominios; no ejecutan, rechazan, interpretan argumentos
ni responden. Los módulos deshabilitados no aportan tools operativas, aunque
haya una sesión o señal léxica. El tamaño se mide en bytes UTF-8 de los schemas,
no se presenta como conteo real de tokens Gemini.

## Visibilidad y autorización

Se mantienen schemas restringidos relevantes, por ejemplo `minecraft.restart`
para un member y `bulk.nuclear` si se menciona nuclear. Cada declaración lleva
PermissionKey/risk y la indicación de que el backend valida permiso y propiedad.
Mostrar un schema no concede autorización. Omitir admin para miembros ahorra
tokens; **no es un control de seguridad**. R3 tendrá que dar una negativa segura
cuando corresponda, incluso si el schema se omitió, sin inventar una capacidad.
R2 no permite ejecutar ninguna decisión v2, sea owner, admin o member.

## Meta-tool

`ToolExposureTurn` es estado efímero creado por el backend una vez por turno,
con copia del contexto. `loadCapability({domain})` usa objeto estricto y enum,
comprueba disponibilidad para el chat mediante módulos habilitados, scope y rol.
Un módulo habilitado y con scope válido hace pertinente su dominio para ese chat;
admin requiere owner. No exige una pista léxica: permite recuperar un dominio
que Gemini entienda aunque el selector léxico no lo haya reconocido.
Agrega schemas faltantes hasta el límite preservando el conjunto ya visible.
Si no cabe ninguno devuelve `capacity` sin quitar schemas. Un dominio ya cargado
puede devolver éxito sin agregar duplicados.

`MAX_CAPABILITY_EXPANSIONS_PER_TURN = 1`. Solo un éxito consume la expansión;
argumentos inválidos, dominio no relevante/no disponible o capacidad agotada
no la consumen. El modelo no recibe ni modifica el contador. La segunda expansión
exitosa se rechaza localmente. No usa permisos de negocio, no llama handlers,
no consulta/escribe BD y no implementa el loop Gemini.

## Fast Path y P0 de memoria

`src/core/shortcuts-v2.ts` es independiente de todos los shortcuts legacy.
Solo reconoce comandos completos con vocativo, como `bot xp`, `bot daily`,
`bot mc`, `bot pedir`, `bot plantarse`. Devuelve una propuesta de nombre/args
sin efectos. Ante texto parcial, puntuación no admitida o frase natural:
`undefined`. Nunca devuelve «No.», invalid, «Usa:» ni errores de sintaxis.

Las seis frases de no-secuestro del pedido y las variantes con vocativo pasan.
«Guarda en tu memoria», «acuérdate de que» y «recuerda que» cargan productividad
con pista memory; los contratos de notes/memory explican su distinción. Crear
notas compartidas requiere una solicitud de nota («anota en el grupo», «crea una
nota», «guarda una nota»). El Fast Path no convierte ninguna de esas frases en
acciones. `notes.create` sigue visible porque pertenece a la base; **estar visible
no equivale a haberla seleccionado ni ejecutado**. Gemini decidirá la intención
natural final en R5; R2 no introduce una clasificación regex ejecutable.

## Schemas y Gemini

Los schemas se declaran explícitamente en `model-args.ts`; no se exportan
`args` de handlers ni se pasan argumentos nuevos a handlers legacy. Referencias
opacas sustituyen IDs de notas/tareas/encuestas/Drive/destinos/operaciones;
fechas usan `SemanticTime`. `SELF` y `A_LAST` se resuelven posteriormente por
backend. Son necesarios los adaptadores de argumentos/refs de R5 antes de
cualquier ejecución. R2 no los implementa.

`registryV2Declarations`/`modelDeclaration` producen el contrato del adapter
actual: `name`, `description`, `parametersJsonSchema`. Se usa únicamente
`modelArgsSchema`, sin `$schema`; todos los objetos son estrictos. Se rechazan
campos backend incluso anidados (actor/chat/JID/IDs crudos/rutas/roles/hashes).
Las confirmaciones internas reciben schemas vacíos y nunca se exponen.
La seguridad semántica de strings/URLs/refs seguirá validándose en backend;
un schema no concede acceso a un recurso ni sustituye la resolución de refs.

Se verificó la [referencia oficial de FunctionDeclaration](https://ai.google.dev/api/generate-content#FunctionDeclaration)
el 17-10-2026: `parametersJsonSchema` admite el objeto JSON Schema y es
alternativo a `parameters`. Las declaraciones R2 no se envían al router v1 ni
se validaron mediante llamadas reales al proveedor.

## Cuotas y compatibilidad

| Variable | Default v1 conservado | Rango entero defensivo |
|---|---:|---:|
| LLM_GLOBAL_RPM | 5 | 1–10 000 |
| LLM_USER_RPM | 8 | 1–10 000 |
| LLM_DAILY_LIMIT | 20 | 1–1 000 000 |
| LLM_INPUT_TOKENS_PER_MINUTE | 65 536 | 1–10 000 000 |
| LLM_RESERVED_INPUT_TOKENS | 32 768 | 1–10 000 000 |

Se admiten aumentos o reducciones explícitos; configuración inválida falla al
inicio sin incluir valores secretos. Los topes son defensivos locales, no cuotas
prometidas por Google. R2 no cambia `.env`, configuración de servicios, límites
reales, modelos ni facturación. Los valores Canary se decidirán después.

Se conservan `GEMINI_GLOBAL_RPM`, `GEMINI_USER_RPM`, `GEMINI_DAILY_LIMIT` y
`GEMINI_INPUT_TPM` como aliases. `LLM_*` explícito prevalece; un alias inválido
sigue fallando en readConfig. Compose reenvía las nuevas variables con fallback
a aliases/defaults; no se ejecuta Compose sobre servicios. La interpolación
anidada está documentada por [Docker Compose](https://docs.docker.com/reference/compose-file/interpolation/)
y se validó localmente con `docker compose config --quiet`, sin imprimir valores. Reserva configurable
es el fallback cuando el caller no aporta estimación; una estimación explícita
prevalece. El adapter v1 conserva su estimación UTF-8, margen e imágenes, que ya
sustituyó la reserva fija en DEC-023. No se reintroduce una reserva fija mínima
que altere v1 o agote artificialmente cuota.

## Shadow y límites de R2

`v1`: shortcuts/router/declarations/handlers históricos; no calcula v2.
`v1_1_shadow`: calcula Fast Path match/no-match, dominios, nombres de tools y
bytes aproximados; después continúa exactamente por v1. La observación reutiliza
sesión ya cargada, módulos, texto/cita y adjunto presentes. No añade queries de
polls/cooperacha/artifacts recientes: esos inputs del selector se prueban como
snapshots sintéticos hasta R4. Sesiones game/media/clarify aportan su dominio.
Una falla del cálculo shadow se limita al log sanitizado y no altera respuesta.
`v1_1`: reservado; conserva v1 en R2, sin activarlo.

El log shadow contiene exclusivamente booleano, dominios/nombres estáticos y
tamaño; sin texto, JIDs, IDs de turno, args, estado de sesión ni secretos. No
agrega llamadas Gemini, red, escrituras de negocio ni ledger v2. Los efectos
que produzca v1 al continuar pertenecen a v1 y se conservan por compatibilidad.
En particular, el bug legacy de «guarda en tu memoria» puede seguir creando una
nota en v1 y shadow: R2 demuestra el pase libre del Fast Path v2 y la ausencia de
selección/ejecución de notes.create por v2, sin cambiar el comportamiento visible.

## Contradicciones resueltas por autoridad

La instrucción R2 sustituye el bloqueo histórico «sin R2» de R1 y la limitación
de cuotas a reducciones; no autoriza R3/deploy/merge. La visibilidad v2 de
nuclear y demás tools antiguamente no-modelCallable sustituye esa restricción
solo en metadata v2; v1 conserva exactamente sus flags. `memory` se representa
como semántica dentro de `productivity`, coherente con los dominios definitivos.
No hay contradicción de producto pendiente que requiera consultar al dueño.

## Verificación

Comando de la selección focalizada final (un solo proceso):

```text
npx vitest run tests/tool-registry-v2.test.ts tests/shortcuts-v2.test.ts \
  tests/tool-exposure.test.ts tests/config.test.ts tests/router-shadow.test.ts \
  tests/core.test.ts tests/llm.test.ts tests/natural-foundations.test.ts \
  tests/school.test.ts
npm run typecheck
npm run lint
npm run build
npm run audit:secrets
docker compose config --quiet
git diff --check
```

Resultado final: **187/187 tests, nueve archivos**, en un único proceso sobre
base temporal dedicada. Incluye 75 casos R2/config/shadow y 112 regresiones
directamente afectadas (core, llm, fundamentos R1 y school). `typecheck`, `lint`,
`build`, auditoría de secretos, `docker compose config --quiet` y revisión de
whitespace correctos. El aviso `calculation_failed` de la suite shadow es una
falla inyectada intencionalmente y controlada, sin cambio de respuesta.
No se ejecutó la suite de 700+ tests ni validación física en WhatsApp.
No hubo llamadas reales Gemini ni acciones v2 de negocio. Los servicios,
Evolution, `.env` real y `main` permanecieron sin modificaciones.
La primera corrida de regresión se invalidó por dos procesos Vitest compartiendo
`.local/test-db.json`; una base temporal se eliminó antes de que el otro proceso
la utilizara. Se repite toda la selección en un único proceso, sin modificar la
infraestructura ni tocar bases de producción. No se atribuye ese fallo al router. También se corrigió el fixture shadow para
truncar message_turns/ledger en la base temporal: esas tablas son deliberadamente
independientes de chats/users y conservaban una ejecución de las pruebas R1.
La repetición de las cuatro suites afectadas pasó 63/63. Después de revisar la
expansión sin barrera léxica y fijar el digest del snapshot se congelaron fuentes
y pruebas para la selección final de nueve archivos.

## Casos de aceptación del selector

En todos estos casos se inspeccionan schemas/contexto; no se ejecuta negocio v2.

| Entrada/contexto | Comportamiento verificado |
|---|---|
| hola botsky, cualquier rol | Solo siete base + meta (menos módulos/scope apagados) |
| oye cuánto xp tengo | xp.balance visible |
| jalo blackjack de 20 | games cargado, sin decidir apuesta ni ejecutar |
| yo voto tacos + poll abierta | polls.vote visible, sin decidir opción |
| hay alguien jugando minecraft | status/players visibles |
| reinicia minecraft, member | Dominio y schema de restart visibles con infra.minecraft; cero ejecución |
| guarda esto en tu memoria / frase P0 de tacos | productivity + pista memory; Fast Path undefined, sin notes.create automático |
| busca en nuestras notas cálculo | productivity; Fast Path undefined, sin secuestro web |
| convierte este DOCX a PDF + artifact | media.process visible |
| ahora comprímelo + PDF reciente A_LAST | media.process visible |
| abre una cooperacha | library/cooperacha.open visible |
| manda una nuclear de 8 mensajes, owner | messaging/bulk.nuclear visible |
| misma nuclear, member | Schema restringido visible, cero ejecución; autorización futura de backend |
| señales/contextos competidores | Máximo 20 con prioridades y un representante por dominio |
| módulo apagado | Ninguna tool operativa correspondiente, incluida base y expansión |
| tools internas / campos backend | Internas ausentes; filtrado/validación recursiva de schemas |
| expansión sin coincidencia léxica | Se admite dominio habilitado y válido para chat/rol; una expansión |
| shadow frente a v1 | Misma respuesta, secuencia SQL y llamada Gemini; observación sola sin SQL/red |

## Inventario completo de negocio

| Tool | Dominio | PermissionKey histórico | Risk v2 | Exposure |
|---|---|---|---|---|
| polls.create | polls | polls.manage | USER_WRITE | dynamic:polls |
| polls.vote | polls | polls.use | USER_WRITE | dynamic:polls |
| polls.results | polls | polls.use | READ | dynamic:polls |
| polls.close | polls | polls.manage | USER_WRITE | dynamic:polls |
| drive.cancel | drive | drive.use | USER_WRITE | dynamic:drive |
| drive.search | drive | drive.use | EXTERNAL | dynamic:drive |
| drive.download | drive | drive.use | EXTERNAL | dynamic:drive |
| drive.upload | drive | drive.use | EXTERNAL | dynamic:drive |
| drive.info | drive | drive.use | READ | dynamic:drive |
| drive.configure | drive | chat.configure | PRIVILEGED | dynamic:drive |
| drive.status | drive | drive.use | READ | dynamic:drive |
| messaging.destinations | messaging | bulk.broadcast | READ | dynamic:messaging |
| messaging.send | messaging | bulk.broadcast | PRIVILEGED | dynamic:messaging |
| bulk.broadcast | messaging | bulk.broadcast | PRIVILEGED | dynamic:messaging |
| bulk.nuclear | messaging | bulk.nuclear | PRIVILEGED | dynamic:messaging |
| bulk.confirm | messaging | bulk.broadcast | DESTRUCTIVE | internal |
| bulk.cancel | messaging | bulk.broadcast | PRIVILEGED | dynamic:messaging |
| bulk.retry | messaging | bulk.broadcast | PRIVILEGED | dynamic:messaging |
| bulk.resume | messaging | bulk.broadcast | PRIVILEGED | dynamic:messaging |
| bulk.status | messaging | bulk.broadcast | READ | dynamic:messaging |
| library.categories | library | chat.use | READ | dynamic:library |
| packs.buy | library | chat.use | ECONOMIC | dynamic:library |
| packs.orders | library | chat.use | READ | dynamic:library |
| library.sync | library | config.global | PRIVILEGED | dynamic:library |
| library.sync_status | library | config.global | READ | dynamic:library |
| cooperacha.open | library | chat.configure | ECONOMIC | dynamic:library |
| cooperacha.contribute | library | games.use | ECONOMIC | dynamic:library |
| cooperacha.status | library | games.use | READ | dynamic:library |
| cooperacha.cancel | library | chat.configure | ECONOMIC | dynamic:library |
| library.rain | library | chat.configure | PRIVILEGED | dynamic:library |
| media.process | media | chat.use | EXTERNAL | dynamic:media |
| media.search | media | chat.use | EXTERNAL | dynamic:media |
| media.collect | media | chat.use | EXTERNAL | dynamic:media |
| media.status | media | chat.use | READ | dynamic:media |
| minecraft.status | minecraft | minecraft.read | READ | dynamic:minecraft |
| minecraft.players | minecraft | minecraft.read | READ | dynamic:minecraft |
| minecraft.resources | minecraft | infra.minecraft | READ | dynamic:minecraft |
| minecraft.worlds | minecraft | infra.minecraft | READ | dynamic:minecraft |
| minecraft.addons | minecraft | infra.minecraft | READ | dynamic:minecraft |
| minecraft.logs | minecraft | infra.minecraft | READ | dynamic:minecraft |
| minecraft.config-get | minecraft | infra.minecraft | READ | dynamic:minecraft |
| minecraft.config-set | minecraft | infra.minecraft | PRIVILEGED | dynamic:minecraft |
| minecraft.start | minecraft | infra.minecraft | PRIVILEGED | dynamic:minecraft |
| minecraft.stop | minecraft | infra.minecraft | DESTRUCTIVE | dynamic:minecraft |
| minecraft.restart | minecraft | infra.minecraft | DESTRUCTIVE | dynamic:minecraft |
| minecraft.backup | minecraft | infra.minecraft | PRIVILEGED | dynamic:minecraft |
| minecraft.console | minecraft | infra.minecraft | PRIVILEGED | dynamic:minecraft |
| minecraft.operations | minecraft | infra.minecraft | READ | dynamic:minecraft |
| notes.create | productivity | chat.use | USER_WRITE | always |
| notes.list | productivity | chat.use | READ | dynamic:productivity |
| notes.edit | productivity | chat.use | USER_WRITE | dynamic:productivity |
| notes.delete | productivity | chat.use | DESTRUCTIVE | dynamic:productivity |
| reminders.create | productivity | chat.use | USER_WRITE | always |
| reminders.list | productivity | chat.use | READ | dynamic:productivity |
| reminders.edit | productivity | chat.use | USER_WRITE | dynamic:productivity |
| reminders.cancel | productivity | chat.use | USER_WRITE | dynamic:productivity |
| memory.remember | productivity | chat.use | USER_WRITE | always |
| memory.list | productivity | chat.use | READ | dynamic:productivity |
| memory.forget | productivity | chat.use | DESTRUCTIVE | dynamic:productivity |
| web.search | web | chat.use | EXTERNAL | always |
| school.subjects | school | school.write | READ | dynamic:school |
| school.subject_save | school | school.manage | PRIVILEGED | dynamic:school |
| school.subject_archive | school | school.manage | DESTRUCTIVE | dynamic:school |
| school.schedule | school | school.write | READ | dynamic:school |
| school.schedule_propose | school | school.manage | PRIVILEGED | dynamic:school |
| school.schedule_import | school | school.manage | PRIVILEGED | dynamic:school |
| school.schedule_commit | school | school.manage | PRIVILEGED | internal |
| school.tasks | school | school.write | READ | dynamic:school |
| school.task_create | school | school.write | USER_WRITE | dynamic:school |
| school.task_edit | school | school.write | USER_WRITE | dynamic:school |
| school.task_delete | school | school.manage | DESTRUCTIVE | dynamic:school |
| school.task_attachment | school | school.write | EXTERNAL | dynamic:school |
| school.config | school | school.write | READ | dynamic:school |
| school.summary_configure | school | school.manage | PRIVILEGED | dynamic:school |
| school.destination | school | school.manage | PRIVILEGED | dynamic:school |
| xp.balance | economy | xp.use | READ | always |
| xp.daily | economy | xp.use | ECONOMIC | always |
| xp.happy | economy | chat.configure | ECONOMIC | dynamic:economy |
| games.blackjack | games | games.use | ECONOMIC | dynamic:games |
| games.roulette | games | games.use | ECONOMIC | dynamic:games |
| games.join | games | games.use | ECONOMIC | dynamic:games |
| games.play | games | games.use | ECONOMIC | dynamic:games |
| games.status | games | games.use | READ | dynamic:games |
| games.cancel | games | games.use | ECONOMIC | dynamic:games |
| games.airdrop | games | chat.configure | ECONOMIC | dynamic:games |
| games.claim | games | games.use | ECONOMIC | dynamic:games |
| moderation.warns | moderation | games.use | READ | dynamic:moderation |
| moderation.change | moderation | moderation.act | PRIVILEGED | dynamic:moderation |
| moderation.config | moderation | moderation.act | PRIVILEGED | dynamic:moderation |
| control.emergency | admin | config.global | PRIVILEGED | dynamic:admin |
| control.reactivate | admin | config.global | PRIVILEGED | dynamic:admin |
| control.maintenance_on | admin | config.global | PRIVILEGED | dynamic:admin |
| control.maintenance_off | admin | config.global | PRIVILEGED | dynamic:admin |
| control.modules | admin | config.global | PRIVILEGED | dynamic:admin |
| diag.cuota | admin | config.global | READ | dynamic:admin |
| diag.errores | admin | config.global | READ | dynamic:admin |
| core.ping | core | chat.use | READ | dynamic:core |
| core.help | core | chat.use | READ | always |
