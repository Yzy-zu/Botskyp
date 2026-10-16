# Fase 5 — Pruebas

**Fase aprobada por el arquitecto y lista para cierre técnico, sin correcciones
de código ni configuración** (DEC-046, 16-10-2026). La evidencia automática,
procesadores reales, worker, Gemini e integración existente es suficiente.
**Ninguna prueba física pendiente bloquea el cierre técnico**. Piper/voz,
sticker nativo y QR extremo a extremo quedan recomendables antes de activar
Multimedia fuera de Botsky Lab. No se eliminan tests, fixtures ni cobertura.

Verificación automática antes del despliegue:
- Typecheck, lint y build correctos.
- Suite completa **445/445**, 27 archivos, **289,44 s**, inicio 20:32:04 UTC.
  Conserva las 360 pruebas anteriores y agrega 85; no hay cobertura retirada.
- Tras el ajuste final de códigos de fallo, **82/82** pruebas multimedia, **18,53 s**,
  inicio 20:38:01 UTC. Cubre el código final de cola, retención y entrega.
- Wrapper Python Minecraft **14/14**, también dentro de la suite completa.
- Procesadores reales **17/17**, **35,407 s**, contenedor sin red con límites del
  worker. Incluye PDF/Office, QR, OCR, formatos audio/video/imagen, stickers,
  Piper, ZIP malicioso, PDF activo, traversal y seccomp heredado.
- Reinicio mediante SIGKILL de proceso real durante procesamiento de fixture:
  recupera el job, limpia el parcial y encola un único resultado.
- Descarga pública real del cliente seguro: audio Commons de 9036 bytes.
- Escaneo de archivos cambiados contra secretos locales: sin coincidencias.

El resultado de integración final y despliegue se encuentra al final de este documento.
Las pruebas físicas siguientes están pendientes y no son bloqueantes para el cierre
técnico (DEC-046); no se afirman como ejecutadas.
Solo Botsky Lab, archivos propios o de licencia abierta y pequeños.

1. `bot qr https://example.org/botsky` → aceptación de job; después PNG en Lab.
   Mientras se procesa: `bot ping` → pong sin esperar la conversión.
2. Citar el PNG recibido y enviar `bot lee qr` → TXT con
   el texto; no se abre la URL del QR.
3. Enviar una imagen propia JPEG/PNG de menos de 1 MB con `bot sticker` → sticker.
4. `bot junta estas fotos en un PDF`, enviar dos fotos propias, `terminar` → PDF.
   Otro usuario enviando imágenes no debe completar la colección ajena.
5. Reenviar ese PDF con `bot lee documento` → TXT, o `bot pdf a imágenes` → PNG
   por página; `bot recorta pdf 1-1` con el PDF citado → PDF de una página.
6. Enviar foto de texto con `bot ocr` → TXT; sin texto legible informa el fallo.
7. Enviar DOCX propio sencillo, sin enlaces/macros/objetos, con `bot oficina a pdf`
   → PDF en Lab. Documento externo/activo se rechaza; no habilitar macros.
8. Enviar audio propio corto con `bot convierte a mp3` → archivo de audio;
   `bot transcribe este audio` citado al original → TXT si hay cuota Gemini.
9. `bot voz Hola, esta es una prueba de Botsky.` → OGG; escuchar claridad/acento.
10. `bot busca música sonido campana` o `bot busca video Luna` → resultados de
    Commons compatibles, elegir un número → aceptación y descarga en Lab.
    Si no hay resultados dentro del límite o la fuente falla, debe decirlo.
11. `bot descarga https://127.0.0.1/a.mp3`, URL de YouTube o fuente ajena → rechazo.
12. `bot trabajos` → solo trabajos propios del chat; procesado y entrega separados.

No enviar archivos enormes ni ejecutar cargas masivas. La prueba de reinicio usa
primero el entorno aislado automático; una prueba física requeriría coordinación,
sin reiniciar Evolution ni Minecraft.

Integraciones repetibles (se ejecutan aparte de Vitest y nunca en paralelo con él,
porque el setup existente publica una única referencia a la BD aislada):

- `node --import tsx tests/phase5-media.eval.ts`: imagen worker real, QR y Piper,
  BD aislada, outbox con transporte simulado y una transcripción real Gemini.
  Requiere Node local 24, imagen `botsky-worker:phase5` o `PHASE5_WORKER_IMAGE`,
  `.env` local y cuota gratuita disponible. Cero envíos WhatsApp.
