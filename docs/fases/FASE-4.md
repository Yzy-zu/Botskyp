# Fase 4 — Minecraft

Implementada y validada automáticamente en `phase-4-minecraft`, base `27572701d231ff17fa5fba886bd82880b92fe91f`.
Autorización directa del dueño: Fases 0–3 cerradas y fusionadas; solo Fase 4,
sin merge a main ni Fase 5. Los bloqueos históricos de Fase 3 quedan superados
únicamente en ese alcance. **Aprobada por el arquitecto, sin correcciones de código,
y lista para cierre técnico** según confirmación del dueño del 16-10-2026 (DEC-042).

La evidencia automática, la integración SSH real de solo lectura y la auditoría
existente bastan para el cierre técnico. Las pruebas físicas de start/stop/restart,
backup real y restauración aislada son recomendables pero **no bloqueantes**;
`bot mc estado` y `bot mc jugadores` son validaciones operativas opcionales.
Permanecen sin ejecución física confirmada; se conservan todos los tests y cobertura.

Plan previo para revisión crítica (histórico; aprobado sin correcciones):
1. Inspeccionar redspi, imagen, consola y volúmenes en solo lectura.
2. Cuenta y llave dedicadas, host key verificada, comando forzado y sudo acotado.
3. Protocolo cerrado y validación independiente en cliente/wrapper, sin shell libre.
4. Estado/jugadores para miembros vigentes; infraestructura solo owner.
5. Stop/restart usan confirmación de actor/chat/argumentos del núcleo existente.
6. Cola/auditoría aditivas; commit antes de efectos y sin reintentos ciegos.
7. Exclusión global de escrituras, recibos remotos persistentes e incertidumbre explícita.
8. Backups remotos verificables, sin copias concurrentes ni borrados de datos.
9. Tests de permisos, inyección, errores, duplicados, reinicio y regresión completa.
10. Deploy oficial y health; pruebas físicas solo Lab, sin parar/reiniciar redspi.

## Arquitectura y permisos implementados

- Botsky → SSH verificado sobre Tailscale → `botsky-mc@100.104.54.2` → comando
  forzado `/opt/botsky/mc-ctl.sh` → sudo exclusivamente a `/opt/botsky/mc-control.py`.
  La cuenta no pertenece a docker y no puede modificar su home, authorized_keys,
  scripts, recibos ni sudoers; son de root. Shell de login necesaria para OpenSSH,
  pero toda conexión queda bajo ForceCommand y `restrict`. Sin PTY ni forwarding.
- Llave Ed25519 dedicada y pin de host desde known_hosts previamente verificado;
  nunca `accept-new` ni `StrictHostKeyChecking=no`. Solo app recibe el montaje
  read-only `/run/botsky-minecraft`; worker no recibe la llave ni habilitación.
- Origen limitado a `100.109.237.37` tanto en la llave como en AllowUsers.
  `sshd-botsky.conf` agrega esa cuenta a la lista existente; conserva `petrov`.
  Sintaxis validada antes del reload. Password y autenticación interactiva apagados.
- Protocolo `v1 UUID base64url(JSON)`; esquema cerrado en Zod y validación independiente
  en Python. Host, usuario, rutas, contenedor y ejecutables están fijados en código.
  No se usa eval ni shell para ejecutar Docker. Python usa `-I` y comandos en arrays.
- `minecraft.read`: miembros vigentes del grupo habilitado, estado y jugadores.
  Administradores de WhatsApp no tienen privilegios de infraestructura.
  `infra.minecraft`: exclusivamente owner; todo control se limita actualmente a Lab.
- Herramientas registradas y ayuda generada; consultas sin argumentos disponibles a
  Gemini. Administración solo mediante atajos deterministas; el modelo no propone
  consola ni configuración. Actor/chat se inyectan y verifican desde el backend.
- Stop/restart utilizan las confirmaciones ya existentes de dos minutos,
  ligadas a actor/chat/acción/hash. Se vuelve a comprobar autorización al confirmar
  y al despachar la cola. Emergencia/mantenimiento o módulo apagado impiden despachos.
