# R5 — Natural Router integrado

Base aprobada: `3721a6a215218d42f41b275bb9ca948874e73322`.
Solo `feat/v1.1-natural-router`; sin deploy, merge, Canary ni grupos reales.

Plan del cambio crítico:
1. Conservar v1 y shadow; enrutar v1_1 después del ingreso vigente.
2. Compartir transacción de inbox con Policy/executor para evitar locks cruzados.
3. Consumir SessionV2 inequívoca y fast path exacto antes de Gemini.
4. Construir contexto y exposición dinámica; preservar content/parts/IDs opacos.
5. Limitar llamadas, expansión y retry; ejecutar solo propuestas del turno actual.
6. Proyectar resultados visibles y componer deterministas localmente.
7. Exigir outcome estructurado y evidencia actual para afirmaciones de efectos.
8. Integrar solo puentes seguros; conservar los restantes explícitamente cerrados.
9. Mejorar entrega textual/progreso multimedia sin cambiar procesadores DOCX.
10. Verificar escenarios, suite completa y checks; documentar, push y detenerse.

## Flujo implementado

`route()` conserva íntegro el cuerpo legacy y solo deriva a `routeNaturalV2`
cuando `ROUTER_MODE=v1_1`. El ingreso conserva elegibilidad y activación vigentes.
Una interacción propia vigente (SessionV2 o partida) mantiene activación para
que «de la noche», «otra carta» o un intent nuevo puedan llegar al router sin
repetir la palabra de activación. No abre conversación ambiente fuera de ese
ámbito. Shadow sigue con legacy visible, SELECTs instrumentales y cero llamadas
Gemini/efectos adicionales.

SessionV2 consume únicamente confirmación/cancelación completa o slot inequívoco.
Toda continuación que produce efecto llama executeToolV2. AM/PM congela primero
el día local; «de la noche» completa 20:00 para hora 8. Un nuevo intent retorna
not_consumed y continúa al router. Los atajos v1.1 son coincidencias completas,
sin errores de sintaxis para frases parciales; coincidencia exacta usa cero IA.

Después se capturan adjuntos autenticados con los límites/retención históricos,
se construye el snapshot R4, se seleccionan dominios y se cargan refs acotadas.
No se crearon regex que conviertan las paráfrasis del dataset en herramientas.
Las señales de exposición añaden plurales «clases» y «recuerdas/recuerdos» para
no omitir esos dominios. Horario, tareas y creación de tarea tienen prioridad
sobre administración escolar al repartir los 20 schemas; la elección y los
argumentos siguen siendo function calling.

El modelo solo propone modelArgsSchema. Policy conserva schemas Zod estrictos,
SafeRefs vivas, SemanticTime y toda la autoridad sobre actor/chat/rol, permisos,
propiedad, economía y efectos. Los aliases hit/stand/double se traducen a los
movimientos históricos. Los campos backend-only se rechazan y cuentan en métricas
sin almacenar nombres/valores arbitrarios del modelo.

## Loop Gemini y límites

