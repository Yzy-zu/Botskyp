# Fase 6 — Biblioteca, packs y cooperacha

Rama `phase-6-biblioteca-packs-cooperacha`, base
`03cffae779407102a030f95ecf759bdfaeda0438`. Instrucción directa del dueño:
Fases 0–5 cerradas/fusionadas; solo Fase 6, sin merge ni Fase 7.
Un constructor. **Auditoría arquitectónica aprobada; lista para cierre técnico**
(DEC-050, 16-10-2026), sin correcciones de código, migraciones, scripts ni configuración.

Plan previo:
1. Migración aditiva: catálogo, blobs persistentes, pedidos/reservas y auditoría.
2. Discovery de carpetas con límites, sin enlaces ni rutas propuestas por usuarios.
3. Copia rclone exclusivamente Drive → staging; publicación atómica en BD local.
4. Packs con XP de Fase 3, snapshots inmutables y entrega privada por outbox.
5. Confirmación/refund/pending_review según evidencia de cada archivo.
6. Cooperacha serializada por grupo, recompensa reservada y release idempotente.
7. Cancelación 100 %, vencimiento 80 % y retención comunitaria auditable.
8. Lluvia explícita configurable y pack privado del airdrop con disponibilidad real.
9. Tests de concurrencia, seguridad, fallos y regresiones; sin envíos reales.
10. Deploy oficial, health, guía Lab y detener para revisión sin fusionar.

## Alcance y migración

Se implementan §3 Fase 6, §8.3–8.4, §9.8–9.9, lluvia de §9.12 y entrega
conservadora de §5.11. No hay subida/compartición genérica de Drive, difusión,
nuclear ni Fase 7. Precios permanecen versionados en `config/product.ts`; no hay
precios, saldos, destinatarios ni selección de archivos decididos por Gemini.

Migración **008_library_packs.sql**, aditiva, sin borrar datos ni modificar 001–007:

| Tabla nueva | Uso |
|---|---|
| `library_blobs` | Bytes persistentes del VPS, SHA-256 único, MIME y tamaño |
| `library_items` | Identidad estable por fuente/ruta, categoría y disponibilidad |
| `library_syncs` | Solicitudes, inicio/fin, cantidad y errores sanitizados |
| `pack_orders` | Reserva, precio/configuración, comprador, origen y destino |
| `pack_order_items` | Snapshot por hash y una referencia de outbox por archivo |
| `cooperachas` | Meta, total, plazo, recompensa reservada y estado |
| `cooperacha_contributions` | Cada débito, origen autenticado y devolución |
| `library_events` | Auditoría del pedido, aportes, release y liquidación |

Se amplía `automations` para `content_rain`, con `catch_up=false`; los resúmenes
escolares mantienen `catch_up=true`. Las consultas de Escuela filtran su propio
tipo para que configurar/apagar un resumen no altere una lluvia del mismo chat.
La migración se incluye en el respaldo/rollback oficial; nunca restaura datos
sobre producción automáticamente.

## Biblioteca local y Drive

La copia persistente de servicio vive en **PostgreSQL propio del VPS** (`bytea`),
separada de los temporales multimedia y cubierta por el `pg_dump` existente.
Con el límite inicial de 128 MB se evita añadir un volumen de archivos que quede
fuera del respaldo. El catálogo referencia blobs inmutables por hash: dos rutas
iguales de la misma fuente conservan su ID, y contenido idéntico entre fuentes
comparte bytes. Una compra selecciona hashes distintos, sin duplicar un mismo
contenido dentro del pack.

El owner deposita contenido local en `.local/library/source/<categoría>/...`;
solo el worker lo monta, en lectura. `bot biblioteca actualizar local` solicita
el discovery asíncrono. El bot no crea categorías: toma el **primer subdirectorio**
de cada ruta admitida; subdirectorios posteriores pertenecen a esa categoría.
Se aceptan espacios, acentos y nombres NFC seguros. `bot biblioteca` muestra las
categorías realmente publicadas y sus cantidades. La búsqueda de categoría para
compra no distingue mayúsculas. Archivos en la raíz y extensiones no admitidas
no se publican.