- Módulo nuevo disponible por defecto solo en Lab; sin activaciones de grupos reales.
  Minecraft no se ofrece por privado en esta fase.

## Acciones y límites

| Comando | Permiso | Comportamiento |
|---|---|---|
| `bot mc estado` / `status` | Miembro vigente | Ping Bedrock con mc-monitor; diferencia contenedor activo de Bedrock disponible. |
| `bot mc jugadores` / `players` | Miembro vigente | Conteo actual y nombres solo si la salida contemporánea de list los confirma. |
| `bot mc start` | Owner | Inicia solo si detenido; verifica ping posterior. |
| `bot mc stop` | Owner + confirmación | Detiene solo si activo; comprueba Running=false. |
| `bot mc restart` | Owner + confirmación | Comprueba StartedAt distinto y ping posterior; sin evidencia queda incierto. |
| `bot mc backup` | Owner | Copia consistente solo con servidor ya detenido; nunca lo para automáticamente. |
| `bot mc logs 30` | Owner | 1–100 líneas, salida acotada y filtrado de posibles secretos. |
| `bot mc resources` | Owner | Docker stats acotado, sin variables de entorno. |
| `bot mc worlds` / `addons` | Owner | Inventario de mundos y carpetas behavior/resource packs. |
| `bot mc config-get` | Owner | Solo difficulty, gamemode, max-players, pvp, allow-cheats. |
| `bot mc config-set pvp false` | Owner | Valores enumerados por clave, respaldo previo, reemplazo atómico y lectura posterior. Aviso de reinicio pendiente. |
| `bot mc console time query daytime` | Owner | Solo list, time query daytime, time set day/night y weather clear/rain. |
| `bot mc operaciones` | Owner | Últimas diez solicitudes y su estado persistente. |

No hay terminal, comandos genéricos Docker/SSH, selecciones arbitrarias de host,
restauración/borrado de mundos, instalación de addons desde URL ni edición libre de
server.properties. El plan menciona mundos/mods/addons sin definir operaciones de
instalación o borrado: esta fase expone su inventario seguro. No se altera el plan.
Las propiedades definidas por env del contenedor se rechazan para evitar que un
reinicio deshaga silenciosamente un cambio; en la instalación actual se observaron
DIFFICULTY, GAMEMODE y MAX_PLAYERS. Una edición permitida guarda el valor en disco;
no se afirma su aplicación antes del reinicio solicitado por separado.

### Respaldos

Se ejecutan en redspi, con lock exclusivo compartido con las escrituras. Incluyen
`worlds/` completo y `server.properties`; excluyen symlinks/archivos especiales.
Se comprueba espacio libre, se crea un `.partial` exclusivo, se sincroniza a disco,
se leen todos los miembros del tar y se calcula SHA-256 antes de promoverlo a `.tar`.
El servidor debe seguir detenido durante toda la copia; no se extraen archivos ni
se sobrescriben o eliminan respaldos previos. Se conservan parciales ante fallo.
La respuesta incluye nombre, bytes y SHA-256 únicamente tras verificación.
Sin compresión/transferencia al VPS principal, ni trabajo pesado en su loop de inbox.

**Límite deliberado:** backup en vivo devuelve «no realizado». El manual incluido
en la versión real de Bedrock exige save hold/query/resume, lista de archivos y
truncado a longitudes confirmadas; copiar el mundo activo sin ese contrato es
inseguro. No se simula soporte online, no se congela ni detiene el servidor por
sorpresa. Copia externa y restauración real siguen pendientes; SHA-256 y lectura de
tar verifican el artefacto, no sustituyen probar su carga en un servidor aislado.

### Persistencia, fallos y revisión

Migración aditiva `006_minecraft.sql`, sin modificar datos de fases anteriores:
`minecraft_operations` guarda solicitud UUID, actor/chat/mensaje, estado y resultado.
Una referencia única chat/actor/mensaje y el dedupe de inbox impiden doble webhook.
Un índice parcial global permite una sola escritura queued/sending/review.
La cola se confirma antes del SSH y se procesa en un bucle separado, sin bloquear
recordatorios/outbox por backups. Las consultas tienen timeout de 12 s; escrituras
180 s en cliente y presupuesto de 160 s en wrapper; Docker tiene su timeout propio.

