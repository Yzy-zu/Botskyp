# Canary Natural-First — Botsky Lab

Base aprobada: `da4e6d3`, rama `feat/v1.1-natural-router`.
Autorización: primer deploy exclusivamente en Lab; sin merge a main.
El JID real se configura en `.env` privado; nunca se incluye en este informe.

## Plan mínimo

1. Confirmar árbol limpio, local/remoto, salud, respaldo y rollback v1.
2. Repetir únicamente los dos fallos anteriores y clasificar su causa.
3. Agregar allowlist por chat con configuración efectiva compartida por modo.
4. Aplicarla al inbox, router y fronteras de workers/outbox, conservando un pool Gemini.
5. Redactar identificadores de chat en los dos loggers que los emitían.
6. Validar aislamiento Lab/resto, límites locales y checks del cambio.
7. Desplegar con `scripts/deploy.sh`, backup y migraciones aditivas 011–014.
8. Verificar salud y aislamiento; observar un smoke humano pequeño en WhatsApp.
9. Ante un fallo grave, volver Lab a v1; conservar migraciones aditivas.

## Dos fallos de la primera corrida 337/339

- `parses a deduplicated pool, prefers it over legacy and falls back for empty lists`
  (`tests/config.test.ts`): el fixture con punto se añadió mientras estaba cargado
  el validador previo. Fallo de fixture/orden de ejecución durante edición.
- `rolls back a real process death after INSERT before commit, then retries once`
  (`tests/policy-v2.test.ts`): el proceso hijo no llegó a la barrera advisory dentro
  de su ventana durante checks estáticos concurrentes. Timing de arranque.

En el preflight del Canary se repitieron ambos, sin cambios de código ni checks
paralelos: **2/2 en 8,54 s** y **2/2 en 8,07 s**. También estaban verdes en las
repeticiones previas de R5.1. No se amplió el timeout ni se modificó Policy.

## Estado previo

- Local y remoto en `da4e6d3`, árbol limpio. Main local/remoto en `0c1a19e`.
- App/worker y PostgreSQL propio saludables; Evolution conectado, PG/Redis ajenos
  sin cambios. Sólo Lab habilitado; inbox/outbox/jobs sin trabajo pendiente.
- Backup normal existente con SHA-256 y archivo completo verificados; snapshot
  anterior con imágenes inmutables de app/worker disponible para rollback.
- Producción tenía migraciones 001–010. 011–014 añaden tablas, columnas, índices y
  triggers compatibles con los INSERT legacy; no hay DROP ni borrado de datos.
- Pool válido; daily local 0 y concurrencia 4. Cantidad de keys se informa sin valores.

## Límites del smoke

Los mensajes entran desde el WhatsApp del dueño: `fromMe` se ignora en el webhook.
No se simulan mensajes entrantes ni se presenta un mock como prueba WhatsApp.
Sin Nuclear, restart Minecraft, acciones destructivas, activaciones fuera de Lab,
cierre de los ocho bridges ni trabajo DOCX/LibreOffice. El bug DOCX conocido queda
pendiente; si aparece se registra evidencia. Bugs B/C se documentan; sólo A se corrige.


## Selector mínimo y validación

`ROUTER_V1_1_CHAT_IDS` es CSV, trim/dedupe y validación de grupos. Cuando existe,
sólo los grupos listados usan v1.1 y todo lo demás usa v1, incluso si ROUTER_MODE
fuera v1_1. Vacía fuerza v1 en todos. Si la variable no existe, se conserva el
modo global histórico para compatibilidad. Compose siempre propaga la variable;
producción fija default v1 y exactamente una entrada de Lab en `.env`.

Las vistas Config se cachean por modo y comparten el mismo pool Gemini del root:
no se reinicia su cooldown ni se multiplica el semáforo entre Lab y legacy.
Inbox, acceso directo al router, workers media/Drive y outbox resuelven por chat;
recovery y avisos de entregas fallidas resuelven el modo por cada job.
Los loggers de ingreso y tools redactan chatId; el arranque sólo publica cantidad
de keys, tamaño de allowlist, modo default y concurrencia, sin identificadores.

Validación focalizada del cambio: primera tanda 57/58; una expectativa del test
nuevo olvidó el XP de actividad existente. Corregida esa expectativa, aislamiento
**6/6** (inbox/R3 frente a legacy, pool compartido, media/outbox/recovery y rollback
con allowlist vacía). R5 afectado: **6/6**, incluyendo continuidad/agotamiento sin
doble daily, Fast Path, transcripción y retención/entrega. No se repite suite completa.
Typecheck, lint, build y auditoría de secretos se ejecutan antes del deploy.

## Rollback disponible

