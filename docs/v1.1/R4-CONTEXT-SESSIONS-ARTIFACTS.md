# R4 — Contexto, sesiones y continuidad de archivos

Base aprobada R3: `0858ce1807f610c89084290847d14c63f09376c3`.
Solo `feat/v1.1-natural-router`, un constructor sin delegación.
Sin deploy, merge, R5 ni Gemini conectado a ejecución v2.

Plan previo del cambio crítico:
1. Separar runtime backend, snapshot de referencia y turno actual.
2. Cargar entidades con límites deterministas y referencias opacas.
3. Usar eventos neutrales tipados, nunca texto legacy de herramientas.
4. Registrar backing real de entrada/salida con claves idempotentes y mapping outbox.
5. Resolver archivos por compatibilidad y scope; reenviar mediante outbox sin worker.
6. Persistir Session v2 aparte y consumir solo respuestas inequívocas.
7. Conservar reevaluación, hash y linaje R3 al confirmar.
8. Medir contexto en shadow exclusivamente con lecturas.
9. Probar componentes e integración en BD efímera, documentar, commit/push y detenerse.

## Contrato final y frontera de confianza

`buildTurnContextV2` reconstruye actor/chat desde inbox autenticado mediante
`loadExecutionContext` R3. Rechaza LIDs sin resolver, chat deshabilitado, miembro
sin membresía vigente y DM sin elegibilidad histórica. El caller no puede elegir
el rol a partir de los argumentos de Gemini.

```text
TurnContextV2
  runtime
    turnId, sourceMessageId, now, timezone
    actor, chat, role backend, enabledModules, routerMode
  envelope                          ← única superficie para el modelo
    SYSTEM_RULES                    ← constantes del programa
    REFERENCE_DATA                  ← datos, SOLO REFERENCIA
    CURRENT_USER_TURN                ← userText actual separado
  safeRefMap                        ← solo backend, resolución scoped
  metrics                           ← tamaños/tipos, sin contenidos
```

`serializeContextV2` serializa únicamente `envelope`. Nunca pasar runtime,
SafeRefs internos, filas SQL ni argumentos de ejecución a un prompt. La salida
segura incluye `nowLocal`, SELF/nombre/rol informativo, tipo de chat y módulos,
sesión segura con preview, attachment/artifact actual, cita, artifacts recientes,
notas/recordatorios con refs, encuesta abierta, juego, cooperacha, escuela,
miembros mencionados, resultados textuales y eventos resueltos.

`CURRENT_USER_TURN` contiene `userText`, `quotedText`, `quotedAuthorRef`,
`attachedArtifactRef` y menciones. Solo `userText` es la petición actual.
Citas, nombres, notas y extractos conservan su significado, incluyendo instrucciones
maliciosas, dentro de campos JSON de datos. No se concatenan como reglas ni se
filtran semánticamente. Se redactan identidades del transporte, UUIDs y rutas en
textos; los identificadores reales solo viven en runtime y el mapa backend.
Refs nuevas: prefijo de tipo + 24 caracteres hex aleatorios, sin forma de UUID.
Los schemas también aceptan sintaxis de snapshots R1/R2; sin una entrada vigente
en el mapa no resuelven ningún recurso ni aceptan IDs crudos como fallback.

## Presupuesto y prioridad

Máximo **16 000 caracteres del envelope JSON completo**, aproximadamente
`ceil(chars/4)` tokens como métrica, sin llamar al proveedor para resumir.
Valores de producto en `config/product.ts`.

| Elemento | Límite / carga |
|---|---|
| Eventos de acciones terminadas | 4, actor/chat, últimos 7 días |
| Artifacts recientes del usuario | 5, backing vivo, ventana 24 h |
| Notas | 5, solo dominio productividad relevante |
| Recordatorios | 5 propios, pendientes, dominio relevante |
| Encuesta | Solo la abierta más reciente; P_ACTIVE + pollRef opaca |
| Juego | Solo uno activo; estado compacto, sin mazo ni IDs |
| Cooperacha | Solo abierta, total/meta/categoría |
| Escuela | Hasta 5 materias/tareas cuando aplica |
| Miembros | Hasta 5 mencionados/citados, membresía vigente; aliases verificados |
| Memoria privada | Hasta 5, DM autorizado y señal relevante de memoria |
| Resultados textuales | Hasta 4 extractos de 1 200 caracteres, 7 días |

