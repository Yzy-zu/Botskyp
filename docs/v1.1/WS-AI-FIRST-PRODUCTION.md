# WS-AI-FIRST-PRODUCTION — 18-10-2026

Baseline `c25acac`, código de Manifest `6b70610`, misma rama autorizada. Un
constructor sin delegación. Sin merge ni proveedores/features nuevos.

## Cambios

- Exposición inicial solo por always-on, meta-tools, sesión y adjuntos CURRENT,
  y entidades abiertas. Ninguna palabra selecciona dominios.
- Se retiró `artifact-relevance-v2.ts`. Memorias privadas, diálogo y resultados
  pequeños dependen de scope/módulos/estado; metadata CURRENT/REPLIED/RECENT/A_LAST
  permanece disponible. RECENT/A_LAST nunca adjuntan bytes automáticamente.
- `core.load_artifact_context` recibe una SafeRef entregada, revalida actor/chat,
  permisos, backing y TTL, y añade únicamente esa imagen después de su respuesta
  nativa. El contenido original del proveedor, IDs y thought signatures se conservan.
- Selección explícita de artifacts precede a CURRENT/REPLIED. A_LAST significa
  exactamente el último, sin buscar otro archivo compatible a escondidas. Sin ref,
  solo se admite CURRENT/REPLIED; Gemini debe elegir cualquier archivo antiguo.
- El presupuesto real podía retirar schemas al final de un dominio grande.
  `load_capability` acepta `toolName` exacto del Manifest para priorizar el schema
  elegido por Gemini; se valida su pertenencia al dominio. Sin ranking por texto.
- No fast paths conversacionales v1.1. Retry genérico por action_required;
  unavailable se contrasta mediante evidencia estructurada del modelo con Registry,
  operaciones/salidas técnicas y disponibilidad. Ninguna frase dispara el retry.
- Policy entrega códigos y missingSlots; Gemini formula la pregunta. SessionV2
  continúa siendo coordinador de datos estructurados y TTL, sin NLU.

## Cobertura real

| Inventario Registry | Cantidad |
|---|---:|
| Registradas | 98 |
| Públicas representadas en Manifest | 96 |
| Callables v1.1 (sujetas a permisos/scope/módulos/configuración) | 96 |
| Internas | 2 |
| Handler público ausente | 0 |
| ADAPTER_UNAVAILABLE con handler existente | 0 |

Solo `bulk.confirm` y `school.schedule_commit` son mecanismos internos. No existe
salida DOCX; no se añadió. Drive conserva su configuración OAuth/carpeta/correo y
su acceso restringido. El timeout histórico LibreOffice sigue fuera de alcance.

Los adapters conectan `media.search` con selección estructurada SessionV2 y URLs
permitidas; `drive.upload` con el backing elegido y nueva validación en worker;
`school.destination` con refs de destinos escolares autorizados;
`school.schedule_import` con lectura de la imagen seleccionada y propuesta Gemini;
`school.schedule_propose` con preview de todas las clases, confirmación de segundo
turno y revisión escolar congelada. Solo el executor puede invocar el commit real.

## Multiajunto