Discovery fija descriptores de cada directorio y abre cada componente con
`O_NOFOLLOW`; rechaza symlinks, hard links, archivos especiales, nombres con
traversal, controles o caracteres ambiguos. Verifica tipo, límites, lectura
completa, tamaño/mtime/ctime estable, firma/MIME y SHA-256. Una carrera que cambia
un directorio por symlink no desvía el descriptor ya abierto. Un snapshot inválido
no se publica parcialmente. Nunca se devuelven rutas internas o nombres locales
como argumentos de herramientas.

Drive es una **fuente opcional de solo lectura**. El worker ejecuta exclusivamente
`rclone copy botsky-library: <staging>`; no ejecuta `sync`, `bisync`, uploads,
borrados, dedupe remoto ni cambios de permisos. `root_folder_id` limita la raíz
configurada; se omiten shortcuts para impedir escapar mediante carpetas enlazadas.
Un único remoto `type=drive`, `scope=drive.readonly`, con OAuth local dedicado.
Sin configuración desde usuarios/Gemini, alias de backends, comandos auxiliares
ni variables heredadas que puedan cambiar el backend.

Las credenciales están en `.local/library/rclone/rclone.conf` (600), montadas solo
en worker. El directorio es escribible por UID 1000 para permitir renovar el token;
la app no recibe ese montaje. Se aceptan solo las claves de OAuth conocidas y raíz
explícita; `team_drive`/`service_account_file`, si aparecen, deben estar vacíos.
No se imprime stderr de rclone ni se persisten errores con rutas/tokens.

Lock de sesión PostgreSQL abarca toda la copia y publicación. Otro sync sale sin
lanzar otro proceso. El worker vuelve a verificar que quien solicitó siga siendo
owner; emergencia pausa solicitudes y mantenimiento pausa la actualización automática. `execFile`, ejecutable fijo, array cerrado, entorno mínimo,
180 s de timeout global, 10 s de conexión, 30 s de inactividad, una transferencia,
un checker y sin reintentos altos. Staging privado en `/tmp`, no visible al catálogo;
se publica en una transacción únicamente si rclone y discovery terminan bien.
Una caída/timeout deja el catálogo previo funcionando y registra fallo sanitizado.
Tras reinicio un sync interrumpido queda fallido, sin atribuirle éxito. Los
contenedores usan tmpfs y retiran staging al terminar; un reinicio del contenedor
elimina sus temporales. Drive habilitado se actualiza como máximo cada 15 minutos,
además de solicitudes owner explícitas. Nada de ello corre en inbox ni en el tick.
El worker sigue con concurrencia 1: un sync puede retrasar jobs multimedia en cola,
pero no el webhook, `pong`, el tick ni outbox de la app.

| Límite | Inicial |
|---|---:|
| Archivo / bytes persistentes totales, incluidos históricos | 4 MB / 128 MB |
| Archivos por snapshot / niveles de carpetas | 500 / 5 |
| Nombre de componente | 100 caracteres |
| Formatos | PNG, JPEG, WebP, GIF, MP3, OGG, WAV, MP4, WebM, PDF, TXT |

Los archivos se entregan como documentos con nombre generado por backend,
conservando MIME y bytes; no se ejecutan, convierten ni extraen. Archivos mayores
o formatos fuera del catálogo se rechazan/omiten según discovery. No hay fallback
que publique enlaces abiertos en Drive. Si se llena el cupo histórico, el nuevo
snapshot falla y se conserva el anterior: la limpieza requiere revisión específica,
no un borrado automático de contenido persistente.

## Packs, reservas y confirmación

Compra determinista: `bot pack [categoría]`. Precio **150 XP / 75 XP en Hora Feliz**,
con **3–5 / 4–6 archivos** respectivamente. Se exige al menos el mínimo; si hay
menos que el máximo aleatorio, se ajusta al stock real sin bajar del mínimo.
Azar por `crypto.randomInt`; Hora Feliz y saldo salen de la BD, no del modelo.