Evicción determinista de nodos completos, del menos al más prioritario:
historial/eventos/resultados → artifacts recientes → memoria/entidades
referenciadas → cooperacha/encuesta/juego → sesión → imagen/archivo actual →
cita. `userText` actual se conserva íntegro. La copia de `quotedText` en el turno
se retira solo si aún sobra presupuesto. Si el turno actual por sí mismo excede
el límite, se devuelve error de presupuesto; shadow lo aísla y v1 continúa.
No se cortan JSON ni SafeRefs. La imagen reciente tiene ventana corta de 10 min;
las imágenes actuales/citadas usan su vigencia real.

## Historial sin replay de tools

No se lee historial libre legacy de `context_msgs` como intercambios del modelo.
No se leen prompts, functionCalls, functionResponses, JSON de resultados ni
respuestas legacy para reconstruir conversaciones. Los únicos textos de esa
tabla admitidos son extractos `result_kind` creados por el componente R4.

Los eventos se construyen desde `tool_executions.status='ok'`, actor/chat y un
mapa cerrado de resúmenes. Ejemplo: «El usuario consultó su saldo de XP.» Los
nombres internos nunca se publican en el evento. Los nombres desconocidos usan
«Una operación anterior terminó.» Se excluyen queued/uncertain y nunca se
presentan como trabajos pendientes ejecutables. No hay nueva llamada Gemini.
Una sesión activa es estado explícito actual, separado del historial resuelto.
Las previews de confirmación seleccionan campos seguros (descripción/texto/
cantidad); no exponen el JSON de argumentos ni el nombre interno de la tool.

Esto es deliberadamente conservador: R4 no intenta rescatar conversaciones
legacy arbitrarias ni resumir libremente sus respuestas. La continuidad probada
viene de archivos, resultados, entidades y sesiones estructuradas.

## Artifact Chain real y persistencia

Migración **013 aditiva**, probada únicamente en BD efímera. Añade origin,
filename, bytes, job y unicidad por backing a `chat_artifacts`; conserva las FKs
R1 de turno/chat/actor y backing. `artifact_deliveries` relaciona el artifact con
cada outbox, incluyendo reenvíos; FKs compuestas impiden cruzar chats.
Índices cubren fuente, backing, entrega y reply del proveedor.

`registerArtifactV2` valida backing no limpiado/no vencido, chat/actor y turno
aceptado; job y entrega deben corresponder al scope y backing. Es idempotente
por attachment real y por entrada lógica (mensaje/actor/chat/tipo), incluso si
escuela y multimedia conservan backings separados del mismo archivo. La retención se hereda sin ampliarla: original 7 días,
generado 2 días según políticas existentes. Se registra el nombre del proveedor
cuando viene en el envelope normalizado, tratándolo como dato; `fileName` está
verificado en el fixture capturado `tests/fixtures/documentMessage.json` y no
introduce un endpoint ni una llamada externa nueva. En sticker se
conserva el tipo, aunque comparta MIME WebP con imágenes.

Puntos integrados, habilitados solo bajo `v1_1`:

- Inbox, después de canonicalizar identidad, registra backing ya existente.
- Captura escolar registra el original al guardar bytes reales.
- Worker multimedia registra originales al capturarlos o recuperar cache.
- Al finalizar el worker, guarda outputs binarios con actor solicitante, turno
  de la operación, job, outbox y padre derivado de la fuente realmente usada.
- Worker Drive registra archivos respaldados entregados al mismo chat; enlaces
  privados sin backing no se convierten en archivos ficticios.

Registrar tarde un original conserva la fecha del turno de entrada y no lo
convierte artificialmente en un archivo más nuevo. El worker v2 ignora una
invocación obsoleta si el job ya no está running; reconciliación/retry conserva
la unicidad de backing y outbox. No se duplica almacenamiento.

