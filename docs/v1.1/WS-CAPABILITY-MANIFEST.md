# WS-CAPABILITY-MANIFEST — 18-10-2026

Implementación sobre `feat/v1.1-natural-router`, HEAD inicial
`f8d6a7edca71b310803ae7a4c520faad6ab60ca0`. Sin merge a main, nuevos tools ni
backends. Código final desplegado: `6b70610bfa3f9dee53782fdf3bbd4f33a011fd16`.
El commit posterior de cierre solo registra evidencia documental.

## Diseño y fuente única

`createRegistry()` sigue reuniendo las tools reales. Su metadata `capability`
vive junto a cada definición en `src/modules/*` y `src/core/control-tools.ts`:
resumen breve, salida y, cuando aporta información, entrada/operaciones. No hay
un catálogo independiente de capacidades en el prompt. El catálogo v2 copia esta
metadata, usa la descripción del Registry como fallback de resumen y extrae los
nombres de entrada del contrato model-safe existente. Los enums se proyectan como
operaciones/elecciones finitas, sin tipos, límites ni esquemas JSON completos.

`capabilityManifestV2()` recorre ese catálogo completo, agrupa por sus 14 dominios
y calcula disponibilidad para actor/chat/configuración actuales. No filtra lo
apagado, restringido ni pendiente de adapter: el modelo conoce su existencia y la
limitación. Se retiró del prompt el viejo directorio semántico escrito a mano;
la vista de compatibilidad del directorio también se deriva de esa metadata. Las
señales lexicales preexistentes solo optimizan qué schemas se cargan.

Cobertura: **98 tools registradas, 96 públicas, 96 representadas, missing=0**.
Las dos internas son `bulk.confirm` (preview/hash ligado) y
`school.schedule_commit` (commit de preview autenticado). El modelo usa las
meta-tools existentes de SessionV2 para confirmar; no recibe estos mecanismos.
La prueba de consistencia coteja el inventario completo, exige metadata o motivo
interno y falla ante herramientas sin contrato/metadata descriptiva.

## Multimedia y verdad de formatos

`media.process` describe **26 operaciones**: las 25 de la matriz real `conversions`
y `resend`. Las descripciones se añadieron a esa misma matriz, usada por validación
y worker. Sus entradas y salidas vienen de la matriz, no de una copia del prompt.
El enum model-facing reutiliza el enum multimedia existente más `resend`.

Ejemplo extraído del contenedor desplegado, con configuración y módulos reales
de Botsky Lab para el owner:

```text
[media]
media.process: Convertir, crear o leer multimedia y documentos. archivo/URL/texto→archivo/texto (trabajo asíncrono);A
 sticker: Crear sticker estático WhatsApp; png/jpg/webp/gif → webp
 animated_sticker: Crear sticker animado WhatsApp; mp4/webm/ogv/gif → webp
 qr_read: Leer código QR de imagen; png/jpg/webp/gif → txt
 office_pdf: Convertir Office a PDF; docx/xlsx/pptx → pdf
 pdf_merge: Unir varios PDF; pdf → pdf
 images_pdf: Reunir imágenes en PDF; png/jpg/webp/gif → pdf
media.search: Buscar música/audio/video en Wikimedia. query,type→selección;U
 type=audio/video
media.collect: Coleccionar imágenes o PDF; iniciar/finalizar colección. imágenes[]/PDF[]→PDF (trabajo asíncrono);A
 operation=images_pdf/pdf_merge;action=start/finish
```

El bloque real incluye todas las demás conversiones, efectos bass/fast/slow, QR
crear, OCR, lectura, transcripción y voz. No hay salida DOCX: entender el formato
solicitado no autoriza inventar una operación de conversión.

## Disponibilidad y schemas dinámicos

La cabecera define `A=AVAILABLE`, `C=CONFIG_REQUIRED`,
`U=ADAPTER_UNAVAILABLE`, `D=DISABLED`, `R=PERMISSION_RESTRICTED`.
Los motivos proceden de `adapterAvailable()` de Policy, `permitted()`, scope,
`moduleEnabled()`, flags emergency/maintenance y configuración Minecraft/Drive.
`library.sync` distingue su variante Drive no configurada. `memory.list` recuerda
que la consulta personal requiere privado. AVAILABLE significa que puede
intentarse: no promete stock, cuota, conectividad ni un efecto confirmado.

Los schemas siguen limitados a 20, con una expansión de dominio por turno. Las
tools sin adapter permanecen en el manifest, pero no se ofrecen como funciones
ejecutables: no se invita al modelo a proponer una conexión que Policy rechazaría. La
expansión rota schemas ajenos para que el dominio solicitado quepa completo,
incluso sin lexical hit. El modelo recibe un protocolo con nombres exactos de las
funciones expuestas, generado desde esas declaraciones en cada llamada.

