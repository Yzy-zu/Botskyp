# Fase 6 — Pruebas y evidencia

Rama `phase-6-biblioteca-packs-cooperacha`. Base `03cffae`.
Solo Botsky Lab para pruebas reales; **ningún envío físico realizado por el agente**.
No se usa una simulación como confirmación de recepción WhatsApp.

## Cobertura automática nueva

- `library-security.test.ts`: categorías dinámicas, snapshots idempotentes,
  dedupe por hash entre fuentes, traversal/nombres manipulados, enlaces de archivo,
  directorio y raíz, hard links/FIFO, firmas/tamaños, fuentes ausentes,
  publicación atómica, rclone caído/timeout, locks de sync, configuración readonly,
  recuperación y `pong` durante copia lenta.
- `packs.test.ts`: compras concurrentes/replay/doble webhook, saldo insuficiente,
  categoría/stock inexistentes, hash alterado, fuente eliminada/cambiada tras
  reservar, fallo definitivo/refund, parcial/pending_review, timeout sin replay,
  reconciliación positiva, reinicio de envío, Hora Feliz, módulos/permisos,
  identidad/destino/precio inyectados, retención persistente y release duplicado.
- `cooperacha.test.ts`: meta/stock anunciados, actividad única, aportes simultáneos,
  dos finalizadores y ajuste al restante, replay entre actividades, validación de
  saldos, cancelación 100 %, vencimiento 80 % y retención, carrera cancelar/vencer,
  entrega grupal y release único, rollback, modos de operación, airdrop con pack,
  lluvia expresa, concurrencia, atraso, cuota de frecuencia y aislamiento escolar.
- `library-restart.test.ts`: SIGKILL real tras recibo del proveedor simulado,
  reconciliación sin reenviar el primer archivo y continuación del pack privado;
  SIGKILL con aportes retenidos y devolución al vencer una sola vez tras reiniciar.

Se conservan las 445 pruebas anteriores; la preparación de juegos añade contenido
sintético para que sus casos de airdrop prueben el premio completo de Fase 6.
Tests usan PostgreSQL propio **en una BD aislada `botsky_test_*`**, nunca truncado
de producción. El catálogo de esas pruebas es sintético, no contenido del dueño.

## Resultados

Código congelado y desplegado: **46aeb3a**, 16-10-2026.

| Comprobación | Resultado |
|---|---|
| Typecheck, lint, build | Correctos |
| Suite completa | **548/548**, 31 archivos, **331,42 s** |
| Regresiones anteriores / nuevas | 445 / 103; no se elimina ningún caso anterior |
| Multimedia focalizada | **82/82**, 3 archivos, **20,90 s** |
| Wrapper Minecraft | **14/14**, **0,043 s**, transporte Docker simulado |
| Procesadores reales | **17/17**, **22,243 s**, imagen inmutable desplegada, sin red |
| Rclone real | v1.60.1-DEV; flags aceptados, timeout duro comprobado, **0 peticiones Drive** |
| Pruebas físicas WhatsApp / OAuth Drive | **Pendientes**, sin ejecución confirmada |

Se repitió la verificación final con el código congelado después de incorporar la
cancelación definitiva de archivos de lluvia al apagar/reactivar. Una ejecución
intermedia cargó la versión anterior del módulo mientras cambiaba esa prueba y
falló ese caso; no se usa como aceptación. El caso pasó en proceso nuevo y la
suite completa final pasó 548/548. La preparación del test de reconciliación se
corrigió antes para respetar el intervalo de outbox; no se relajó ese control.

Logs privados, fuera de Git: `.local/phase6-verified-tests.log`,
`.local/phase6-multimedia-tests.log`, `.local/phase6-rain-final.log`,
`.local/phase6-minecraft-wrapper.log`, `.local/phase6-deploy.log`,
`.local/phase6-before-db.json`, `.local/phase6-after-db.json` y
`.local/phase6-after-services.json`, `.local/phase6-final-real-processors.log`
y `.local/phase6-final-rclone-real.log`.

## Verificación tras aprobación arquitectónica — 16-10-2026

Se repitieron las comprobaciones existentes con la actualización exclusivamente
documental de DEC-050, sin modificar código, migraciones, scripts, configuración,
tests ni cobertura. No se ejecutó otro despliegue: se conserva `46aeb3a` en servicio.

