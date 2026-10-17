# Fase 7 — Pruebas y evidencia

Rama `phase-7-mensajeria-difusion-nuclear-drive`, base `ffc30aa`.
Pruebas reales únicamente Botsky Lab. **No se ha ejecutado Nuclear físico ni
enviado mensajes reales de esta fase por el agente. Sin OAuth ni peticiones reales
a Drive.** Simulaciones y acuses de mocks no prueban recepción WhatsApp humana.

**Estado: aprobada arquitectónicamente y lista para cierre técnico** (DEC-054,
17-10-2026), sin correcciones de código, migraciones, scripts ni configuración.
Las pruebas físicas de difusión y Nuclear no bloquean el cierre técnico y son
requeridas solo antes de activar fuera de Botsky Lab. OAuth y política de retención
remota son necesarias únicamente antes de activar Drive, que sigue deshabilitado.
No se eliminan tests ni cobertura.

## Cobertura añadida

- `messaging.test.ts`: owner/admin/member/LID, scope de grupo, límites 5–10 y
  defecto 8, confirmación ligada/caducidad/hash alterado, doble webhook, confirmación
  concurrente, destino inválido/revocado/manipulado, separación persistida,
  cancelación y carrera con claim, retry manual/cap/Retry-After, incertidumbre y
  reconciliación positiva, cooldown, volumen global y aislamiento entre chats.
- `drive.test.ts`: deshabilitado por defecto, configuración strict, carpetas/ACL
  restringidas, scopes actor/chat y resultados caducados, doble solicitud, cola
  compartida con media, checksum/tamaño/carpeta/archivo cambiado o faltante,
  descarga de original, enlace privado/rechazo si falta acceso, adjunto propio,
  ID preasignado, subida/compartición ambiguas, offline, cancelación, retención,
  lease de ACL, permisos de configuración y recuperación de lecturas/escrituras.
- `messaging-restart.test.ts`: **SIGKILL de proceso real** tras recibo del proveedor
  simulado; reconciliación sin repetir y solo pendientes restantes de Nuclear,
  intervalos reales persistidos. SIGKILL después del POST de subida simulado:
  conserva ID remoto, `review`, cero replay ni enlace falsamente confirmado.
- `evolution.test.ts`: conserva todos los casos existentes y añade HTTP 201/PENDING
  con ID, acuse real de contrato, historial pendiente/confirmado, aislamiento de
  chat/cita y Retry-After. 4xx/429/5xx/red/408 siguen cubiertos.

Las 548 regresiones se conservan. La integración con media solo comparte los locks,
admisión y límites de jobs; no elimina tests ni cambia procesadores. Nuevas tablas
viven en PostgreSQL de pruebas `botsky_test_*`; nunca se truncan datos de producción.
Suite completa y multimedia se ejecutan secuencialmente para no compartir el
puntero privado de test-DB entre dos procesos Vitest.

No se añadió programación genérica en esta fase. Duplicación de programaciones,
CDMX, recurrencias, caída/catch-up y recuperación de Escuela/lluvia/recordatorios
mantienen su cobertura existente en la regresión. Nuclear/difusión se retoman
por estado persistido sin generar una ráfaga de vencimientos después de una caída.

## Verificaciones

Pasadas diagnósticas de integración: 100/100 en cuatro archivos y 130/130 en cinco
archivos (incluida media), sin efectos externos. Dos fallos iniciales de preparación
se corrigieron: un test esperaba pong antes del aviso FIFO pendiente y otro intentaba
borrar una outbox todavía referenciada por jobs. No se relajaron permisos, intervalos,
reconciliación ni constraints. No se usan esas pasadas fallidas como aceptación.

La ejecución final usa el código congelado **88a8281**, desplegado el 16-10-2026.

| Comprobación | Resultado |
|---|---|
| Typecheck / lint / build | Correctos |
| Suite completa | **639/639**, 34 archivos, **431,29 s** |
| Regresiones / nuevas | **548 / 91**, sin eliminar casos anteriores |
| Multimedia focalizada | **82/82**, 3 archivos, **23,67 s** |
| Procesadores reales | **17/17**, **22,446 s**, misma imagen inmutable del worker desplegado |
| Wrapper Minecraft | **14/14**, **0,057 s**, transporte Docker simulado |
| `/health` | **HTTP 200**, ok/database/evolution true, transport evolution |
| Nuclear / WhatsApp / OAuth Drive físicos | **Pendientes**, sin ejecución confirmada |

Logs privados fuera de Git: `.local/phase7-focused-tests.log`,
`.local/phase7-integration-tests.log`, `.local/phase7-final-tests.log`,
`.local/phase7-multimedia-tests.log`, `.local/phase7-minecraft-wrapper.log`,
`.local/phase7-before-db.json` y `.local/phase7-before-services.json`.