Las pruebas reales iniciales detectaron llamadas a nombres vistos en el manifest
sin cargar schema y argumentos inventados. v1.1 usa `VALIDATED` y la lista de
funciones expuestas; solo el retry previo de consultas read-only disponibles conserva `ANY` una vuelta.
El retry general de action_required permite una limitación sin llamada: la
evaluación real detectó que forzar ANY podía ejecutar una lectura alternativa
cuando el modelo ya había explicado que no produce la salida solicitada.
No se fuerza un efecto tras cargar un dominio si luego resulta no existir la
salida solicitada. v1 no recibe este cambio de modo. Contrato verificado en la
[referencia oficial de Gemini](https://ai.google.dev/api/caching#Mode), consultada
el 18-10-2026. Nunca se ejecutan pseudo-tools escritas dentro de JSON `effects`.

## Artifacts, sesión y presupuesto

Cada turno natural recibe conjuntamente `CAPABILITY_MANIFEST`, `ARTIFACT_STATE`,
`REFERENCE_DATA.activeSession` y `CURRENT_USER_TURN`. Artifact State contiene:

- `CURRENT`: lista de adjuntos retenidos del turno con SafeRef individual, kind y MIME.
- `REPLIED`: artifact citado, mediante `A_REPLY`, o null.
- `RECENT`: referencias recientes propias acotadas, sin texto histórico ni filenames.
- `A_LAST`: referencia al último artifact propio retenido o null.
- `UNRETAINED_CURRENT`, cuando aplica: adjuntos recibidos sin backing disponible,
  solo kind/MIME/estado; no se inventa una SafeRef ni se sustituye por un archivo viejo.

No expone paths, UUIDs internos, JIDs, hashes ni detalles del almacenamiento. El
backend sigue revalidando propiedad, vigencia y compatibilidad de cada referencia.
Las fuentes de resultados textuales citados reutilizan el mecanismo scoped ya
existente. Una sesión pendingTool/partialArgs/missingSlots junto al archivo actual
permite interpretar naturalmente una continuación; también conserva rango de
páginas y summary. No se añadió NLU al coordinador Zero-NLU de SessionV2.

Manifest medido: **9,898 caracteres, 10,277 bytes UTF-8, ~2,475 tokens** por la
heurística chars/4. El tamaño de las peticiones reales completas se mide aparte.
El presupuesto de contexto sigue en 16,000 caracteres; conserva manifest, sesión
y Artifact State, retirando primero referencias de menor prioridad. El límite
REST sigue en 32,000: la exposición ajusta schemas al espacio real disponible.
Tras load_capability se envía contexto actualizado sin duplicar manifest, reglas
ni solicitud actual, que siguen en el historial firmado de ese mismo turno.

## Verificación

Verificación completada por tandas: 660 pruebas únicas de los 20 archivos focalizados,
incluidas 19 pruebas Gemini real. La tanda amplia inicial pasó 656/659; se corrigieron
y reejecutaron los cuatro archivos afectados completos: **189/189 en verde**.
Una prueba nueva del router para salida no soportada eleva el total único de 659 a 660.
Comando reproducible para la evaluación real:

```bash
export PATH="$PWD/.local/node/bin:$PATH"
BOTSKY_MANIFEST_LIVE=1 npx vitest run tests/capability-manifest-live.test.ts
```

La suite ordinaria omite las llamadas reales salvo opt-in.
La evaluación real desactiva la optimización lexical, usa datos e identidades de
prueba y no ejecuta operaciones externas. Sus casos multifichero son una proyección
sintética explícita del contrato del modelo, no evidencia de ingestión multiajunto.
El smoke adicional del router usa Policy/base temporal: sticker queda queued,
daily exige recibo persistido y no se acredita entrega WhatsApp.

Las seis frases adicionales se proporcionan durante la ejecución desde un archivo
local ignorado por Git; no están en fixtures ni en el código de producción.
Se respeta la cuota gratuita y el cooldown del proveedor; no se activa facturación.

## Backends pendientes, fuera de alcance

- Adapters v1.1 ausentes: `media.search`, `drive.upload`, `school.schedule_propose`,
  `school.schedule_import`, `school.destination`. Quedan visibles como U.
- No existe salida DOCX. No se añade en este workstream.
- Ingestión de dos archivos del mismo tipo en un único evento: el baseline deduplica
  por mensaje/kind y captura un adjunto. El modelo puede conocer varias fuentes,
  pero esta tarea no cambia almacenamiento ni normalización.
- Timeout LibreOffice documentado previamente para Office→PDF. El manifest describe
  la operación existente; no promete que un worker externo vaya a terminarla.
- Drive/biblioteca Drive siguen sujetos a su configuración local y módulos vigentes.

No reparar estos backends después de la entrega. La prueba física de WhatsApp la
realiza el dueño en Botsky Lab; las pruebas aisladas no sustituyen ese recibo.

## Resultados de producto con Gemini real

16 evaluaciones de descubrimiento con optimización lexical desactivada y tres
pruebas del router completo (cuatro intenciones: sticker, daily, completar source
y salida no disponible). Modelo configurado: gemini-3.5-flash-lite, cuota gratuita
ya existente. Sin llamadas a handlers externos ni entregas WhatsApp desde estas
pruebas. Las propuestas nativas respetaron nombres/schema expuestos.

| Input del dueño | Resultado observado sin aliases |
|---|---|
| botsky haz estas foto pidief | load media → media.collect, images_pdf |
| pasame este a wordsito | load media → unavailable; reconoce Word/DOCX y explica que no produce esa salida |
| hazlo stoker | load media → media.process, sticker |
| q onda el maikrasito | load minecraft → minecraft.status |
| dame lo gratis q toca cada dia | xp.daily |
| lee ese cuadrito raro de la foto | load media → media.process, qr_read; imagen QR real en el input |
| junta estos documentos | load media → media.collect, pdf_merge |
| que dice este audio | load media → media.process, transcribe |
| Este botsky, sesión pdf_compress pendiente + CURRENT PDF | media.process, pdf_compress; también queued por Policy/router real |

Respuesta del router real a la salida no disponible: «No mms, no tengo función
para convertir PDF a Word (docx). Te lo puedo leer si quieres.» **Cero trabajos
multimedia creados** en ese caso. No se ejecutó la alternativa ofrecida.
Sticker y compresión quedaron queued en la base temporal; daily tuvo recibo ok
persistido. No se acredita archivo procesado ni entregado por estas pruebas.

Inputs nuevos inventados durante la ejecución, fuera de fixtures versionados:

| Input nuevo | Selección real |
|---|---|
| las fotiyaz pegamelas en un librito dijital pa mandarlo | images_pdf |
| el cuadrito ese de puntitos destapalo q trae adentro | qr_read |
| escuxha la notita de bos y escribeme lo q dise | transcribe |
| el serbidorsiyo de los cubitos sigue bibo o q | minecraft.status |
| aver mi regalito del dia sin apostarle nadita | xp.daily |
| sacame las letras desta imagen pa copiarlas | ocr |

Las 16 evaluaciones del modelo usaron 29 requests, 209,971 tokens de entrada
y 768 de salida acumulados. Máximo observado: **20 schemas**, request completo
**28,888 caracteres**, inferior a 32k. Estos consumos no incluyen los cuatro
recorridos adicionales de Policy/router ni las iteraciones de diagnóstico.
El primer smoke alcanzó 429; se respetó cooldown y se espaciaron las siguientes
llamadas, sin cambiar cuotas, keys ni facturación de producción.

Cobertura automática: Registry/metadata, manifest/cobertura, contexto/budget,
exposición y load_capability, router/anti-false-success, Policy, artifacts/SafeRefs,
SessionV2, media, estado de entrega, búsqueda y selector Canary. La prueba de
idempotencia de dos tareas carga ahora el schema si fue rotado por presupuesto;
conserva la exigencia de una sola tarea y la denegación de la segunda acción.

Rechecks posteriores: Word modelo/router correctos, cero alternativas ejecutadas;
disponibilidad identificada como búsqueda multimedia no conectada/no disponible.
Se aceptan formulaciones equivalentes de esa limitación, no una palabra literal.
Último recheck real de availability: 1/1; las otras 18 se omiten deliberadamente
porque ya quedaron verificadas en 19/19 y 189/189.

Typecheck, lint, build, auditoría de secretos del árbol actual (0 hallazgos),
Compose y diff-check en verde.

## Deploy Canary confirmado

- Código `6b70610bfa3f9dee53782fdf3bbd4f33a011fd16`, commit y push en
  `feat/v1.1-natural-router`; sin merge. Main conserva `0c1a19e`.
- `scripts/deploy.sh` completado; backup previo verificado
  `botsky-20261018T153118-1469050.dump`. Sin migraciones nuevas.
- Health HTTP 200: ok/database/evolution=true, transport=evolution. App/worker healthy.
- Selector comprobado dentro de la app nueva: default v1, allowlist de un chat,
  Lab v1_1 y un chat ajeno v1. La lista contiene únicamente Lab.
- Evolution API, su PostgreSQL/Redis, PostgreSQL propio y SearXNG conservan ID,
  imagen y StartedAt del snapshot anterior. No se modificó Minecraft ni se
  realizaron envíos de WhatsApp, Nuclear o difusión de prueba.
- Manifest extraído del contenedor con settings reales de Lab: 96 capacidades,
  9,898 caracteres / 10,277 bytes; media.search U y bulk.nuclear D.
- Mensajería masiva de Lab permanece apagada. Drive/biblioteca Drive sin nuevas
  activaciones; no se activaron grupos ni módulos.

La prueba física WhatsApp queda en FASE-WS-CAPABILITY-MANIFEST-PRUEBAS.md. El
workstream autorizado se cierra aquí; no se implementan los backends pendientes.