Los jobs que descargan archivos remotos registran su salida retenida como
bot_output; una URL no es una entrada del usuario con backing ficticio.
Sin backing, el contexto puede mostrar el tipo del attachment actual, pero R4
no descarga material adicional desde shadow ni inventa un artifact.

## A_CURRENT / A_REPLY / A_LAST y privacidad

`resolveArtifactForOperation(operation, context, explicitRef?)` aplica:

1. A_CURRENT: backing del archivo de este mensaje/actor/chat.
2. A_REPLY: artifact de la cita explícita, mediante mensaje de entrada o mapping
   `artifact_deliveries → outbox.provider_msg_id`, únicamente si fue enviado.
3. SafeRef explícita del snapshot, scoped y revalidada con backing vivo.
4. A_LAST: último archivo **compatible**, chat + actor, ventana 24 h.

La matriz de MIME/extensiones reutiliza `modules/media/catalog.ts`. Un archivo
explícito incompatible produce `incompatible`, no toma otro silenciosamente.
Múltiples explícitos compatibles devuelven `needs_clarification`. Un reply de
archivo desconocido no recae silenciosamente en otro archivo. Para A_LAST se
filtra compatibilidad en SQL antes de LIMIT: siete DOCX nuevos no esconden el PDF
compatible anterior. La operación de visión usa una selección específica de
imagen con prioridad actual → citada → última imagen del actor en 10 min.

A_LAST implícito **jamás hereda** archivos de otro usuario o chat, incluido DM.
Un reply explícito permite resolver/reenviar un archivo público del mismo grupo
si `mediaAllowed` histórico permite trabajar con él. Nunca abre un archivo
privado ajeno ni uno de otro chat. La excepción de reply se conserva como
A_REPLY; no transforma el archivo compartido en una ref personal del actor.
Las refs personales de artifacts siguen requiriendo propiedad R1/R3.

Las FKs de padre R1 conservan mismo actor/chat. R4 prueba derivaciones del propio
actor y lectura/selección/reenvío compartido explícito; no abre un adaptador para
convertir archivos ajenos saltándose esas constraints. Los puentes media R3
permanecen cerrados para ejecución natural hasta una integración autorizada.

## Reenvío y resultados de texto

`resendArtifactV2` es una **capacidad interna**, sin tool #99 ni schema nuevo del
catálogo. Reconstruye turno/actor/chat desde inbox; revalida `mediaAllowed`,
SafeRef/reply/scope y backing. Inserta `artifact_resend` en el outbox histórico,
con dedupe por chat/actor/mensaje. No crea job ni copia rutas, no llama Python,
no extiende retención y no mueve A_LAST. El adaptador de entrega revalida acceso,
retención, bytes/formato y excepción de reply antes del envío. La reconciliación
y los estados inciertos siguen siendo los del outbox existente.

`rememberContextResultV2` reutiliza `context_msgs`, con `result_kind/result_key`
y unicidad scoped. No hace falta una tabla de textos nueva. Almacena como máximo
1 200 caracteres por resultado de OCR/QR/transcripción/lectura, aplica el filtro
sensible histórico y la retención de contexto de 7 días; el loader aplica esa
vigencia incluso antes de cleanup. Grupo/DM y usuario se filtran conjuntamente.
`R_LAST`/`R_n` se refieren solo a estos extractos, nunca al texto completo omitido.

La entrega .txt histórica puede conservar su backing real y política de archivos,
pero esos resultados textuales no crean una nueva entrada de Artifact Chain ni
sustituyen al PDF como A_LAST. Así «léelo» produce texto referenciable y después
«pásamelo otra vez» sigue reenviando el PDF comprimido original. No se fabrica un
archivo para un resultado puramente textual.

## Session v2 y confirmations R3

`sessions_v2` está separada de `sessions` legacy. Una sesión en primer plano por
actor/chat, tipos confirm/clarify/media_collect; pendingTool, partialArgs,
missingSlots tipados, prompt/code, hash/linaje/pending R3, timestamps, status y
versión. Esta tabla nueva se justifica por el aislamiento de v1 y la persistencia
independiente; no duplica estado de juegos. Juegos siguen en sus tablas.

