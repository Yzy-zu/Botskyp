# Fase 5 — Multimedia y documentos

Implementada y desplegada en `phase-5-multimedia-documentos`, base
`afe4b84a853308c02c7e52e650d15b00310083cc`. La autorización directa del dueño
supera los estados históricos que prohibían iniciar Fase 5. Fases 0–4 cerradas y
fusionadas según el dueño. **Aprobada por el arquitecto y lista para cierre técnico,
sin correcciones de código ni configuración**, según confirmación del dueño del
16-10-2026 (DEC-046). Sin merge a main ni inicio de Fases 6/7.

Plan del cambio para revisión crítica (histórico; aprobado sin correcciones):
1. Migración aditiva para jobs idempotentes y adjuntos con ámbito y retención.
2. Registro de herramientas y sesiones propias para selección/colección.
3. Allowlist de Wikimedia comprobada desde el VPS, sin YouTube/cookies/cuentas.
4. Descarga HTTPS con DNS fijado, redirects revalidados y bytes/tiempo acotados.
5. Worker único separado del inbox, con límites CPU/RAM/procesos/temporales.
6. Procesadores con comandos cerrados, seccomp sin red y límites por operación.
7. Retención de originales 7 días, generados 2; limpieza solo de tmp dedicado.
8. Resultados a outbox con ámbito y permisos comprobados antes de entregar.
9. Pruebas de seguridad, reinicio, fallos, regresiones y wrapper de Minecraft.
10. Deploy oficial con backup/rollback; health y guía física de Lab; detener para revisión.

## Alcance

§3 Fase 5, §4 media/voz, §5.9, §6.5 y §9.6–9.7 del Plan Maestro.
Sin biblioteca, packs, cooperacha, Drive, campañas ni nuclear. Sin costos nuevos.

La única fuente externa inicial es **Wikimedia Commons**: búsqueda de audio/video
por texto mediante API MediaWiki y descarga de archivos originales desde
`upload.wikimedia.org/wikipedia/commons/<hash>/<hash>/<archivo>`.
Se conserva enlace a la página del archivo para consultar autor y licencia.
La compatibilidad es una capacidad comprobada en esta sesión, no una garantía de
disponibilidad futura. Un fallo del proveedor se informa, sin cookies ni evasiones.

## Arquitectura

La app valida intención/permisos, resuelve archivos actuales/citados/propios recientes,
abre una selección o colección por actor/chat y registra el job antes de responder.
Ninguna conversión corre en el inbox. `jobs` usa SKIP LOCKED y el lock global de
worker existente garantiza concurrencia 1. Límite 2 activos por actor entre chats,
20 globales; solicitudes repetidas actor/chat/mensaje no crean otro job.

El worker vuelve a comprobar permiso, modo y módulo. Verifica las referencias
contra inbox aceptado; descarga originales solo por la clave autenticada de
Evolution. Descarga pública exclusivamente mediante el cliente allowlist. Guarda
originales y generados con identidades distintas en `media_attachments` (bytea,
BD propia, incluidos en backup), nunca base64 en outbox. Los temporales viven en
`/tmp/botsky-media/<jobId>` sobre tmpfs y se limpian al terminar y al arrancar.
El total retenido tiene tope global de 256 MB para evitar crecimiento ilimitado.

Un solo commit de resultados guarda artefactos, outbox y estado procesado. Cada
archivo tiene dedupe independiente. `done` significa procesamiento terminado;
`bot trabajos` informa el estado de entrega separado. Solo outbox `sent` confirma
la entrega. Timeout después de enviar queda incierto y no se repite ciegamente.
Reinicio de un running vuelve a cola hasta tres intentos totales; después falla
con aviso único. Un job terminado no vuelve a procesarse al reiniciar.

## Límites iniciales

| Recurso | Límite |
|---|---:|
| Entrada total por job / salida total | 8 MB / 8 MB |
| Imagen / video entregado | 4 MB / 4 MB |
| Sticker estático / animado | 100 KB / 500 KB |
| Duración audio / video de entrada | 180 s / 120 s |
| Sticker animado | primeros 3 s, 512×512, 10 fps |
| PDF / OCR PDF | 20 páginas / 3 páginas |
| Archivos en colección | 10 |
| Imagen decodificada | 16 MP, lado máximo 4096 |
| Descarga / subproceso / job completo | 30 s / 120 s / 180 s |
| Redirecciones | 3, todas revalidadas |
| ZIP oficina | 500 miembros, 32 MB expandidos, ratio 100 |
| Texto extraído / voz literal / QR | 12000 / 500 / 1000 caracteres |
| Worker | 768 MiB, 0.50 CPU, 64 procesos, tmpfs 256 MiB |
| Procesadores | nice +10, un hilo, CPU 90 s, archivo individual 8 MB, AS 2 GiB |

