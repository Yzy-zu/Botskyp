# WS-PARITY-1 — capacidades existentes y UX natural

Fecha: 18-10-2026. Base verificada: f2be96d16fe8bdcc1502e54cee6d88a9f7cc6862,
feat/v1.1-natural-router, árbol limpio y remoto idéntico (0/0 tras fetch).
Un constructor, sin delegación, sin merge a main ni rediseño Legacy.

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