Se usa el adapter REST existente. Referencia oficial consultada:
[Content/Part/FunctionCall/FunctionResponse](https://ai.google.dev/api/generate-content#content).
Se conserva content completo, orden original de parts, campos desconocidos y
thoughtSignature opaca. FunctionResponse conserva exactamente ID y nombre de su
FunctionCall. Si no vino ID, no se fabrica. Solo las parts del content actual son
autoridad para seleccionar calls: un campo calls legacy inconsistente se ignora.
IDs repetidos dentro del turno se rechazan antes de admitir otra herramienta;
el mismo ID en turnos distintos sigue siendo válido y scoped por turnId.

Cada invocación del router lleva turnId fuera del prompt, hacia llm_usage.turn_id
(migración 014 aditiva). ToolExecution conserva su FK y su origen R1–R3. Los
contents del proveedor nacen de cero en cada turno y nunca importan calls
históricas. Eventos previos son referencias declarativas, nunca ejecuciones.

| Límite | Valor y alcance |
|---|---|
| MAX_TOOL_CALLS_PER_TURN | 3 propuestas, incluso meta/denegadas; límite conservador más fuerte que tres efectos |
| MAX_CAPABILITY_EXPANSIONS_PER_TURN | 1 expansión válida |
| MAX_TOOLS_PER_TURN | 20 schemas, contando core.load_capability |
| Generaciones | 3; adapter también conserva presupuesto de tres intentos REST |
| Mutation retry | 1, únicamente si aún no hay resultado de negocio |
| Synthesis | Una vuelta sin schemas de tools; sus calls nunca se ejecutan |

core.load_capability valida dominio estricto, módulo, chat, rol/contexto, capacidad
y expansión previa. No crea ToolExecution ni efecto de negocio. Al ampliar,
recarga refs del dominio y conserva las ya enviadas mediante unión de snapshots
backend del mismo turno. Si no puede ampliar, explica la limitación sin ejecutar.
Al agotar límites devuelve los resultados locales disponibles y señala lo que
quedó sin realizar. Nunca repite una mutación por un timeout de respuesta.

## Veracidad y composición

La defensa principal es estructural: efectos se redactan desde ToolResult y se
contrastan con ToolExecution ok/queued del turno actual, incluso al recuperar un
recibo por replay. Un recibo viejo no acredita una acción nueva. Gemini no puede
presentar su propio texto como recibo de una mutación.

Conversación y síntesis usan outcome JSON estricto con text y effects. Una salida
sin contrato, con effects declarado o con action_required no acredita éxito.
Solo action_required permite una única corrección para elegir tool o explicar
la imposibilidad. Una afirmación de éxito sin recibo termina honestamente; no
induce una mutación nueva para justificar lo que el modelo dijo.
La detección textual adicional de afirmaciones como guardado/voto/XP es una
comprobación diagnóstica conservadora del incumplimiento del contrato. Una salida
conversacional malformada sin indicio de acción no induce tools ni un retry de
mutación; devuelve un error honesto. La comprobación no reemplaza
la evidencia durable ni demuestra semántica perfecta de texto arbitrario.

Presenter local cubre XP/saldo/diario, memoria, notas, recordatorios, juegos,
encuestas, confirmaciones, denials, módulos apagados, colas y consultas simples.
Los otros handlers adaptados conservan una presentación canónica saneada sin
exponer su JSON al modelo. No hay otra llamada para decir que se guardó una nota.
Los datos exactos del backend no se reestilizan mediante IA.

La integración detectó contratos históricos que deduplican por mensaje, aunque
Gemini pueda proponer varias calls: media, juegos, colas Drive, creación/voto de
encuestas, creación de tareas, compra de packs y apertura/aporte de cooperacha.
Policy ahora impide que una segunda acción distinta use el recibo de la primera.
Los replays exactos siguen devolviendo su recibo R3. En media solo se admite una
operación/reenvío distinto por mensaje; los pasos de la cadena van en mensajes
sucesivos. La identidad del artifact también se vincula al hash de admisión.
El voto presentado se lee de poll_votes, no se infiere de la opción solicitada.

Web devuelve título/snippet/URL estructurados y síntesis responde la pregunta con
fuentes compactas. Varias lecturas pueden sintetizarse; si incluyen XP, apuestas o resultados de
biblioteca/cooperacha, se presentan localmente para que el modelo no reescriba
saldos ni importes. Si falla la síntesis,
se conserva el resultado local y, para web, extractos/fuentes disponibles. Antes
de cualquier tool, un fallo del proveedor devuelve una explicación breve.

FunctionResponse usa proyección explícita de datos visibles y mensaje natural.
No exporta JIDs, IDs DB, hashes, rutas, excepciones, SQL, secretos ni ToolResult
interno completo. Una respuesta de síntesis con nuevas calls no las ejecuta.
Toda salida pasa por sanitizer antes de la outbox y de cruzar el transporte.
Denials distinguen owner/admin, módulo apagado, saldo insuficiente y contexto.
Confirmaciones describen el contenido/alcance y piden «sí» o «nel», sin hashes ni
argumentos JSON. Persona mantiene utilidad primero y reduce sarcasmo en temas serios.

## Media y visión

Media.process resuelve current/reply/ref/A_LAST con la matriz histórica y vuelve
a validar ownership/backing/expiry. El worker admite el backing escolar además
del de media mediante claves exclusivamente backend. No se cambió el conversor
LibreOffice, el tratamiento DOCX ni su rendimiento.

El reenvío reutiliza resendArtifactV2 y artifact_deliveries en la transacción del
executor: no crea un nuevo job y conserva revalidación al entregar. Fija la ref
al artifact que Policy seleccionó, sin volver a interpretar A_LAST por una carrera.
Los nombres visibles de archivos nuevos/reenvíos no contienen UUIDs ni job IDs.

qr_read, ocr, read y transcribe entregan texto directamente si tiene hasta 3000
caracteres. Un texto mayor lleva preview y el .txt generado por el pipeline
existente. Ambos revalidan backing y retención antes del envío. Al expirar, el
cleanup también retira el texto/preview almacenado en payload de outbox; no
prolonga la vida del contenido extraído. Los extractos R4 conservan sus límites
y política previa. No se cambia el archivo fuente al leerlo.

El progreso se persiste como outbox diferida 2,5 segundos. Si el job termina,
se descarta el aviso aún no enviado. Un job activo puede avisar «Aguanta, ya estoy
preparando tu archivo…». No hay IDs ni estados técnicos en ese mensaje. Resultado:
«Listo, aquí tienes tu PDF», sticker directo, transcripción/QR en texto. El código
histórico no_text_found se presenta como ocr_empty/qr_empty/read_empty según la
operación; OCR vacío no se confunde con un fallo de descarga.

Visión consume la imagen actual, citada o propia reciente de R4, independiente
de la pregunta. Una imagen pública citada en el mismo grupo conserva el actor
original; no se transfiere ownership. No existe breedQuestion. No se habilitan
transformaciones de archivos ajenos por el hecho de poder observar una cita.

## Revisión explícita de los nueve puentes R3

| Puente | Estado R5 | Motivo/ruta segura |
|---|---|---|
| media.process | Integrado | Refs/backing scoped, MIME/operación, Policy, cola/worker existentes; resend con procedencia R4 |
| media.search | Bloqueado | Falta portar selección persistida a SessionV2/SafeRefs; no reutilizar selección legacy a escondidas |
| media.collect | Bloqueado | Falta collector SessionV2 con procedencia y cierre atómicos |
| school.schedule_propose | Bloqueado | Preview/commit legacy aún dependen de sesiones/hash v1; requiere puente específico |
| school.schedule_import | Bloqueado | Mismo preview seguro y extracción/confirmación escolar pendientes |
| school.schedule_commit | Interno y bloqueado | Nunca aceptar IDs/hashes ni confirmación fabricada por Gemini |
| school.destination | Bloqueado | Falta loader/referencia de destino escolar y su contrato específico |
| bulk.confirm | Interno y bloqueado | El flujo de confirmación ya pasa por SessionV2 → executor; esta tool no se expone |
| drive.upload | Bloqueado | OAuth/Drive permanecen apagados; falta selección/backing y contrato de subida seguro |

Resultado: 90 adaptadores explícitos de 98; ocho puentes cerrados, dos internos.
Una tool visible o un dominio cargado no conceden permiso ni garantizan proveedor
configurado. No se pretende declarar «96 tools funcionales» con bypasses.

## Pruebas y evidencia

Dataset versionado: tests/fixtures/v1.1/natural-r5.ts. Pruebas principales:
tests/natural-router-v2.test.ts. Se usan respuestas programadas del proveedor y
el adapter REST real con HTTP simulado; no se usaron regex de selección ni se
hicieron peticiones reales para aparentar validación semántica de un modelo vivo.
Los efectos de memoria, notas, XP, votos, juegos, recordatorios, cooperacha,
artefactos, jobs y ledger sí se verifican en PostgreSQL aislado.

Se cubren los cinco falsos éxitos, variantes con contrato estructurado inválido,
conversación sin tools, límites/expansión/retry, roles, denials, confirmación,
inyección backend, datos visibles, firmas/IDs, búsqueda, visión y retención.
Secuencias: mundial → dólar → XP; blackjack → hit → stand; DOCX → PDF → comprimir
→ leer → reenviar; mañana 8 → noche; misma aclaración → nuevo intent XP. La
activación y la transacción compartida se comprueban también desde inbox.

Procesadores reales afectados: cinco tests del engine existente (QR, OCR, lectura
literal, operaciones PDF y conversiones/audio), con subcasos, todos verdes.
Contenedor efímero sin red, solo mounts de lectura, 768 MiB/0,5 CPU/64 PIDs,
filesystem read-only y tmpfs. No se ejecutaron pruebas físicas ni modificaciones
reales de Evolution/Minecraft/WhatsApp.

La evidencia final de suite/checks y commits se agrega al cerrar la validación.


## Consumo y fronteras de la evidencia

No hubo peticiones Gemini reales ni facturación: HTTP/proveedor simulados. La
ruta determinista natural usa una generación; expansión o síntesis suelen usar
dos; atajos y continuaciones inequívocas usan cero. Se conserva el tope de tres,
los límites configurables existentes y todos sus defaults productivos.
En la fixture del adapter REST se observaron 240 tokens de entrada y 60 de salida
en dos peticiones simuladas (120/30 cada una); no son una medición de Google ni
una estimación de costo real. Las métricas de latencia con mocks tampoco predicen
rendimiento de producción.

Métricas sanitizadas: callsPerTurn (incluye intentos REST/retries cuando se usa
el adapter), inputTokens, outputTokens, toolCount, capabilityExpansion,
synthesisUsed, routerLatency, mutationRetry y backendFieldAttempts. No almacenan
prompts, recuerdos, argumentos, IDs o trazas privadas. llm_usage conserva la
vinculación de turno en BD, fuera del prompt y de esos logs.

Limitaciones deliberadas: ocho puentes de la tabla anterior; Drive/OAuth apagado;
transformaciones ajenas no habilitadas; contexto histórico acotado R4; catálogo
de biblioteca según capacidades existentes, sin motor nuevo de búsqueda documental.
La conversación requiere que Gemini cumpla el outcome estructurado; una salida
fuera de contrato falla honestamente y puede gastar el único retry. Los tests
programados no demuestran precisión semántica de un proveedor vivo para todas
las paráfrasis ni seguridad lingüística universal. No hay pruebas físicas,
despliegue, healthcheck de R5, Canary ni activación productiva implícita.

## Cierre automático y commits

| Evidencia | Resultado |
|---|---|
| Suite Vitest completa, una sola pasada | **1125/1125**, **51 archivos**, 991,62 s |
| Focalizadas de cierre (router/Policy/artifacts/media/exposure) | **284/284**, cinco archivos, 302,18 s |
| Cierre de composición/privacidad (incluye importes protegidos) | **10/10**, 16,12 s; 96 casos no seleccionados por filtro |
| Procesadores reales afectados | **5/5**, con subcasos de QR/OCR/texto/PDF/audio |
| typecheck / lint / build | Verdes |
| audit:secrets | Cero archivos versionados con hallazgos |
| Compose config / diff check | Verdes, sin aplicar Compose |

No se suman las repeticiones de pruebas como cobertura nueva. El archivo del
router contiene 106 pruebas distintas, verificadas entre las tandas de cierre.
Los cinco falsos éxitos exigidos y cuatro variantes adicionales se comprueban
como prosa y como texto estructurado: cero afirmaciones falsas enviadas y cero
efectos creados para justificar una afirmación. Solo action_required habilita el
retry de selección; una afirmación falsa devuelve directamente la respuesta honesta.

La suite completa se inició con la integración 048d281. Los ajustes de revisión
posteriores se verificaron con focalizadas, sin repetir la suite completa. Una
tanda intermedia se descartó como evidencia de cierre: el runner había cargado
el compositor antes de editar sus expectativas, produciendo diez discrepancias
de versión. Se repitió con código congelado (284 verdes). El último saneamiento
del mensaje de functionResponse y el guard de importes en resultados múltiples
se comprobaron con las diez pruebas finales, manteniendo typecheck/lint/build.
No quedan fallos conocidos de las comprobaciones ejecutadas.

Comandos principales (Node 24 local):

```text
npm test -- tests/policy-v2.test.ts tests/context-v2.test.ts tests/sessions-v2.test.ts tests/artifacts-v2.test.ts tests/tool-registry-v2.test.ts tests/llm.test.ts
npm test -- tests/natural-router-v2.test.ts tests/router-shadow.test.ts tests/natural-foundations.test.ts tests/llm.test.ts tests/media-jobs.test.ts tests/tool-exposure.test.ts
npm test -- tests/natural-router-v2.test.ts tests/policy-v2.test.ts tests/media-jobs.test.ts tests/media-process.test.ts tests/media-security.test.ts tests/minecraft.test.ts tests/tool-exposure.test.ts
npm test -- --reporter=default --reporter=json --outputFile=.local/r5-full.json
npm test -- tests/natural-router-v2.test.ts tests/policy-v2.test.ts tests/artifacts-v2.test.ts tests/media-jobs.test.ts tests/tool-exposure.test.ts
npm test -- tests/natural-router-v2.test.ts -t 'function response|multiple results never|multi-tool reads|web search answers|real REST adapter'
npm run typecheck
npm run lint
npm run build
npm run audit:secrets
docker compose config --quiet
git diff --cached --check
```

Los tests de procesadores usaron la imagen worker ya disponible y el engine
existente, en contenedor efímero sin red; no se construyó ni desplegó una imagen
R5. Los reportes temporales y credenciales permanecen ignorados bajo .local.
Los tests de Minecraft/masivos usan mocks/fixtures; no se envió Nuclear, no se
reinició Minecraft ni se enviaron mensajes WhatsApp reales.

| Commit de código | Contenido |
|---|---|
| f1f656f | Contabilidad Gemini vinculada al turno durable y migración 014 |
| 048d281 | Integración Natural Router/Policy/Composer y UX de archivos |
| 1766946 | Admisión conforme a dedupe legacy, replay exacto, importes protegidos, compatibilidad v1 |
| 2de275e | Saneamiento de datos y mensaje de functionResponse |

El HEAD final es el commit documental posterior que contiene este informe.
Main continúa en 0c1a19ef919f759ac65bee7117ec26c2d70a286b. No se modificó el .env
activo ni se aplicaron migraciones a producción. No hay deploy, merge, Canary,
activación de grupos, OAuth ni activación productiva del Natural Router/Gemini v2.
Se publica únicamente feat/v1.1-natural-router y el constructor se detiene.