Main sigue en `0c1a19e`, sin merge. El snapshot v1 anterior se conserva en un enlace
privado `.local/canary-v1-rollback-compose.json` con sus imágenes inmutables.
Rollback de Canary: vaciar `ROUTER_V1_1_CHAT_IDS`, conservar ROUTER_MODE=v1 y ejecutar
`scripts/deploy.sh`; no revertir 011–014. El selector vacío se probó sin efectos.
El script oficial conserva su rollback automático de imágenes si falla el deploy.
No se induce un crash real ni se restauran datos de producción para demostrarlo.


## Despliegue y cierre real

Código desplegado **e09863f**, sobre la base aprobada da4e6d3, en
`feat/v1.1-natural-router`. `scripts/deploy.sh` terminó correctamente. Backup
previo verificado: `backups/botsky-20261017T231024-228253.dump`. Se aplicaron
011_v1_1_natural_router, 012_v1_1_policy, 013_v1_1_context y
014_v1_1_provider_turn; permanecen aditivas y no se revierten para cambiar router.

**1 key configurada**, por fallback legacy válido. Daily/RPM locales en 0,
concurrencia 4. El arranque del pool confirma la cantidad; con una sola key no
se probó rotación entre credenciales en producción. Sin cambios de secretos,
facturación ni suposiciones sobre cuotas Google.

Comprobación desde el contenedor: Lab resuelve v1_1 y únicamente su entrada está
en la allowlist; default y cualquier otro chat resuelven v1. No había otros chats
conocidos habilitados. La conducta de un segundo grupo se validó en tests, sin
habilitar un grupo real. No se publica ningún identificador del grupo.

Sólo app/worker fueron recreados. Los otros cinco contenedores conservaron ID y
StartedAt: PostgreSQL propio, SearXNG, Evolution y su PostgreSQL/Redis. Al cierre,
app/worker/DB saludables, `/health` con ok/database/evolution=true; Evolution
conectado y webhook habilitado al destino existente. Los mensajes físicos y sus
respuestas confirman entrada/salida del webhook, sin modificación de Evolution.

### Ventana observada y resultados

Ventana UTC 17/10/2026 23:11:57–23:23:17. El dueño cerró el smoke con pendientes.
La primera captura tenía 21 mensajes; al conciliar contra la ventana cerrada se
incorporaron cuatro mensajes de recordatorios que ya habían entrado: **25 mensajes,
24 llamadas Gemini, 22 mensajes con respuesta, 0 failovers y 0 HTTP 429**.
No se solicitaron mensajes adicionales ni se hicieron nuevas pruebas para cerrarlo.

Latencia desde inbox hasta confirmación de envío por Evolution (no recepción del
móvil): mediana **1,779 s**, rango **1,417–74,173 s**; respuestas habituales
1,4–3,25 s, sticker **7,776 s**, fallo DOCX **74,173 s**. Un mensaje puede producir
más de una salida (progreso y archivo/resultado final). No son benchmarks ni p95
representativo de producción. Los tres mensajes sin invocación/activación no
consumieron Gemini.

La transcripción completa, con texto, tool, resultado, latencia, llamadas,
failover, respuesta visible y valoración por mensaje, queda privada e ignorada
por Git en `.local/canary-smoke.json` (modo 600). La tabla resume las 25 entradas;
las imágenes y su contenido personal no se reproducen en documentación.

| # | Entrada resumida | Tool / resultado real | Respuesta y valoración | Gemini | ms |
| --- | --- | --- | --- | ---: | ---: |
| 1 | Saludo coloquial | Conversación | Saludo natural | 1 | 1584 |
| 2 | Pregunta sobre imagen | Visión, sin tool | Descripción contextual; exactitud no contrastada | 1 | 2769 |
| 3 | «hazla Sticker» | Sin activación | Sin respuesta | 0 | — |
| 4 | «hazla Sticker bostky» | Sin activación por typo | Sin respuesta | 0 | — |
| 5 | «hazla Sticker botsky» | media.process, worker done | Progreso y sticker entregado una vez | 2 | 7776 |
| 6 | Segunda imagen | Visión, sin tool | Interpretación contextual; exactitud no contrastada | 1 | 2787 |
| 7 | DOCX a PDF | media.process, office_pdf failed/process_timeout | Avisó fallo; no fingió entregar PDF | 1 | 74173 |
| 8 | Reclamo del PDF | media.status, ok | Lista honesta pero genérica de archivos | 1 | 1659 |
| 9 | Saldo XP natural | xp.balance, ok | Saldo real con presentación local | 1 | 1708 |
| 10 | Guardar nota de salida | notes.create, ok | Nota creada una vez | 1 | 1528 |
| 11 | Búsqueda de video adulto | Modelo sin tool | Negativa; no buscó | 1 | 1779 |
| 12 | Insistencia en búsqueda | Modelo sin tool | Negativa; no buscó | 1 | 1563 |
| 13 | Estado «maicra» | Sin tool | Pidió IP erróneamente; alias no expuso Minecraft | 1 | 1785 |
| 14 | Queja coloquial | Conversación | Tono defensivo y contexto irrelevante | 1 | 1772 |
| 15 | Nuclear, fuera del smoke acordado | bulk.nuclear, needs_confirmation | Sólo preview; cero efectos | 2 | 3246 |
| 16 | «si botsky» | bulk.nuclear, needs_confirmation | Repitió preview; cero efectos | 1 | 1417 |
| 17 | Estado «mimecragt» | Sin tool | Pidió IP; typo sin capacidad expuesta | 1 | 1787 |
| 18 | Giro gratis | Sin ejecución registrada | Negativa genérica; no equivale a daily | 1 | 1581 |
| 19 | Web sobre parentesco improbable | Modelo sin tool | Broma sin búsqueda efectiva | 1 | 2134 |
| 20 | Búsqueda de videos | media.search, denied/ADAPTER_UNAVAILABLE | Bridge cerrado: negativa honesta | 1 | 1524 |
| 21 | Hora actual | Contexto, sin tool | Hora concordante con contexto local | 1 | 2195 |
| 22 | Recordatorio «8pm» | reminders.create, needs_clarification | Pidió mañana/noche pese a pm explícito | 1 | 1982 |
| 23 | «mañana» | Sin activación | Sin respuesta; fricción al aclarar | 0 | — |
| 24 | «De la noche» | reminders.create, ok | Confirmó hoy 20:00 CDMX; creado una vez | 1 | 1609 |
| 25 | «cancelalo» | Sin ejecución de cancelación | Bridge cerrado; no cambió el recordatorio | 1 | 1620 |