En una transacción: permiso/módulo y privado elegible → selección del backend →
verificación de cada blob → débito `pack_reserve` → pedido e ítems → outbox privado.
Actor/chat/mensaje canónicos vienen del backend. El índice único por tipo, chat,
actor y mensaje evita cobrar otra vez al repetir; el ledger tiene además su
idempotencia de Fase 3. El saldo global nunca queda negativo. `pack_orders` registra
`phase6-v1`; el ledger conserva la versión del motor XP existente y referencia al
pedido con su precio/configuración exactos.

La reserva fija bytes/hash/MIME. Si desaparece o cambia el archivo de origen,
se puede entregar la **copia verificada ya reservada**, sin cobrar por una ruta
rota ni sustituir archivos a escondidas. Ítems retirados dejan de ofrecerse a nuevas
compras; sus snapshots anteriores se conservan. Los bytes no caducan a los 2/7 días
de multimedia. No se mezclan con `media_attachments` ni con su limpieza.

`release` vuelve a bloquear/leer el pedido y genera una outbox por posición con
clave única. Solo el comprador puede ser destinatario de una compra; airdrop usa el
ganador canónico. Cooperacha/lluvia se entregan al chat de origen, hoy solo Lab.
Antes de cada envío se verifican destino, permisos/membresía/módulo y hash/tamaño.
Una compra tampoco se reserva si ya se sabe que el privado está deshabilitado.

- Todos los archivos `sent`: pedido `confirmed` y aviso confirmado por proveedor.
- Ningún archivo entregado y todos fallaron definitivamente: `pack_refund` por el
  100 %, idempotente, pedido `refunded`. No depende de que llegue el aviso de refund.
- Cualquier incertidumbre o entrega parcial: `pending_review`, reserva retenida,
  aviso al owner y registro. Se detienen los demás archivos tras un fallo/ambiguo.
  No hay refund automático de contenido posiblemente recibido ni reenvío ciego.
- Reconciliación positiva puede confirmar una fila sin volver a enviarla. La
  ausencia en una página de Evolution sigue siendo `unknown`, como en Fase 0.
- Un reinicio durante `sending` deja `uncertain`. No se etiqueta como entregado.

Los pedidos antiguos que siguen inciertos no ocupan el cupo de liquidación de
pedidos nuevos: solo se revisitan automáticamente cuando todos sus envíos tienen
resultado definitivo que permita confirmar o devolver.

`bot packs` consulta los pedidos propios del chat. El estado confirmado significa
respuesta/evidencia del proveedor; no prueba lectura humana. La resolución técnica
de un caso parcial agotado requiere revisar IDs/evidencia por archivo con el
arquitecto. No existe comando de usuario/Gemini que invente confirmaciones o
libere reservas inciertas sin evidencia.

## Cooperacha

`bot cooperacha abrir [meta] [categoría]`, solo owner/admin del grupo. Una abierta
por grupo; **500 XP** por defecto, rango **50–50.000**, **10 minutos**. Se reserva un
pack con bytes verificados antes de abrir. Esta fase usa recompensa pack, sin
inventar una distribución grupal de XP no definida en el plan. El anuncio incluye
pedido/cantidad/categoría, plazo y reglas de devolución antes de recibir aportes.

`bot aporto N`: bloqueo de chat y carteras en orden estable, aporte positivo,
débito y registro de aporte en la misma transacción. Si N supera el restante,
**se acepta/cobra solo el restante**. Si dos aportes cierran a la vez, el primero
que obtiene el lock consume hasta su límite; el segundo solo puede cubrir lo que
falte o se rechaza sin débito si ya cerró. No se ordena por nombres ni por Gemini.
El replay de un aporte antiguo tampoco puede aplicarse a una nueva cooperacha.