## Verificación documental tras aprobación — 17-10-2026

DEC-054 registra la aprobación comunicada por el dueño. Esta ejecución solo cambia
los cuatro documentos de control; conserva código, configuración, migraciones,
scripts, tests y cobertura. Sin nuevo despliegue, activaciones ni mensajes físicos.

La primera pasada completa dio **636/639**: tres casos de `restart.test.ts` fallaron
con `Child did not start` al superar el plazo de arranque de diez segundos mientras
se ejecutaban typecheck/lint/build y procesadores. Se repitió la suite completa sin
esas verificaciones simultáneas y pasó **639/639** en **466,97 s**, sin cambiar tests
ni ampliar timeouts; el resultado respalda la contención durante el arranque como
causa de esos tres fallos. La primera ejecución de procesadores no pudo leer el
JSON temporal de límites por permisos;
se hizo legible ese archivo de prueba sin secretos para el usuario del contenedor
y la repetición pasó **17/17**. No se cambió configuración del proyecto ni producción.

| Comprobación repetida | Resultado |
|---|---|
| Typecheck / lint / build | Correctos, exit 0 |
| Suite completa | **639/639**, 34 archivos, **466,97 s** |
| Regresiones / nuevas | **548 / 91**, sin eliminar tests ni cobertura |
| Multimedia focalizada | **82/82**, 3 archivos, **24,97 s**, ejecutada después de la suite completa |
| Procesadores reales | **17/17**, **44,600 s**, imagen inmutable del worker desplegado |
| Wrapper Minecraft | **14/14**, **0,199 s**, transporte Docker simulado |
| `/health` | **HTTP 200**, ok/database/evolution true, transport evolution |

App y worker conservan las imágenes inmutables documentadas abajo y siguen healthy.
Fase 7 queda **aprobada y lista para cierre técnico**. Las pruebas físicas de
difusión/Nuclear siguen pendientes y se requieren solo antes de activar fuera de
Lab; OAuth y política de retención remota, solo antes de activar Drive. Sin merge
a main ni inicio de Fase 8; el constructor se detiene tras commit/push documental.

Logs privados de esta ronda: `.local/phase7-approval-tests-initial.log`,
`.local/phase7-approval-tests.log`, `.local/phase7-approval-typecheck.log`,
`.local/phase7-approval-lint.log`, `.local/phase7-approval-build.log`,
`.local/phase7-approval-multimedia.log`, `.local/phase7-approval-processors.log`,
`.local/phase7-approval-minecraft.log` y `.local/phase7-approval-health.json`.

## Despliegue e integridad verificados

Script oficial, respaldo previo verificado
`backups/botsky-20261016T234214-2620889.dump`; sin modificar deploy/backup/rollback.
Migraciones 001–009 presentes. Checksum 009 coincide con el SQL de la imagen.
Imágenes inmutables desplegadas:

- App: `sha256:5a15dafbda538d5bea5607189d191bf6fc9c1ae083d3c6b3508cd53bf718d767`.
- Worker: `sha256:f89a3ee0fa1c7db83b507cb4a865c44e0e6948924761c2f842145c65df778445`.

App/worker healthy y cero warnings/errores nuevos en sus logs inspeccionados.
Evolution API/PostgreSQL/Redis mantienen imágenes y StartedAt idénticos al snapshot
previo; no se modificaron base, vinculación, configuración o redes de Evolution.
Fingerprint de notas (1), recordatorios (2), tareas escolares (0), partidas (0) y
operaciones Minecraft (0) idéntico antes/después. Ningún grupo habilitado fuera de Lab.

Cinco tablas nuevas vacías y cero jobs bulk/Drive en producción. No se generaron
envíos de fase por SQL, webhook artificial ni mensajes reales. Drive operativo y
Drive de biblioteca deshabilitados; `.local/drive` 700, UID/GID 1000, sin credenciales.
App sin montaje OAuth/rclone; worker sin llave Minecraft. Worker conserva 768 MiB,
0,50 CPU, 64 PIDs y filesystem read-only. Los procesadores reales corrieron con
esos límites, en contenedor independiente sin red; incluye QR/OCR/oficina/PDF,
audio/video/Piper/stickers y seccomp en descendientes.

Más logs privados: `.local/phase7-deploy.log`, `.local/phase7-real-processors.log`,
`.local/phase7-health.log`, `.local/phase7-after-db.json` y
`.local/phase7-after-services.json`.

## Límites y estado tras aprobación arquitectónica