Las consultas también registran `minecraft.read` con resultado observado/no disponible,
sin copiar logs remotos o configuración a la auditoría.
Auditoría `minecraft.queued`, `minecraft.sending` y `minecraft.result`, ligada al
UUID, destino redspi, hash de argumentos y resultado real. El registro genérico
de ejecución de tool indica aceptación en cola, no éxito remoto. Los recibos remotos
son persistentes, con hash y resultado incierto sincronizados ANTES del efecto;
repetir UUID devuelve el recibo, incluso si quedó incierto. UUID con otros argumentos
se rechaza. El lock remoto evita backups/control/consola simultáneos y atribuciones
ambiguas de logs a consultas de jugadores.

Al reiniciar Botsky: queued puede continuar tras reverificar permisos; sending
pasa a review con aviso canónico en outbox y SIN segundo SSH. Timeout, red caída,
error SSH, host key rechazada o protocolo inesperado después del envío también
quedan review. Resultado externo incierto bloquea nuevas escrituras globales.
No existe botón de reintento ciego ni se marca iniciado/detenido sin evidencia.

Para resolver review, el arquitecto/operador consulta primero fila/audit_log,
recibo `/var/lib/botsky-minecraft/receipts/<UUID>.json` y estado remoto de solo lectura.
Nunca reenvía una solicitud incierta para «ver qué pasa». Si el recibo confirma
resultado o la inspección resuelve el efecto, registra la evidencia y cambia la
fila a done mediante transacción con una nueva entrada audit_log. Si no puede
resolverlo, conserva review. Esta revisión técnica no se delega al modelo ni se
expone como permiso adicional al bot. Un nuevo pedido solo procede después de
resolver la incertidumbre. Operadores externos deben coordinarse con el lock del
wrapper para no arrancar el servidor manualmente durante una copia offline.

## Fuentes verificadas