Meta alcanzada: estado `completed`, aportes a `system:community`, release único
del pedido y anuncio en outbox **del grupo**, disponible para todos. Un replay no
vuelve a abonar a comunidad ni genera otra recompensa. Un fallo de transporte del
premio mantiene su estado de entrega visible para revisión; no se anuncia recibido.

`bot cooperacha cancelar`: owner/admin; devuelve **100 %** por aporte y cancela la
reserva de premio. El replay de esa cancelación no cancela una actividad posterior.
Vencimiento: **floor(aporte × 80 / 100)** por cada aportación registrada; el resto
va a `system:community` como `community_retention`. Esta unidad de redondeo se
anuncia expresamente al abrir y consultar, y queda auditable en cada aporte.
Cancelar y vencer compiten bajo el mismo lock: una sola liquidación posible.
Un reinicio retoma el vencimiento desde la BD; desactivar el módulo no borra la
deuda. Emergencia/mantenimiento posponen el tick de cooperacha.

Se amplía el conjunto de carteras prebloqueadas del chat a los aportantes activos
y comunidad para evitar invertir locks entre actividad XP, partidas y cooperacha.
El tick usa locks de chat no bloqueantes y carteras NOWAIT; si están ocupadas,
continúa en el siguiente ciclo sin mover fondos parcialmente.

## Lluvia y airdrop

Lluvia apagada hasta configuración expresa owner/admin:
`bot lluvia 18:00 lunes,viernes 2 [categoría]`; zona CDMX, 1–3 archivos, un horario
por día seleccionado. Una reconfiguración no permite publicar más de una vez por
hora. `bot lluvia off` la apaga y cancela las outbox aún no iniciadas, incluso si se
reactiva después; no revoca un envío que ya cruzó la red. Ejecuciones con
más de 30 s de atraso se omiten y avanzan al siguiente horario; no acumulan lluvia
tras una caída. Falta de stock se registra y omite esa ejecución, sin bucles.
Las entregas se reservan y registran como pedidos gratuitos `rain`, con dedupe.

Airdrop conserva 500 XP, 60 segundos, un ganador y cooldown de Fase 3. Ahora exige
reservar un pack real antes de abrir; sin stock o módulo de biblioteca, no abre ni
promete el premio. Reclamar fija ganador, XP y pack privado en una transacción.
Al vencer sin ganador se cancela esa reserva. Las regresiones de airdrop conservan
sus casos y añaden stock sintético aislado a su preparación, acorde al nuevo premio.

## Configuración externa pendiente (sin secretos en el chat)

La biblioteca de producción nace vacía: **no se inventa contenido del dueño**.
El código puede operar con contenido local autorizado sin OAuth/Drive, que es
opcional. Contenido, OAuth/rclone y pruebas físicas **no bloquean el cierre técnico**
(DEC-050). Cargar contenido real autorizado es necesario antes de probar o activar
Biblioteca fuera de Botsky Lab; las pruebas físicas son necesarias solo antes de
activarla fuera de Lab, con autorización expresa del dueño. Para usar la fuente local:

1. En el VPS, colocar al menos 3 archivos distintos (4 para Hora Feliz; 6 permiten
   todo el rango) en `.local/library/source/<nombre-de-carpeta>/`. Directorios
   755 y archivos 644 dentro de esta carpeta privada permiten lectura a UID 1000;
   sin enlaces. No cambiar permisos de archivos ajenos a esta biblioteca.
2. En Botsky Lab: `bot biblioteca actualizar local`; consultar
   `bot biblioteca estado` hasta `done`, y después `bot biblioteca`.

Drive requiere acción manual del dueño; el agente no puede autorizar su cuenta:

1. Elegir una carpeta de Drive con el contenido autorizado y sus subcarpetas.
   Su ID es el tramo final de la URL de la carpeta. Se introduce en la terminal,
   **no en el chat**. No hace falta activar facturación.