TTL histórico: clarify 5 min, confirm 2 min. `media_collect` tiene contrato de
entrada conservador, pero no se conecta al collector legacy en R4.
`decideSessionV2` es puro. `coordinateSessionV2` se usa dentro de una transacción
backend, con lock de admisión R3, estado vivo y versión; no ejecuta handlers.
Al continuar persiste slots resueltos en partialArgs.continuation y limpia
missingSlots. No guarda un nuevo intent como si fuera respuesta de un slot.

- «de la noche», «pm», «8 pm» para hora pendiente 8 → periodo pm / hora 20.
- «en la mañana», «am» → periodo am / hora 8.
- Solo afirmativos completos: sí/si/sip/va/dale/confirmo/hazlo.
- Negativos completos y cancelaciones explícitas: nel/no/mejor no/cancela,
  incluyendo «nel mejor cancela eso».
- «cuánto xp tengo?», «qué iba a mandar?», «sí, pero cambia el texto a hola»
  → **not_consumed**, sin confirmar ni sobrescribir slots.

Al expirar no ejecuta y persiste expired cuando el coordinador real la procesa.
Un sí tardío no revive nada. Leer/medir desde shadow no cambia el status.

R3 crea su pending y vincula Session v2 dentro de la misma transacción. Session
copia hash, parentExecutionId, logicalActionId y expiry, sin reconstruirlos desde
texto del modelo. `continueConfirmationV2` reconstruye identidad y emite la
petición backend hacia `executeToolV2`: reevaluación completa → gates/hash/rol/
recursos/expiración → hija con linaje original → servicios históricos. Jamás llama
handler directo. El executor comparte la misma gramática exacta de afirmativos,
pero conserva la autenticación del texto desde inbox; no se sustituye el mensaje
por un «sí» fabricado. Cancelar invalida el pending atómicamente. Duplicados no
repiten efectos; el executor conserva el recibo R3 de la hija.

## Memoria, visión y shadow

En grupos solo puede verse `personalMemoryAvailable`; no se consultan cuerpos
de recuerdos. En DM se requiere elegibilidad histórica y dominio/señal relevante
de memoria; se cargan únicamente recuerdos del actor, con límite cinco. Alias de
menciones/citas solo se resuelven con evidencia verificada y membresía actual.

Visión no busca palabras de raza/mascota: prepara la imagen relevante para
cualquier pregunta. R4 no clasifica intención ni llama Gemini por visión. El
selector legacy se conserva por compatibilidad v1.

`observeContextShadowV2` construye snapshot/mapa/decisión/selección y registra
solo contextChars, estimatedTokens, artifactCount, selectedArtifactKind,
sessionKind, sessionDecision y activeEntityKinds. Usa únicamente SELECTs con
SAVEPOINT para aislar fallos de cálculo/BD. Las pruebas lo ejecutan READ ONLY.
No consume sesiones, confirma, guarda contexto adicional, registra artifacts,
encola jobs/outbox ni hace llamadas extra Gemini. El flujo v1 visible y su número
de llamadas permanecen iguales; los efectos v1 preexistentes siguen su ruta.
`v1` no ejecuta el builder. `v1_1` continúa reservado: estas APIs solo se invocan
explícitamente desde componentes/tests, no desde Gemini/tráfico natural.

## Verificación y límites

Las pruebas focalizadas cubren estructura, inyección, presupuesto, privacidad,
SafeRefs, entidades, visión, captura del worker, cadena real, reintentos,
reenvío, continuación, escape, expiración, confirmación y reevaluación R3.
Además se verifican las regresiones específicas de router/fundamentos, schemas,
Policy, multimedia, escuela, Drive y normalización. No se ejecuta la suite 700+.
Resultado final: **337 pruebas únicas en 12 archivos**, todas verificadas en verde.
No se suman repeticiones ni pruebas filtradas ya contabilizadas.

| Grupo | Archivos | Pruebas únicas |
|---|---:|---:|
| R4 context/artifacts/sessions | 3 | 95 (18 + 29 + 48) |
| Fundamentos/SafeRefs/shadow/catálogo R1–R2 | 4 | 52 (25 + 16 + 6 + 5) |
| Policy/ejecutor R3 completo | 1 | 105 |
| Multimedia/escuela/Drive/normalización legacy | 4 | 85 |
| Total | 12 | 337 |