- `tests/media-engine.py`: 17 casos de binarios reales en contenedor sin red,
  usando el JSON de `config/product.ts` en `/tests/limits.json`, y script en
  `/tests/media-engine.py`; scripts/media montado read-only en `/app/scripts/media`.
  Flags de ejecución: `--network none --memory 768m --cpus .5 --pids-limit 64
  --read-only --tmpfs /tmp:size=256m,mode=1777 --cap-drop ALL
  --security-opt no-new-privileges`. No usar el entorno de producción como base.

## Resultado final de integración y despliegue

- `scripts/deploy.sh`: correcto desde `7675380`, respaldo previo verificado
  `botsky-20261016T203854-2377634.dump`, imágenes app/worker distintas e inmutables.
- `/health` HTTP 200, base y Evolution conectados; app/worker healthy.
- Migraciones 001–007 presentes. Conteos previos/posteriores idénticos en notas,
  recordatorios, escuela, partidas y Minecraft. Ningún grupo fuera de Lab habilitado.
- Con la imagen worker `botsky-worker:767538039b62`, BD aislada y proceso Python
  real: **QR + Piper correctos, 2 entregas simuladas confirmadas**.
- Gemini real transcribió ese audio: **34 caracteres**, cero tools/cambios externos
  y **0 envíos WhatsApp reales**. La primera llamada falló como provider HTTP no
  2xx, sin capturar el código/cuerpo; no fue un éxito. La ejecución diagnóstica
  siguiente pasó sin cambiar modelo, clave, formato o payload. No se atribuye
  causa HTTP exacta a un error que carece de esa evidencia (INC-20261016-09).
- Evidencia privada: `.local/phase5-full-tests-final.log`,
  `.local/phase5-last-media-tests.log`, `.local/phase5-engine-tests-final.log`,
  `.local/phase5-deploy.log`, `.local/phase5-real-integration.log` (primer fallo),
  `.local/phase5-audio-diagnostic.log` (integración posterior correcta).
- La BD aislada y credenciales temporales del evaluador se eliminaron mediante el
  teardown seguro existente; no se borró ninguna base de producción.

Las doce pruebas físicas anteriores **siguen pendientes y no bloquean el cierre
técnico** (DEC-046). No se enviaron sus
mensajes ni se afirma recepción real de stickers/audio/PDF/documentos. El dueño
puede empezar con `bot qr https://example.org/botsky` y `bot ping` en Botsky Lab;
la secuencia completa define los demás mensajes y resultados esperados.

## Verificación documental tras aprobación — 16-10-2026

DEC-046 registrada; roadmap y documentos de fase marcan **aprobada y lista para
cierre técnico**, sin correcciones de código ni configuración. Ninguna prueba
física pendiente es bloqueante. Piper/voz, sticker nativo y QR extremo a extremo
siguen pendientes y recomendables antes de activar Multimedia fuera de Lab.
No se eliminaron tests, fixtures ni cobertura.

- Typecheck, lint y build correctos, sin cambios a sus implementaciones.
- Suite completa **445/445**, 27 archivos, **209,47 s**, inicio **20:52:02 UTC**.
- Comprobaciones multimedia existentes **82/82**, 3 archivos, **18,79 s**,
  inicio **20:55:43 UTC**; ejecutadas separadamente de la integración.
- Procesadores reales **17/17**, **35,325 s**, con la imagen worker desplegada,
  sin red, 768 MiB/0.50 CPU/64 PIDs y filesystem read-only.
- Worker real en BD aislada: QR/Piper correctos y **2 entregas simuladas**
  confirmadas. Gemini real transcribió **34 caracteres**. **0 envíos WhatsApp**.
- Descarga pública de Commons correcta: **9036 bytes**, MIME application/ogg.
- Wrapper Minecraft ejecutado por separado: **14/14**, **0,028 s**, sin SSH real.
- `/health` **HTTP 200**, `ok/database/evolution=true`, `transport=evolution`,
  comprobado al terminar las verificaciones, alrededor de **20:56 UTC**.

App, worker y Evolution API/Postgres/Redis conservan imágenes y tiempos de arranque;
no hubo despliegue ni cambios de configuración. La BD aislada y los temporales del
evaluador se retiraron mediante el teardown existente. Solo cambian los cuatro
documentos de control autorizados. Evidencia privada en `.local/phase5-approval-*`.
Sin merge a main, Fase 6/7 ni activaciones fuera de Lab. Tras commit y push a
`phase-5-multimedia-documentos`, el constructor se detiene.