2. Preparar el directorio local dedicado para UID 1000 (ya creado en este despliegue):
   `sudo install -d -m 0700 -o 1000 -g 1000 .local/library/rclone`.
3. Desde una terminal del VPS, ejecutar la imagen desplegada:
   `docker compose --project-name botsky --file .local/current-compose.json run --rm --no-deps worker rclone config --config /run/botsky-rclone/rclone.conf`.
   Se usa el snapshot del despliegue para elegir la imagen correcta, con rclone.
4. Crear un único remoto **botsky-library**, backend **drive**, scope
   **drive.readonly**. Usar OAuth del dueño y seleccionar en opciones avanzadas
   **root_folder_id** con el ID de la carpeta elegida. No usar shortcuts ni Shared
   Drive. Client ID/secret propios son opcionales; no pegar ninguno en el chat.
5. Si el VPS no tiene navegador, elegir autorización sin navegador y completar en
   la computadora del dueño el flujo que indica rclone (`rclone authorize drive`).
   La respuesta de autorización se pega solo en esa terminal local del asistente
   de configuración. Conservar archivo 600/directorio 700, accesibles a UID 1000.
6. El archivo solo debe contener esa sección y las claves `type`, `scope`,
   `root_folder_id`, `token`, y opcionalmente `client_id`/`client_secret`.
   Campos `team_drive`/`service_account_file` vacíos se admiten. No imprimir el
   archivo ni subirlo a Git. Un archivo cifrado no está soportado por este runner.
7. Editar localmente `.env`: `LIBRARY_DRIVE_ENABLED=true`; ejecutar
   `scripts/deploy.sh` desde esta rama. Después usar
   `bot biblioteca actualizar drive` / `bot biblioteca estado` en Lab.
   El flag autoriza también actualización automática cada 15 minutos.

Referencias oficiales verificadas: [rclone copy](https://rclone.org/commands/rclone_copy/),
[Drive: scope, raíz y shortcuts](https://rclone.org/drive/),
[flags y límites](https://rclone.org/flags/).
No se habilitan backups externos con estas credenciales readonly: ese pendiente
heredado necesita otro alcance/configuración y no se declara resuelto por esta fase.

## Verificación y despliegue

Resultados finales y evidencia de despliegue se registran en FASE-6-PRUEBAS.md.
Auditoría arquitectónica aprobada (DEC-050). Las pruebas físicas siguen pendientes,
se realizan solo en Botsky Lab y son necesarias solo antes de activar fuera de Lab;
no bloquean el cierre técnico. Sin merge, Fase 7 ni activación de grupos reales.


## Despliegue y cierre del constructor — 16-10-2026

Código **46aeb3a**, desplegado por `scripts/deploy.sh` con respaldo verificado
`botsky-20261016T222921-2523998.dump`. `/health` HTTP 200, PostgreSQL y Evolution
conectados. 548/548 tests (445 anteriores + 103 nuevos), multimedia 82/82,
typecheck/lint/build correctos. Wrapper Minecraft 14/14. Evidencia de procesadores
y rclone reales sobre imagen desplegada en FASE-6-PRUEBAS.md.

Migración 008 aplicada y verificada, sin modificar datos anteriores. Evolution
conserva imágenes/arranques. App y worker healthy. Cero grupos habilitados fuera de
Lab. Biblioteca sin contenido real y Drive deshabilitado: las compras/airdrops sin
stock se rechazan, no se cobran ni se prometen packs inexistentes.

**Estado: implementada, desplegada y aprobada por el arquitecto; lista para cierre
técnico** (DEC-050). Persisten contenido autorizado y pruebas físicas pendientes,
sin bloquear ese cierre; OAuth/Drive es opcional. No se declara cierre físico ni
sincronización real de Drive. Se conservan todos los tests y cobertura.
La actualización de aprobación es solo documental, con repetición de verificaciones
y commit/push a la rama de Fase 6, sin nuevo despliegue. Sin merge a main ni Fase 7.
El constructor se detiene al terminar, sin esperar secretos o mensajes físicos.