La migración 015 amplía la unicidad del original de mensaje a mensaje/ordinal y
reemplaza la unicidad de artifact mensaje/kind por mensaje/ordinal. Conserva todas
las filas previas y deduplica capturas School/Media del mismo ordinal. Cada adjunto
se descarga mediante su clave de proveedor autenticada, nunca repitiendo una clave
indistinta para simular dos imágenes. La API de descarga, verificada contra Evolution instalada **2.3.7**, sigue el
[contrato oficial Evolution](https://docs.evoapicloud.com/api-reference/chat-controller/get-base64).

El contrato inbound `Msg.attachments` conserva `providerMessageId` individual para
fuentes múltiples. Un evento WhatsApp de un solo medio conserva su clave histórica.
No se inventó un endpoint de álbum ni se prometen payloads que Evolution no emite.
Los álbumes que Evolution entrega como mensajes individuales siguen el flujo real
SessionV2 de colección. Se prueban dos entradas reales de attachments desde receive,
retención, registro, SafeRefs, ARTIFACT_STATE, router y Policy hasta dos fuentes
persistidas en un único job images_pdf; no se construye Artifact State a mano.

## Auditoría focalizada del runtime

| Superficie/hallazgos inspeccionados | Clasificación final |
|---|---|
| tool-exposure: signals, lexicalDomains, semanticHints | SEMANTIC-NLU retirado |
| artifact-relevance: referencias, dominios y visión por palabras | SEMANTIC-NLU retirado; archivo eliminado |
| prepare-artifacts: sticker/pdf/OCR/transcribe e historial por texto | SEMANTIC-NLU retirado |
| context: memoria, diálogo, resultados, filenames y visión por frases | SEMANTIC-NLU retirado |
| memory.remember y Policy: explicitMemoryRequest sobre raw text | SEMANTIC-NLU retirado de v1.1; v1 conserva su contrato |
| normalize/media.status: historial/PDF por frase | SEMANTIC-NLU retirado; devuelve trabajos acotados |
| capability-truth: web/Minecraft/XP por texto actual/respuesta | SEMANTIC-NLU retirado; evidencia estructurada |
| exactFastPathV2 | SEMANTIC-NLU fuera de ruta v1.1; solo observador shadow legado |
| SessionV2 trim y hasNonEmptyTurnTextV2 | TECHNICAL: presencia de texto, nunca aceptación/cancelación |
| schemas, MIME/extensión, HH:mm, URLs, UUID/JID, SafeRef, enum de operaciones, nombres/IDs de tools, Sets y startsWith de prefijos técnicos | TECHNICAL |
| contextData/output-sanitizer, secretos, sensitiveMemory y comprobación de claims de efectos en salida del proveedor | POLICY/SAFETY |
| activated/callWord, menciones y reply al bot | POLICY/SAFETY: destinatario de la conversación; no elige intención/tool/dominio |
| inbox: enrollment, deshabilitar, reactivar y silencio por texto | Solo v1; v1.1 usa habilitación persistida, flags y tools de Gemini |
| módulos, permisos, identidad, membresía, ledger, confirmación y cooldown | POLICY/SAFETY estructurada |

Resultado exigido: **0 SEMANTIC-NLU alcanzables en v1.1** en exposición, sesiones,
Policy, selección de artifacts e intención de memoria. Regex técnicas y de
privacidad conservadas. Las invariantes de código y las pruebas con input aleatorio
se mantienen separadas de las evaluaciones semánticas del proveedor.

## Promoción y límites

ROUTER_MODE es global; ROUTER_V1_1_CHAT_IDS se ignora incluso si contiene datos
viejos/malformados. Default v1_1 en configuración/Compose. Un rollback explícito a
v1 sigue disponible. No se habilitan chats nuevos automáticamente. Los grupos
recién inscritos por el flujo anterior conservan sus OFF explícitos; los módulos
sin un OFF de producto siguen el default normal global. Drive y biblioteca Drive
continúan sujetos a configuración real, sin activar OAuth ni servicios.

Inspección productiva inicial: solo un grupo habilitado (Lab), ningún privado
persistido. No existe un segundo grupo habilitado para un smoke productivo. La
selección global de otro grupo y del privado elegible se comprueba en integración,
y el selector del contenedor se comprobará sin inscribir chats nuevos.

Validación previa: typecheck, lint y build en verde; 440/440 pruebas de nueve
archivos de integración, 54 pruebas previas de catálogo/invariantes/rollout y
53/53 revalidaciones del ajuste final (cinco archivos, sin llamadas reales).
Gemini real resolvió dos adjuntos hacia images_pdf y seleccionó explícitamente la
imagen anterior; sin mensajes WhatsApp ni worker externo. Auditoría de secretos:
0 archivos con hallazgos. Backup previo verificado:
`botsky-20261018T165055-1573671.dump`.

El ajuste final limita exposición estrictamente a always-on/meta/sesión/CURRENT y
entidades abiertas. Los recordatorios pendientes se entregan como referencias
personales acotadas cuando el módulo está habilitado, sin precargar sus schemas.
Gemini carga el dominio al necesitarlos. La entrega física WhatsApp sigue pendiente.

Auditoría por ubicación de los usos conservados: [107 ubicaciones](AI-FIRST-RUNTIME-AUDIT.md).
Los tests legacy fijan explícitamente ROUTER_MODE=v1 para verificar su contrato;
los tests naturales simulan el protocolo load_capability y SafeRefs del modelo,
sin llevar esas decisiones al backend.

## Revisión del contrato multimedia

Una repetición real abrió media.collect en lugar de producir inmediatamente un
PDF. El Manifest describía su salida solo como PDF, aunque start únicamente abre
una sesión. Se precisó la metadata junto al Registry: start recibe más archivos
en mensajes posteriores; finish genera el PDF de la sesión. media.process acepta
la lista completa y ordenada de fuentes. Los schemas explican la diferencia;
ningún branch ni palabra del usuario fue añadido al backend. La comprobación
real pasó después de esta corrección genérica de contrato: 43/43 en la tanda
final de tres archivos, incluida la prueba Gemini real con ambos escenarios.
Typecheck, lint, build y auditoría de secretos volvieron a pasar. El proveedor
puede equivocarse: la validación técnica no garantiza interpretación perfecta.

## Despliegue verificado — 17:00 UTC

Código desplegado **aba5cfe8ca9c250d0965af6fa806cbd0d4c1314c** mediante
scripts/deploy.sh, después del commit de implementación 51f58dc. Backup del script
verificado: `botsky-20261018T165820-1584174.dump`. Migración 015 aplicada.
El commit posterior a este código solo cierra documentación; no se fusionó main.

Comprobación dentro de app: default=v1_1, Lab=v1_1, privado owner elegible=v1_1,
usesLegacyAllowlist=false; 96 públicas/96 callables/2 internas/0 sin adapter;
Manifest 96/96. Solo un grupo está habilitado: Lab. La selección de un segundo
grupo habilitado está cubierta por integración, pero la prueba en otro grupo
productivo es imposible mientras no exista uno autorizado. No se inscribió ninguno.

Se habilitó messaging en Lab: su único OFF era canary.messaging_disabled, sin
control.modules posterior. Un evento ai_first.promote_modules registra el cambio.
Drive y biblioteca Drive siguen sin configurar; OFF explícitos de producto se
respetan. No hubo jobs activos, bulk_ops pendientes ni smoke de efectos masivos.

Health HTTP 200: ok/database/evolution=true, transport=evolution. App y worker
running/healthy. PostgreSQL propio, SearXNG, Evolution API, Evolution PostgreSQL y
Redis conservan ID, imagen y StartedAt anteriores. Solo app/worker se reemplazaron.

Rollback inmediato: ejecutar `.local/ai-first-rollback/rollback.sh` desde el repo.
Restaura entorno y app/worker por IDs inmutables del despliegue anterior 6b70610;
ambas imágenes están disponibles y la sintaxis del script fue verificada. Conserva
la BD: la migración es compatible. El snapshot privado incluye settings anteriores
por si se necesita revertir también la promoción del módulo. No se ejecutó rollback
ni se probó ningún mensaje WhatsApp; manuales pendientes en el documento de pruebas.