Comandos ejecutados con Node 24 local:

```text
npm test -- tests/policy-v2.test.ts tests/tool-registry-v2.test.ts tests/sessions-v2.test.ts tests/context-v2.test.ts tests/artifacts-v2.test.ts
npm test -- tests/artifacts-v2.test.ts tests/context-v2.test.ts tests/sessions-v2.test.ts tests/natural-foundations.test.ts tests/safe-refs.test.ts tests/router-shadow.test.ts tests/tool-registry-v2.test.ts
npm test -- tests/context-v2.test.ts tests/natural-foundations.test.ts
npm test -- tests/policy-v2.test.ts tests/media-jobs.test.ts tests/school-media.test.ts tests/drive.test.ts tests/normalize.test.ts
npm test -- tests/policy-v2.test.ts -t 'checks artifact ownership'
npm run typecheck
npm run lint
npm run build
npm run audit:secrets
git diff --cached --check
```

Las tandas intermedias detectaron y corrigieron: validación de SafeRef antigua
frente al nuevo token sin UUID; límites de palabra ASCII que omitían «mí»;
fixtures R1 con outputs sintéticos sin origin explícito. Se adaptó únicamente
la clasificación de esos outputs, conservando todos los asserts de backing,
parent/scope, expiración y privacidad. La tanda de cierre de contexto/fundamentos
pasó 43/43 después de esas correcciones. Las otras 294 pruebas únicas quedaron
verdes en sus tandas focalizadas. La migración 013 solo se aplicó a BD efímeras.
Auditoría versionada: cero archivos con hallazgos. Typecheck/lint/build y diff
check correctos. No se ejecutó la suite completa de 700+.


Limitaciones deliberadas:

- No hay clasificación natural, loop/presenter v2, ejecución Gemini v2 ni R5.
- No se importa historial libre v1; eventos y extractos son conservadores.
- No se descarga un attachment que aún carezca de backing durante shadow.
- Los extractos no prometen contener todo un documento/transcripción.
- No se añade un worker ni exactly-once externo; incertidumbre outbox intacta.
- Los puentes de media/previews que R3 dejó cerrados siguen cerrados.
- No hay deploy, migraciones reales, healthcheck de producción, envíos WhatsApp,
  reinicios Minecraft, OAuth ni llamadas reales a APIs en esta entrega.

## Archivos de la entrega

36 archivos (incluidos este informe, arquitectura y documentos de control):

```text
config/product.ts
docs/DECISIONES.md
docs/ROADMAP.md
docs/v1.1/ARQUITECTURA.md
docs/v1.1/R4-CONTEXT-SESSIONS-ARTIFACTS.md
src/core/artifact-registration-v2.ts
src/core/artifact-resend-v2.ts
src/core/artifact-resolution-v2.ts
src/core/chat-artifacts.ts
src/core/context-budget-v2.ts
src/core/context-data-v2.ts
src/core/context-results-v2.ts
src/core/context-v2-types.ts
src/core/context-v2.ts
src/core/inbox.ts
src/core/model-args.ts
src/core/policy-v2/confirmations.ts
src/core/policy-v2/executor.ts
src/core/router-shadow.ts
src/core/router.ts
src/core/safe-refs.ts
src/core/session-confirmation-v2.ts
src/core/session-input-v2.ts
src/core/sessions-v2.ts
src/db/migrations/013_v1_1_context.sql
src/modules/drive/worker.ts
src/modules/media/worker.ts
src/modules/school/attachments.ts
src/wa/normalize.ts
src/wa/outbox.ts
src/wa/types.ts
tests/artifacts-v2.test.ts
tests/context-v2.test.ts
tests/natural-foundations.test.ts
tests/r4-harness.ts
tests/sessions-v2.test.ts
```

Implementación y pruebas: `bdcadfd426d6d02992a5c5e1f482ae15e41b8c8a`.
Este informe y los documentos de arquitectura/control se entregan en el commit
posterior de la misma rama. Revisión del dueño pendiente; constructor detenido
tras el push, sin R5, deploy ni merge.
