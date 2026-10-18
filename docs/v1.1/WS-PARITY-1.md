# WS-PARITY-1 — capacidades existentes y UX natural

Fecha: 18-10-2026. Base verificada: f2be96d16fe8bdcc1502e54cee6d88a9f7cc6862,
feat/v1.1-natural-router, árbol limpio y remoto idéntico (0/0 tras fetch).
Un constructor, sin delegación, sin merge a main ni rediseño Legacy.

Estado de cierre: código `0cdaab3d1de770775ab1bfa7669d8aa8cf73b869` desplegado y sano. **656 pruebas únicas** por tandas focalizadas, **109 escenarios WS-PARITY**; typecheck/lint/build y auditoría correctos. Lab v1.1/resto v1 confirmados. Smoke real parcial; repetición de recordatorio, sticker y entrega PDF todavía pendiente del dueño. La evidencia cronológica inferior distingue ejecución, cola y entrega.

## Implementación

- Minecraft: exposición por minecraft/maicra/maincra/mine/mc/bedrock/server/servidor,
  typo real mimecragt y variantes acotadas minecr*/maincr*. Señales solo cargan
  dominio. Contexto conceptual indica servidor configurado sin host, IP ni paths.
  El Registry y Policy conservan consultas para miembros y escritura owner-only.
- Capability Truth: solo consultas inequívocas disponibles de estado/jugadores/
  recursos Minecraft, balance XP y web explícita pueden recuperar una respuesta
  textual que inventa inaccesibilidad. Un retry máximo, sin ejecución por regex,
  modo functionCall y mismas validaciones. Comparte el presupuesto de tres llamadas;
  no se encadena con retry de mutación. Si sigue sin tool, respuesta honesta de no
  ejecución. Métrica `capability_truth_retry=true`, sin texto ni identificadores.
- Daily: Registry explica premio/recompensa/giro gratis y balance coloquial. Ningún
  importe, cooldown, ledger ni permiso económico cambia; «un giro» puede aclararse.
- Recordatorios: el reloj explícito autenticado reconoce 8pm/8 pm/20:00/8 de la noche.
  Si falta el día se pregunta hoy/mañana. La fecha se congela y un fragmento temporal
  puede actualizar otro slot; actualizar hora no resuelve silenciosamente un día
  faltante. «Mañana» seguido de «de la noche» conserva mañana. Un nuevo intento XP
  escapa. La creación/edición coteja fila real antes de afirmar éxito.
- Cancelación: gramática completa de negativos naturales; confirmaciones aceptan
  callword sin aceptar afirmativos mezclados con correcciones. «Cancelalo» inmediato
  resuelve la última creación/edición exitosa con recibo, actor/chat y ventana de
  cinco minutos; crea SafeRef interna y pasa por reminders.cancel/Policy. Otra tool
  exitosa o un vencimiento impiden cancelar arbitrariamente un recordatorio anterior.
  Inbox permite esa continuación sin invocación, conservando activación por sesión.
- Artifacts: A_LAST y SafeRefs permanecen. OCR/lectura y diálogo semántico anterior
  solo entran ante referencia relevante, sin tema independiente nuevo. Imagen actual
  gana a reply; reply gana a última imagen reciente relevante. Solo una imagen por
  defecto. Un archivo actual incompatible no provoca fallback a una imagen antigua.
- Web explícita: hint de capacidad + retry acotado si Gemini sustituye la búsqueda
  por prosa/broma. La consulta se ejecuta mediante web.search; síntesis solo después
  del resultado. Búsqueda de videos/música sin web explícita no fuerza búsqueda web.
- Seguimiento media: prioriza operación propia reciente y, si reclama PDF, conversión
  compatible más reciente. Estados/error/entrega vienen de jobs/outbox. Una conversión
  fallida se explica sola; listar varios requiere petición expresa de historial.
- Colección: media.collect abre SessionV2 actor/chat, TTL de cinco minutos, cancelación
  y refs de artifacts existentes. Archivos sucesivos deduplicados; cierre ya/termina/
  terminar/hazlo construye SafeRefs internas y ejecuta media.process por Policy, ledger
  y cola existentes. pdf_merge requiere dos PDF. No hay tabla, worker o sistema de
  jobs nuevo. El cierre y cambio de sesión comparten transacción de la ejecución.