El límite de espacio virtual por proceso complementa el límite real de RAM de
contenedor, no lo sustituye. El total de originales de una colección también
cuenta para los 8 MB. Exceder límites devuelve error; no se sube a Drive.

## Formatos y operaciones

- Imágenes JPEG/PNG/WebP/GIF → PNG/JPEG/WebP; sticker estático WebP.
- Audio MP3/OGG/WAV/M4A y video MP4/WebM/OGV → MP3/OGG/WAV o MP4 según
  pistas disponibles. MP4 normalizado H.264/AAC 640 px. Efectos cerrados:
  graves, rápido, lento. Sticker animado WebP desde video/GIF compatible.
- QR: generar PNG desde texto y leer texto de imagen. El contenido leído es dato,
  jamás se visita una URL contenida en el QR.
- OCR español/inglés de imagen o PDF de hasta 3 páginas.
- Lectura PDF/TXT a archivo TXT. Oficina DOCX/XLSX/PPTX → PDF.
- PDF: comprimir streams, recortar rango de páginas, unir PDFs, páginas a PNG,
  reunir imágenes en PDF. Comprimir no promete una reducción para cualquier archivo.
- Audio → transcripción Gemini con cuota gratuita existente; resumen opcional en
  bloque separado. Sin tools ni ejecución de instrucciones presentes en audio.
- Voz local Piper `es_MX-ald-medium`, texto literal. Calidad física pendiente de
  escucha del dueño; no se afirma validación auditiva.

## Seguridad y retención

HTTPS y hosts/rutas exactos; sin IP literal, puertos alternos, credenciales, fragments,
query arbitraria ni URLs propuestas sin validar. DNS IPv4 resuelto y todas sus
respuestas públicas; IP comprobada fijada al socket TLS conservando SNI y
validación de certificado. Cada redirect repite allowlist y DNS. IPv6 no se usa.
Content-Length, bytes reales, codificación y descarga completa se comprueban.

MIME admitido y firma real antes de procesar, más decodificación/probe acotados.
Nombres locales elegidos por backend; no se usan nombres originales ni rutas del
usuario/modelo. `spawn`/subprocess con arrays, sin shell, sin argumentos libres.
Procesadores reciben entorno mínimo sin claves ni credenciales; seccomp bloquea
sockets IP para ellos y descendientes. ffmpeg solo admite protocolo file y formatos
cerrados. Root filesystem read-only, usuario no root, sin capabilities.

Office inspecciona central directory, tamaños, ratio, entradas duplicadas, symlinks,
cifrado, macros, objetos embebidos y referencias externas; no extrae el ZIP.
LibreOffice usa perfil aislado con macros deshabilitadas. PDF rechaza scripts,
acciones activas y adjuntos incrustados; nunca ejecuta contenido del documento.
Los parsers tienen además timeout y límites de recursos ante archivos maliciosos.

Originales 7 días y generados 2 días (§0), con fecha de origen para adjuntos recibidos.
La limpieza periódica idempotente vacía solo bytes caducados y conserva metadatos.
No mezcla originales con tmp ni elimina archivos ajenos. Los backups conservan
bytes hasta su retención propia: la copia externa/rotación heredada sigue pendiente.

## Verificación y despliegue

Typecheck, lint y build correctos. Suite completa: 445/445 (360 regresiones + 85 nuevas), 27 archivos, 289,44 s. Tras los últimos ajustes de errores/retención se repitieron las 82 pruebas multimedia: todas correctas, 18,53 s. Wrapper Minecraft 14/14. Procesadores reales: 17/17 en 35,407 s. La integración final del worker y el despliegue están registrados en el apartado final. Pruebas físicas solo Botsky Lab,
contenido pequeño y legal. Nuevos módulos no se activan en grupos reales.
La revisión del arquitecto fue aprobada sin correcciones (DEC-046), incluidos los
cambios en sesiones, router, outbox y despliegue. La rama permanece sin fusionar.

La retención de una descarga URL pertenece a su solicitud; reinicios del mismo job
reutilizan su original. Una solicitud nueva puede volver a descargar el recurso,
con identidad original distinta y sin reescribir el historial de otra solicitud.
El dedupe de webhooks y la referencia única del job evitan repetir una solicitud.