| Comprobación | Resultado |
|---|---|
| `npm run typecheck` | Correcto |
| `npm run lint` | Correcto |
| `npm test` | **548/548**, 31 archivos, **339,61 s**; 445 regresiones + 103 nuevas |
| `npm run build` | Correcto |
| Multimedia focalizada | **82/82**, 3 archivos, **21,53 s** |
| Procesadores reales | **17/17**, **30,516 s**, imagen inmutable del worker desplegado |
| Wrapper Minecraft | **14/14**, **0,242 s**, transporte Docker simulado |
| `/health` | **HTTP 200**, `ok=true`, `database=true`, `evolution=true`, `transport=evolution` |

Procesadores reales en contenedor aislado sin red, con límites de producción y
filesystem read-only. Suite completa y multimedia ejecutadas secuencialmente con
PostgreSQL de pruebas aislado. App y worker conservan imágenes y `StartedAt`, ambos
healthy. Sin pruebas físicas, OAuth ni solicitudes reales a Drive en esta revisión.

Logs privados fuera de Git: `.local/phase6-approval-tests.log`,
`.local/phase6-approval-multimedia.log`, `.local/phase6-approval-processors.log`,
`.local/phase6-approval-minecraft.log` y `.local/phase6-approval-health.log`.

## Pruebas físicas pendientes (dueño)

Según la aprobación arquitectónica comunicada por el dueño (DEC-050), contenido
autorizado, OAuth/rclone y estas pruebas **no bloquean el cierre técnico**.
Se requiere cargar contenido real autorizado antes de probar o activar Biblioteca
fuera de Botsky Lab. Las pruebas físicas son necesarias **solo antes de activar
fuera de Lab** y se realizan en Lab; no se autoriza aquí esa activación.
OAuth/Drive es opcional: se puede validar y operar la biblioteca solo con fuente local.

Requieren contenido local autorizado y saldo XP suficiente. No sembrar carteras
por SQL en producción para simular una prueba; usar los mecanismos XP existentes.
Antes: completar configuración local de FASE-6.md, esperar un sync `done` y probar
solo en Botsky Lab con participantes voluntarios. No cambiar grupos reales.

1. **Discovery:** `bot biblioteca`, `bot biblioteca estado`. Debe listar categorías
   tomadas de las carpetas reales y el último resultado, sin rutas o credenciales.
2. **Pack privado:** `bot xp`, `bot pack <categoría>`, `bot packs`.
   Grupo: reserva/estado, nunca archivos del pack. Privado: 3–5 documentos; pedido
   `confirmed` solo después de recibos. El saldo baja exactamente 150 XP, además
   de actividad XP legítima que corresponda al mensaje.
3. **Hora Feliz:** owner/admin `bot hora feliz`; comprador con saldo suficiente
   `bot pack <categoría>`. Reserva 75 XP, 4–6 archivos privados. Apagar después con
   `bot hora feliz off`. Confirmar cantidad, bytes y que no se compartió en grupo.
4. **Sin stock/saldo:** categoría inexistente o comprador sin saldo. Respuesta
   clara sin débito `pack_reserve`, sin archivos ni pedido cobrado.
5. **Cooperacha exitosa:** owner/admin `bot cooperacha abrir 50 <categoría>`;
   dos usuarios aportan `bot aporto 30` y `bot aporto 30` casi a la vez.
   Solo se cobran 50 XP totales: un aporte completo y el restante ajustado.
   Recompensa una sola vez **en Lab para todos**; comunidad recibe 50 XP.
6. **Cancelación:** abrir una nueva, aportar y usar `bot cooperacha cancelar`.
   Devolución 100 %, sin premio ni doble devolución por repetir.
7. **Vencimiento:** abrir meta 500, aportar 101 XP sin completarla y esperar diez
   minutos. Devolución 80 XP de ese aporte, retención 21 XP a comunidad, una vez.
8. **Lluvia:** owner/admin `bot lluvia HH:mm <día-actual> 1 <categoría>` para una
   hora próxima de CDMX. Debe publicar un archivo en Lab una sola vez. Después
   `bot lluvia off`. No configurar una lluvia indefinida para probarla.
9. **Airdrop:** con stock, owner/admin `bot airdrop`; un miembro `bot yoo`.
   Un ganador recibe 500 XP y pack por privado. Sin stock no debe abrirse.