Implementada y desplegada; **aprobada y lista para cierre técnico** (DEC-054), sin
merge ni Fase 8. OAuth y pruebas físicas no se atribuyen a mocks. Configuración
exacta en FASE-7.md. Menciones Nuclear deshabilitadas hasta verificar fiabilidad física.
Drive requiere carpeta privada/correo local y OAuth separado; no hay enlaces
públicos, documentos nativos o Shared Drives. Archivos fuera de límites se rechazan.
Inciertos masivos o escrituras Drive interrumpidas requieren evidencia/revisión,
sin comandos para inventar confirmaciones. La retención privada remota de archivos
subidos y los backups externos/rotación heredados quedan pendientes operativos;
la política de retención remota y OAuth son requisitos solo antes de activar Drive.
No se eliminan archivos remotos automáticamente. Nuclear sin menciones cumple
§9.10 porque las menciones dependen de soporte fiable de Evolution; se conserva la ráfaga
obligatoria de 5–10 mensajes y todos los límites implementados. El constructor se
detiene tras verificaciones y commit/push documental.

## Guía física pendiente — solo Botsky Lab

No habilitar fuera de Lab. Se conservan contenido/OAuth de Fase 6 pendientes; Drive
es opcional. Para pruebas con archivos se requiere contenido autorizado del dueño,
sin sembrar identidades/permisos ficticios en producción. Los fallos, ataques,
reintentos y concurrencia destructiva se prueban aislados, sin cortar Evolution.

1. Owner: `bot destinos`. Debe mostrar solo destinos autorizados con referencias
   locales, nunca grupos fuera de Lab. Para una prueba de envío elegir el destino
   **Lab**, no una referencia privada ajena. No asumir que `d1` siempre es Lab.
2. Owner: `bot enviar <referencia-Lab> | Prueba Fase 7 de bajo impacto`.
   Revisar contenido/destino/ritmo y responder `no`: ningún mensaje de operación.
   Repetir y confirmar con `sí` solo si desea la prueba: un mensaje, un resultado
   por proveedor, sin anunciar lectura humana. `bot operaciones` conserva su estado.
3. Miembro/admin voluntario: `bot nuclear 5 | Prueba sin ejecución`.
   Debe responder `No.` y no crear operación. No otorgar permisos globales para probar.
4. **Nuclear físico no ejecutado y requiere aviso previo al dueño**. Propuesta
   exacta, si más adelante lo autoriza: `bot nuclear 5 | Prueba controlada de Botsky Lab`.
   La ráfaga sería exactamente `Prueba controlada de Botsky Lab [1/5]` hasta `[5/5]`,
   mínimo 1,5 s entre confirmados, **cero menciones**. Además se generan preview,
   aviso de cola y resultado/pausa; no confundir esos avisos con los cinco de ráfaga.
   Revisar preview antes de `sí`. El agente no realizará esta prueba sin el aviso.
5. Cancelación (solo durante una prueba Nuclear previamente avisada): owner
   `bot operacion cancelar <id>`. Debe retirar pendientes; puede completarse un
   envío ya en curso. Consultar resultados; no reenviar ni repetir inciertos.
6. Difusión de bajo impacto: **un solo destino Lab**,
   `bot difundir <referencia-Lab> | Prueba de campaña en Lab`; primero cancelar
   preview. La comprobación con dos privados queda para voluntarios y autorización
   concreta, no se realiza en esta ejecución ni se usa un grupo real.
7. Drive opcional: resolver OAuth y política de retención remota según FASE-7.md,
   activar solo en Lab y `bot drive buscar <nombre-de-archivo-autorizado>`. Cada actor usa sus
   propios IDs locales; `bot drive info <id>` y `bot drive descargar <id>` deben
   respetar ese ámbito. Archivo pequeño: documento en Lab con bytes correctos.
8. Subida Drive opcional: adjunto propio pequeño en Lab + `bot drive subir`.
   Consultar `bot drive trabajos`. Verificar archivo nuevo y enlace **privado**,
   acceso solo por la cuenta preconfigurada; no usar un enlace abierto como fallback.
   Un participante sin correo local no debe recibir un enlace supuestamente válido.
9. Apagar `bot drive configurar off`. Un nuevo pedido debe explicar que no está
   habilitado. No borrar, renombrar o cambiar permisos de archivos reales para
   provocar fallos; esas condiciones ya se simulan.

Pruebas físicas de acuses/menciones y de acceso Google permanecen pendientes.
La revisión arquitectónica de permisos, outbox, jobs masivos, migración y Drive
está aprobada (DEC-054). Las pruebas físicas de difusión/Nuclear se requieren solo
antes de activar fuera de Lab. **Sin merge a main ni inicio de Fase 8**.