### Hallazgos y resguardos

**A: ninguno observado**: no crash, doble efecto ni herramientas de negocio
repetidamente ejecutadas de forma errónea. No se activó rollback ni se modificó
código funcional durante el smoke. El ledger conserva una ejecución por sticker,
conversión, nota y creación final de recordatorio; los previews Nuclear no ejecutan
el efecto. No se induce una segunda ejecución para comprobarlo en producción.

**B, documentados sin parche:** DOCX timeout conocido; estado de media poco
contextual; alias/typos Minecraft que producen falsa indisponibilidad; negativas
genéricas; búsqueda web explícita sustituida por broma; confirmación Nuclear con
invocación que repite preview; ambigüedad incorrecta de 8pm, aclaración sin respuesta
y cancelación de recordatorio cerrada. La detección de señales Minecraft sólo
reconoce minecraft/bedrock/mc; el servicio estaba configurado como habilitado, pero
no hubo consulta real con esas variantes. No se reabre ningún bridge.

**C:** tono defensivo y arrastre de una imagen previa a respuestas no relacionadas.
Las negativas de contenido adulto procedieron del texto del modelo sin tool;
no se atribuyen a un HTTP de bloqueo ni se intentó evadirlas.

El dueño envió Nuclear fuera de la secuencia acordada. Se aplicó únicamente el
flag operativo existente `modules.messaging=false` en Lab; se invalidó una
confirmación pendiente y se canceló una sesión Nuclear, bajo el lock de admisión.
Auditoría `canary.messaging_disabled`; **0 bulk_ops Nuclear, 0 sesiones Nuclear
activas y 0 operaciones de escritura Minecraft** al cierre. No cambió el modelo
de permisos. Mensajería masiva permanece deshabilitada sólo en Lab; no se realizaron
envíos masivos ni se reactivó este módulo.

El recordatorio creado durante el smoke permanece **pending**, para 17/10/2026
20:00 America/Mexico_City (18/10 02:00 UTC). «cancelalo» no lo canceló y la respuesta
no afirmó hacerlo. No se hizo una cancelación administrativa silenciosa al cerrar;
se informó al dueño explícitamente de que sigue programado.

### Cobertura pendiente aceptada por el dueño

Daily propio, memoria escritura/lectura, búsqueda web factual efectiva, blackjack,
encuesta/voto y consulta Minecraft con nombre reconocido. Recordatorio sí cubrió
creación al conciliar las cuatro entradas finales, con las deficiencias indicadas;
cancelación falló. Visión y sticker reales cubiertos, DOCX conocido falló. No se
sustituye ninguna prueba pendiente por un mock ni por la prueba aislada previa.

### Checks y entrega

Preflight de los dos fallos previos: 2/2 dos veces. Aislamiento Canary 6/6; R5
afectado 6/6, con 107 omitidos deliberadamente por filtro. Typecheck, lint, build,
auditoría de secretos, Compose y diff-check correctos. Escaneo de logs de app/worker
y artefactos Canary: cero coincidencias de claves configuradas o JID real de Lab.
No se reejecutó la suite completa. La auditoría es del árbol actual, no saneamiento
del historial heredado documentado en ENTORNO.

Main continúa en 0c1a19e; sin merge. Rollback por allowlist vacía/default v1 probado
en tests y snapshot de imágenes v1 preservado; no se afirma un rollback real de
producción. Las migraciones aditivas permanecen. Canary queda sólo en Lab, a
criterio del dueño para su uso manual. Tras documentar y push, detenerse.