10. **Drive opcional:** una vez autorizado OAuth local, solicitar dos actualizaciones
    seguidas, observar una activa y resultado final sin duplicar catálogo. No borrar,
    renombrar ni sobrescribir contenido remoto para forzar un fallo real.

Los fallos, incertidumbres, reinicios y concurrencia destructiva se simulan en
pruebas aisladas; no se mata producción ni se corta Evolution para la guía física.
No se declara cumplido el criterio de WhatsApp real mientras estas validaciones
permanezcan sin ejecución confirmada; esa pendiente no bloquea el cierre técnico
aprobado en DEC-050.


## Despliegue e integridad — 16-10-2026

Despliegue oficial **46aeb3a**, mediante `scripts/deploy.sh`, respaldo previo
verificado `backups/botsky-20261016T222921-2523998.dump`. Sin cambios al script de
despliegue/backup/rollback. Migraciones 001–008 presentes; checksum 008 coincide
con el SQL de la imagen desplegada. No se modificaron las migraciones anteriores.

`/health`: **HTTP 200**, `ok=true`, `database=true`, `evolution=true`,
`transport=evolution`. App y worker healthy; cero warnings/errores nuevos en los
logs inspeccionados tras desplegar. Imágenes inmutables:

- App: `sha256:f13126080b408094120dd44866cdd37f78bcc073e446856dcf6060b65ba21b50`.
- Worker: `sha256:7cfa7c8d3acae027a555d3136d62850b7254c256ffd972ab33a973959d1e9e00`.

Evolution API/PostgreSQL/Redis conservan **imagen y StartedAt idénticos** al
snapshot anterior. No se modificaron, reiniciaron ni se cambió su base/configuración.
Conteos previos conservados: notas 1, recordatorios 2, tareas 0, partidas 0,
operaciones Minecraft 0, jobs 0. Cero grupos habilitados fuera de Lab.

Las ocho tablas se crearon sin contenido operativo: catálogo/blobs/syncs/pedidos/
cooperachas en cero; lluvia sin habilitar. `LIBRARY_DRIVE_ENABLED=false`.
Directorios locales preparados; **cero archivos fuente y sin rclone.conf**.
No se confirmó ninguna sincronización real con Drive ni envío físico de biblioteca.

Worker conserva 768 MiB, 0,50 CPU, 64 PIDs, root filesystem read-only y ausencia de
llave Minecraft. Montaje de fuente de biblioteca read-only; OAuth solo en worker,
no en app. Esta fase no añade servicios ni cambia redes de Evolution.

Los 17 procesadores reales se ejecutaron sobre la **misma imagen inmutable del
worker desplegado**: QR/OCR/PDF/oficina, audio/video/stickers/Piper y aislamiento de
red en descendientes. 17/17, 22,243 s, contenedor sin red y con límites de producción.
El binario rclone real aceptó todos los flags usados y su proceso fue terminado por
el timeout duro de prueba; cero peticiones Drive. No se confunde esta comprobación
CLI con OAuth o sincronización de una cuenta real.

## Estado tras aprobación arquitectónica

Implementada y desplegada; **auditoría arquitectónica aprobada y lista para cierre
técnico** (DEC-050, 16-10-2026), sin correcciones de código, migraciones, scripts ni
configuración. Sin merge a main ni Fase 7. La actualización documental conserva las
imágenes desplegadas. No se eliminan tests ni cobertura.
Pendientes operativos no bloqueantes para el cierre técnico: contenido autorizado,
OAuth opcional de Drive y guía física de Lab. Configuración exacta en FASE-6.md;
la fuente local funciona sin OAuth. Contenido real antes de probar/activar fuera
de Lab y pruebas físicas solo antes de activar fuera de Lab, con autorización
expresa del dueño. No se piden secretos ni se atribuyen pruebas físicas ejecutadas.

Límites: 128 MB históricos (al llenarse no se borra; se conserva el catálogo previo),
4 MB/archivo y formatos admitidos. Sync comparte worker y puede retrasar jobs en
cola hasta su timeout, sin bloquear app/tick/outbox. Entrega parcial/incierta retiene
reserva y exige evidencia técnica antes de resolverla; no hay reenvío/refund ciego.
El backup externo/rotación heredados no se resuelven con OAuth readonly de biblioteca.