## Regresiones y límites

`tests/fixtures/v1.1/ws-parity-1.ts` y `tests/ws-parity-v2.test.ts` convierten la
conversación Canary en escenarios ejecutables: sticker sin arrastre, XP, nota,
maicra/mimecragt, Nuclear protegida + si botsky, daily, búsqueda realmente llamada,
8pm → mañana → cancelalo y explicación del PDF fallido. Añaden aislamiento,
expiración, idempotencia, slots mixtos, imágenes prioritarias y colección de fotos/PDF.
Gemini se simula en estas regresiones; no prueban por sí solas su selección en vivo.
Nuclear y Minecraft no ejecutan efectos remotos en tests.

No se corrige el timeout LibreOffice. media.search, Drive upload y previews escolares
siguen cerrados. No se incorpora yt-dlp, búsqueda adulta, voces/personajes,
affinity/lore/cooperacha visual. La captura tiene identidad de artifact por mensaje/
tipo y exige un adjunto por evento: admitir varios requiere una identidad individual;
la colección se usa enviando archivos sucesivos. No se simula soporte de lotes.
La comparación con varias imágenes queda para ese contrato.

## Verificación y Canary

628 pruebas únicas verificadas por tandas focalizadas en 17 archivos, sin suite
completa. La tanda amplia de 14 archivos dio 547/549; las dos diferencias eran
expectativas anteriores: 90 adaptadores en lugar de 91 y texto de un PDF inyectado
al reenviar sin pedir leerlo. Se actualizaron a 91/siete puentes cerrados y ausencia
de semántica al reenviar, comprobando además recuperación explícita de «lo anterior».
Ambas repeticiones pasaron 2/2. Las restantes 76 pruebas de contexto/sesiones/tiempo
pasaron en la tanda central; contexto se repitió 19/19 tras ocultar nombres antiguos.
Tres casos nuevos de cierre prueban discovery → retry, fallo web sin retry y cambio
de orden sin reutilizar éxito. La última tanda de routing pasó 13/13 (68 omitidos),
incluyendo esos tres y las fronteras cambiadas. No se suman repeticiones al total.

Comandos de cierre:

```text
npm test -- tests/ws-parity-v2.test.ts tests/tool-exposure.test.ts tests/natural-router-v2.test.ts tests/policy-v2.test.ts tests/artifacts-v2.test.ts tests/minecraft.test.ts tests/economy.test.ts tests/media-jobs.test.ts tests/media-security.test.ts tests/media-process.test.ts tests/reminder-time.test.ts tests/search-context.test.ts tests/tool-registry-v2.test.ts tests/router-canary.test.ts
npm test -- tests/ws-parity-v2.test.ts tests/tool-exposure.test.ts tests/context-v2.test.ts tests/sessions-v2.test.ts tests/semantic-time.test.ts
npm test -- tests/context-v2.test.ts
npm test -- tests/ws-parity-v2.test.ts -t 'capability truth|capability discovery|bounds capability|does not recover|real web failure|reordering|old image/OCR|exact Canary reminder|inbox activates'
npm test -- tests/policy-v2.test.ts tests/artifacts-v2.test.ts -t 'offers 91|runs DOCX'
npm run typecheck
npm run lint
npm run build
npm run audit:secrets
docker compose config -q
git diff --cached --check
```

Checks finales correctos; auditoría versionada: cero archivos con hallazgos.
Los 81 escenarios del archivo WS-PARITY se verifican como 78 en la tanda amplia y
los tres añadidos en el cierre; tool exposure tiene 45 casos. Las primeras tandas
216/216 y 197/198 no se agregan al total. La última diferencia de aquella tanda
central fue un test nuevo de «videos» cargado antes de la corrección de plural;
se cerró en la tanda amplia, junto con todas las señales finales.

Pruebas reales adicionales:

- 10 turnos aislados con Gemini gratuito confirmado, 13 respuestas del proveedor;
  transporte mock y BD efímera eliminada. Seleccionó status/players/typo Minecraft,
  daily, búsqueda web y recordatorio 8pm → mañana → cancelación persistida.