## Despliegue y comprobación final — 16-10-2026

Desplegada por `scripts/deploy.sh` desde **`7675380`**. Respaldo previo verificado:
`backups/botsky-20261016T203854-2377634.dump`. Migración 007 aplicada; 001–006 intactas.
App y worker healthy; `/health` **HTTP 200**, `ok/database/evolution=true`,
`transport=evolution`. Documentación posterior no cambia esas imágenes.

- App: `sha256:e1d0cd5a41a9c0de25e94f3a70a2e991951b6ea7f18e4486e58ddcb9c8ed5621`.
- Worker: `sha256:4f5b4eb50fade85af9e14e6839eb0718b5de0544d2c7770b8b7e79e7f3a0021d`.
- Worker real comprobado en BD aislada, con la misma imagen: QR y Piper completan
  job → artefacto → outbox → dos confirmaciones de transporte **simulado**.
- API Gemini real aceptó el audio Piper y transcribió texto (34 caracteres), con
  modelo y cuota gratuitos existentes. No se envió ningún mensaje WhatsApp real.
  La primera ejecución devolvió error de proveedor; su código HTTP no se capturó.
  Una segunda ejecución diagnóstica equivalente pasó. No se inventa causa exacta:
  queda registrada la disponibilidad observada, sin prometer servicio permanente.
- Esto prueba entrada de audio y síntesis reales, no una entrega física de audio,
  calidad auditiva de voz ni el flujo completo de transcripción desde WhatsApp.
- Evolution API, su PostgreSQL y Redis conservan **exactamente** imagen y StartedAt.
  No se reinstalaron, reiniciaron ni cambió su configuración/base.
- Conteos conservados: notas 1, recordatorios 2, tareas 0, partidas 0 y operaciones
  Minecraft 0. Cero jobs media en producción, cero errores nuevos en los cinco
  minutos observados y cero grupos habilitados fuera de Lab.
- App sin ffmpeg/binarios pesados. Worker sin montaje de llave Minecraft;
  límites Docker observados: 768 MiB, 0.50 CPU y 64 PIDs.

**Estado:** implementada, desplegada, **aprobada por el arquitecto y lista para
cierre técnico**, sin correcciones de código ni configuración (DEC-046).
La evidencia automática, procesadores reales, worker, Gemini e integración
existente es suficiente para ese cierre. **Ninguna prueba física pendiente es
bloqueante**; permanece sin ejecución confirmada. Piper/voz, sticker nativo y QR
extremo a extremo quedan recomendables antes de activar Multimedia fuera de
Botsky Lab. Se conserva la guía y toda la cobertura, sin afirmar éxitos físicos.
Sin bloqueo de acceso/configuración. Se conserva el despliegue; esta tarea cambia
solo documentación de control y vuelve a ejecutar las verificaciones existentes.
Sin merge a main, Fases 6/7 ni activaciones fuera de Lab. Al terminar commit/push,
el constructor se detiene sin esperar pruebas físicas.

## Verificación documental tras aprobación — 16-10-2026

Aprobación registrada en DEC-046, roadmap y ambos documentos de fase; solo cambian
esos cuatro documentos. Sin correcciones funcionales/configuración ni despliegue.
La evidencia existente es suficiente para el cierre técnico; ninguna prueba física
pendiente bloquea ese cierre. Se conserva toda la cobertura.

Typecheck, lint y build correctos; **445/445 tests**, 27 archivos, **209,47 s**.
Comprobaciones multimedia **82/82**, **18,79 s**; procesadores reales **17/17**,
**35,325 s**; wrapper Minecraft **14/14**, **0,028 s**. Worker real QR/Piper y Gemini
correctos en integración aislada: dos entregas simuladas, transcripción de 34
caracteres y cero mensajes WhatsApp reales. Descarga Commons de 9036 bytes correcta.
`/health` **HTTP 200**, base y Evolution conectados, al terminar (~20:56 UTC).
App/worker/Evolution conservan imágenes y arranques. Detalle y evidencia en
FASE-5-PRUEBAS.md y logs privados `.local/phase5-approval-*`.

Piper/voz, sticker nativo y QR extremo a extremo permanecen recomendables antes
de activar Multimedia fuera de Lab, sin ejecución física confirmada. Tras commit
y push se detiene el constructor; sin merge a main ni inicio de Fase 6/7.