El 16-10-2026 se revisaron los manuales oficiales de
[OpenSSH sshd](https://man.openbsd.org/sshd.8),
[ssh_config](https://man.openbsd.org/ssh_config.5),
[itzg Bedrock](https://github.com/itzg/docker-minecraft-bedrock-server),
[mc-monitor](https://github.com/itzg/mc-monitor),
[Docker stop](https://docs.docker.com/reference/cli/docker/container/stop/) y
[save de Bedrock](https://learn.microsoft.com/en-us/minecraft/creator/commands/commands/save?view=minecraft-bedrock-stable).
Se contrastó con los binarios/scripts y `bedrock_server_how_to.html` instalados.
`send-command` escribe stdin y no espera resultado: se usa evidencia posterior.
Durante la inspección inicial se intentó `send-command --help`; la versión instalada
lo envió como comando Minecraft desconocido. No produjo cambio de juego/sistema;
la comprobación posterior leyó el script sin volver a pedir ayuda por consola.

## Instalación y recuperación del acceso

La provisión es independiente del despliegue de la app: copiar `mc-ctl.sh`,
`mc-control.py`, `sshd-botsky.conf` e `install-gateway.sh` a una carpeta privada de
redspi, junto con la llave **pública** dedicada. Tras revisar los archivos, ejecutar
como administrador `sudo bash install-gateway.sh /ruta/a/llave-publica`. El instalador
no modifica Docker, imágenes, mundos ni Evolution. Rechaza authorized_keys ajeno,
instala propietarios/permisos, valida sudoers/sshd y recarga únicamente SSH.
La copia privada permanece exclusivamente en miroslav; nunca se copia a redspi.

Para revocar el acceso basta retirar esa llave pública o la concesión de esa cuenta;
conservar scripts/recibos/backups facilita auditoría y recuperación. Ante un rollback
de Botsky no se revierte ni se borra la BD ni el servidor Minecraft. Una imagen
anterior puede ignorar la cola nueva: se revisan queued/sending/review antes de
volver a habilitar el despacho. Se desactiva `MINECRAFT_ENABLED` si es necesario;
la configuración anterior e imágenes inmutables las conserva deploy.sh.

No hay acceso/configuración pendiente para usar las capacidades documentadas.
La revisión arquitectónica fue aprobada sin correcciones (DEC-042). Las pruebas
físicas coordinadas quedan recomendadas/opcionales y no bloquean el cierre técnico;
la fase está aprobada y lista para cierre, sin afirmar su ejecución física.

## Validación antes del despliegue

Typecheck/lint/build correctos; 360/360 pruebas Vitest (318 anteriores + 42 nuevas),
24 archivos, 179,70 s; además 14/14 casos Python del wrapper. Ver FASE-4-PRUEBAS.md.
Despliegue oficial y comprobaciones finales se registran tras obtener evidencia.

## Despliegue y verificación final — 16-10-2026

Implementada, validada y desplegada desde `49a3f14` en `phase-4-minecraft`;
**revisión arquitectónica posteriormente aprobada sin correcciones** (DEC-042).
Los commits documentales posteriores no cambian la imagen. No está fusionada a main; no se inicia Fase 5 ni se declara cierre físico.

- `scripts/deploy.sh` ejecutado con respaldo previo verificado
  `backups/botsky-20261016T162347-2032949.dump` y rollback disponible.
- Migración 006 aplicada; migraciones 001–005 conservadas. App y worker healthy,
  imagen `sha256:9c8ea5ecfbda6d60ad4668a609dc91e5e1290940dd7150ad9048e8f7de67e54c`.
- `/health` HTTP 200, `ok/database/evolution=true`, `transport=evolution`, comprobado
  después del despliegue y nuevamente durante la verificación final (~16:25 UTC).
- Desde la **app nueva**, cliente SSH/protocolo Zod reales: status y players code=ok,
  Bedrock online, cero jugadores al observar. Comando SSH prohibido `id` → exit 64.
- App con `MINECRAFT_ENABLED=true` y llave dedicada; worker con flag false y sin llave.
- Cero errores nuevos en error_log y cero warnings/errors de arranque en app/worker.
- Evolution API/Postgres/Redis conservan exactamente sus tiempos de inicio.
  Minecraft sigue running con el mismo StartedAt `2026-10-16T10:00:02.624472706Z`.
- Cero chats habilitados fuera de Lab y cero filas en minecraft_operations.
  Conteos previos/posteriores iguales: notas 1, recordatorios 2, tareas escolares 0,
  partidas 0. No hubo acciones administrativas ni envíos WhatsApp de prueba reales.
- No falta acceso/configuración para el alcance implementado. Se mantienen los límites
  de backup offline, claves dominadas por env y revisión técnica de incertidumbre.
  Pruebas físicas de Lab y restauración aislada siguen sin ejecución confirmada,
  recomendadas y no bloqueantes según DEC-042; secuencia en FASE-4-PRUEBAS.md.
  La evidencia existente es suficiente para el cierre técnico.

## Verificación documental tras aprobación — 16-10-2026

DEC-042 registrada y roadmap actualizado: Fase 4 aprobada y lista para cierre
técnico, sin correcciones de código. Cambian únicamente los cuatro documentos de
control autorizados; se conservan todos los tests, fixtures y cobertura.

Typecheck, lint y build correctos; **360/360 tests en 24 archivos**, **182,10 s**,
inicio 20:01:10 UTC. Wrapper Python **14/14**, también ejecutado por separado.
`/health` **HTTP 200** a las **20:04:23 UTC**, con `ok/database/evolution=true`
y `transport=evolution`. Los logs de esta verificación permanecen privados bajo
`.local/phase4-approval-*`.

Se conserva el despliegue existente. No se ejecutan pruebas físicas de Minecraft
ni mensajes WhatsApp: start/stop/restart, backup real y restauración aislada siguen
recomendados y no bloqueantes; estado/jugadores son validaciones operativas
opcionales. Sin merge a main, nuevo despliegue, activaciones ni inicio de Fase 5.
Tras commit y push a `phase-4-minecraft`, el constructor se detiene.