- Minecraft desde el host de prueba carece de las rutas montadas del contenedor:
  sus tres consultas devolvieron error real de conexión, sin pedir IP. Desde el
  contenedor productivo, dos lecturas reales status/players respondieron ok,
  servidor online, cero jugadores. Ninguna escritura remota.
- La primera web desde host falló por la dirección interna; con la IP del servicio
  de SearXNG solo en la configuración local de prueba, dos búsquedas reales dieron
  web.search/ok. La última ejercitó Capability Truth con tres llamadas totales,
  `capability_truth_retry=true`, sin repetir la tool. Incluyó un enlace real.
- Límite observado: en la pregunta de parentesco el modelo sobreinterpretó ausencia
  de información personal como una negativa. El hint pide no inferir esos datos;
  la calidad de esa conclusión sigue pendiente de evaluación. Se acredita ejecución
  de búsqueda, no verificación de parentesco.
- Procesadores reales del worker: dos imágenes → PDF de dos páginas; unión de dos
  PDF → cuatro páginas, con temporales aislados. El test de colección recorre además
  captura retenida → cola → worker → un artifact/outbox de PDF y conserva orden.

Canary: preparado para despliegue por scripts/deploy.sh. Selector validado en entorno:
default v1 y únicamente Lab en v1.1. Health previo HTTP 200 con BD/Evolution sanos.
Smoke WhatsApp todavía pendiente de mensajes del dueño; no se sustituye por pruebas
mock ni mensajes entrantes fabricados.


### Despliegue confirmado

Código desplegado: `5b1fa2fc07a7a2d807f41218b06ae917e9e44561`, push a la rama
autorizada y despliegue exclusivamente por `scripts/deploy.sh`. Respaldo previo
verificado: `botsky-20261018T004425-349253.dump`. Sin migraciones nuevas. App/worker,
PostgreSQL y SearXNG saludables. `/health` HTTP 200: database/evolution true y
transport evolution, verificado a las 00:45 UTC. No se tocó Evolution ni main.

Selector comprobado dentro del contenedor nuevo: default `v1`, allowlist con un
solo chat, Lab `v1_1`, un chat ajeno `v1`. No se reactivó mensajería masiva.
Escaneo adicional de 19 logs/artefactos locales de evidencia: cero coincidencias
de claves configuradas, credenciales de BD o identificadores privados del entorno.
Observación WhatsApp iniciada a las 00:45:40 UTC; el dueño confirmó disponibilidad
para enviar los mensajes reales. Resultado del smoke aún pendiente.

### Correcciones del smoke humano

Primera ventana desde 00:45:40 UTC: Minecraft status/players, daily y web/search
confirmados con entrega real, XP sin menciones de la imagen anterior. OCR sobre la
imagen nueva terminó y su texto fue enviado. Se encontraron tres variantes:

- Dictado «guarda un recuerdo para las ocho peeme»: dirigido a memoria y denegado.
  Registry distingue aviso futuro; el reloj entiende «ocho peeme» y la fecha faltante
  se pregunta aunque Gemini haya propuesto kind=date. Gemini real aislado posterior:
  pidió hoy/mañana, creó mañana 20:00 y canceló, sin escribir en producción.
- «Hazla Sticker» citaba un media_text/OCR enviado. Se añade resolución operativa
  hacia el input exacto de ese job, solo propio/mismo chat, con entrega y backing
  vivos. Se activa al resolver una operación; no carga automáticamente su imagen
  como semántica en el contexto. No recae en A_LAST si esa procedencia no existe.
- «Ya son todas» y «que ya son todas botsky entiende»: ahora cierran la colección.
  Repetir media.collect conserva refs y TTL; no reemplaza la colección con otra vacía.
  Los bytes originales de la primera prueba permanecieron retenidos.

Doce pruebas nuevas elevan el total a 640 únicas (93 en WS-PARITY). Cierre: 24/24
focalizadas de recordatorios/procedencia; 86/86 artifacts/sesiones/tiempo. Las de
colecciones quedaron verificadas en la tanda anterior; las dos discrepancias de
esa tanda fueron reloj dictado ya corregido y fixture de otro chat cuya conversación
está deshabilitada, reforzado con consulta directa de la procedencia cruzada.
La repetición final de procedencia pasó 7/7. Se añadió además la comprobación de fecha española explícita, para no preguntar de nuevo cuando el día sí fue indicado.

Cierre del ajuste: fecha española explícita y dictado 3/3; typecheck/lint/build
correctos nuevamente, sin ampliar la suite. Total final: **640 pruebas únicas**
por tandas focalizadas, **93 escenarios WS-PARITY**. Los fallos intermedios se
cerraron con pruebas de la causa; las repeticiones no aumentan ese total.


### Segundo despliegue

`79336fb` enviado a la misma rama y desplegado por el script oficial con respaldo
verificado `botsky-20261018T010126-372701.dump`. Health HTTP 200, BD/Evolution
conectados y selector dentro de la app: Lab v1.1, allowlist de uno, resto/default v1.
Observación de la repetición iniciada a las **01:02:32 UTC**. Se pidió repetir solo
recordatorio, sticker por reply al resultado de lectura y colección con dos fotos.
Los resultados de esta repetición se incorporan al cerrar la ventana humana.

### Cierre natural de la segunda repetición

El dictado de fecha con prefijo («para oí, para las 8 piem», «QUE PARA OOIII») quedó sin consumir. Ahora para hoy/mañana conserva cuerpo/reloj; la variante homófona se limita a la elección de fecha pendiente. «Oí» sin ese contexto conserva escape de intención. La validación de hora pasada sigue vigente.

Las dos fotos sí permanecieron retenidas, pero «kon esas hazlo» volvió a iniciar collect: el contrato solo expresaba inicio. media.collect incorpora action=start|finish únicamente en v1.1. El modelo recibe operación/número de archivos y puede finalizar sin depender de frases exactas. El cierre revalida sesión, actor, chat, módulo y vencimiento, y ejecuta media.process por Policy en la transacción existente. Replay deja un único job.

Última tanda: **29/29** pruebas relevantes; **652 únicas** acumuladas, **105 escenarios WS-PARITY**. Typecheck, lint y build correctos. Gemini real con BD efímera y transporte mock: iniciar → foto → foto → cierre natural produjo media.collect/queued y media.process/queued, una conversión; sin afirmar entrega. Se verificará esa entrega en Lab después del tercer deploy.

### Revisión de recibos y anulación falsa

El tercer deploy a10c7d4 quedó sano a las 01:13:30 UTC, respaldo botsky-20261018T011220-387841.dump, Lab v1.1/resto v1. Todavía sin nuevos mensajes humanos en esa ventana. La revisión histórica del primer smoke encontró «cancelalo mejor» → «ya te lo anulé» sin ejecución; luego un listado falso sin pendientes. No se acredita esa cancelación: el recordatorio de hoy 20:00 permanece pending.

Se acepta mejor como prefijo/sufijo solo de una cancelación completa, se expone productivity con recordatorios en plural y se bloquea la variante de efecto inventado ya te lo anulé. Cuatro regresiones adicionales; **51/51** focalizadas de cancelación/sesiones/exposición. Total **656 únicas**, **109 escenarios WS-PARITY**. Gemini gratuito aislado: aviso 8pm → pregunta fecha → mañana 20:00 → cancelalo mejor ejecuta cancel/ok → listado real sin pendientes. No se hizo cancelación administrativa del registro humano ni se alteró el criterio de referencia reciente.

### Despliegue final y límites del smoke

`0cdaab3d1de770775ab1bfa7669d8aa8cf73b869` enviado a la rama autorizada y desplegado por `scripts/deploy.sh`, respaldo verificado `botsky-20261018T011646-395152.dump`. Health HTTP 200 con database/evolution true; app, worker, PostgreSQL y SearXNG sanos. Selector verificado dentro de la nueva app: default v1, allowlist de un chat, Lab v1_1, chat externo v1. Mensajería masiva de Lab sigue apagada; cero Nuclear/escrituras Minecraft en las ventanas observadas. Main permanece 0c1a19e.

Ventana final abierta a las 01:17:54 UTC. Dueño avisado del despliegue y de la necesidad de repetir recordatorio → mañana → cancelación, sticker por reply textual y dos fotos → PDF. No se fabrican mensajes entrantes ni se acredita entrega sin outbox sent. El recordatorio histórico de hoy 20:00 sigue pendiente según la última lectura; se informó la afirmación falsa y se indicó listado/selección segura para cancelarlo.

Verificación adicional local: 47 logs/archivos de evidencia comprobados sin coincidencias de claves configuradas, credenciales de BD ni identificadores privados del entorno; permisos locales restringidos. La auditoría versionada final no encontró secretos. Los datos privados de WhatsApp no se incorporan al repositorio.

## Corrección Arquitectónica: Base AI-First / Natural-First (18-10-2026)

### Principio "Gemini entiende. Tools hacen. Backend valida."

Se eliminaron del backend todos los intentos de aprendizaje o normalización lingüística en TypeScript (`normalizeClockText()`, `ocho -> 8`, `piem/peeme -> pm`, diccionarios de afirmaciones/negaciones como `confirmationInputV2`). Se retiró SessionV2 del camino de NLU previo a Gemini, restableciéndolo como coordinador puro de estado sin NLU.

### Cambios Arquitectónicos Implementados

1. **SessionV2 Zero-NLU:** `decideSessionV2` no consume lenguaje humano. Solo procesa expiraciones por TTL y recolección de adjuntos (`collect`). Todo lenguaje humano se envía a Gemini.
2. **Proyección Segura de Contexto (`activeSession`):** El Context Builder proyecta `kind`, `pendingTool`, `partialArgs` seguros para el modelo, `missingSlots`, `prompt` y `expiresLocal`. Cero filtración de JIDs, UUIDs internos, hashes o paths de sistema de archivos.
3. **Continuación y Corrección de Slots:** `mergeClarificationArgsV2` combina de forma estructurada los slots proporcionados por Gemini con los argumentos parciales de la sesión, actualizando la sesión in-place mediante `openClarificationV2` sin generar filas redundantes.
4. **Escape de Intención:** Las sesiones activas no capturan el turno; intenciones distintas (ej. `xp.balance`) son seleccionadas directamente por Gemini mientras la sesión previa permanece intacta.
5. **Meta-tools Estructuradas:** `core.session_confirm` y `core.session_cancel` exponen al modelo interfaces explícitas sin argumentos sensibles, coordinadas a través de revalidación completa de Policy R3 (`callOrigin: 'session'`).
6. **SemanticTime Estructurado:** Gemini produce `kind: 'clock'` cuando falta fecha o cuando la hora 1..12 es ambigua. El backend valida schemas Zod y aplica políticas sin re-evaluar el texto en crudo con regexes lingüísticos.

### Evidencia de Smoke Tests con Gemini Real (`gemini-3.5-flash-lite`)

Ejecutados en `tests/smoke-gemini.test.ts` con API Key real (sin filtrar secretos):
- **Escenario 1 (Prompt deforme sin fecha):** `"botsky guarda un rekor para las 8piem y di q estoy tontiks"` → Gemini llama `reminders.create` con `time.kind = 'clock'`, `hour = 20`, `meridiem = 'pm'`. Backend detecta falta de fecha y abre clarificación: *"¿Para hoy o mañana?"*.
- **Escenario 2 (Continuación con homófono):** `"para joi komo alas ocho piem"` → SessionV2 proyecta sesión activa; Gemini interpreta `joi` como hoy y llama `reminders.create` con `time.kind = 'today'`, `hour = 20`. Recordatorio creado exitosamente.
- **Escenario 3 (Corrección de slot):** Sesión con mañana 20:00 + `"nel mejor el viernes como a las nueve"` → Gemini actualiza el slot a viernes 21:00 conservando el mensaje.
- **Escenario 4 (Escape de intención):** Sesión de recordatorio activa + `"cuanto xp tengo we"` → Gemini llama `xp.balance` (retorna *"Tienes 500 XP"*); la sesión de recordatorio permanece activa.
- **Escenario 5 (Confirmación natural):** Confirmación pendiente de Minecraft + `"si botsky"` → Gemini llama `core.session_confirm({})`; Policy R3 revalida y encola `minecraft.restart`, marcando la sesión como `done`.
- **Escenario 6 (Cancelación natural):** Confirmación pendiente de Minecraft + `"nel ya estuvo"` → Gemini llama `core.session_cancel({})`; la sesión se marca como `cancelled` y Botsky confirma la cancelación sin cambios.
