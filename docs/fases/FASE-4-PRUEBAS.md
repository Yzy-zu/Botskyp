# Fase 4 — Evidencia y validaciones opcionales

Base: 318 pruebas de fases anteriores conservadas, sin modificar tests ni fixtures
previos. Solo rama `phase-4-minecraft`. **Aprobada por el arquitecto sin correcciones
de código y lista para cierre técnico** (DEC-042, confirmación del dueño 16-10-2026).

La evidencia automática, la integración SSH real de solo lectura y la auditoría
existente se consideran suficientes. Las pruebas físicas de start/stop/restart,
backup real y restauración aislada son recomendables pero **NO bloqueantes**.
`bot mc estado` y `bot mc jugadores` son **validaciones operativas opcionales**.
Las pruebas físicas permanecen sin ejecución confirmada; se conserva toda la
cobertura, incluidos los 360 tests y los 14 casos Python del wrapper.

## Validación automática

La suite nueva cubre:

- Owner, admin local, miembro vigente, extraño e identidad @lid sin resolver;
  sin infraestructura para admin/miembro y sin lecturas para membresía caducada.
- Grupos habilitados/módulo y configuración; solo consultas sin argumentos para IA.
- Confirmación de stop/restart por actor/chat, respuesta ajena ignorada y
  reverificación de permisos/módulo antes de confirmar/despachar.
- Cola durable, doble webhook, doble invocación, recibo previo al efecto,
  UUID con argumentos diferentes, exclusión de escrituras/backups concurrentes.
- Host inaccesible, SSH error, timeout y respuesta JSON inesperada/incompleta/ajena;
  resultado incierto queda review, auditado y sin replay automático.
- Recuperación de queued y sending, incluyendo SIGKILL real de un hijo que simula
  el límite SSH, tras commit de sending en PostgreSQL aislado.
- Start ya iniciado, stop ya detenido, restart con StartedAt distinto y ping;
  fallo de evidencia posterior nunca anuncia éxito.
- Inyección de argumentos, campos adicionales, clave duplicada JSON, separadores,
  sustitución de shell, salto de línea, opciones CLI, consola fuera de allowlist.
- Pin de host, cuenta/host/rutas fijados, timeout y transporte sin shell.
- Wrapper con Docker simulado: recibos/replay, rechazo de symlinks, backup offline
  íntegro con contenido y SHA-256, backup online rechazado sin parar el servidor,
  propiedad dominada por env rechazada y edición con original preservado.

Los tests crean su propia base `botsky_test_*`; no limpian producción, no envían
mensajes WhatsApp, no ejecutan acciones administrativas en redspi y no usan Gemini.
Las pruebas Python trabajan exclusivamente en temporales con Docker simulado.
Resultados finales de suite/build/deploy se registran abajo tras ejecutarlos.

## Inspección real de solo lectura — ejecutada

- Redspi accesible desde la red del contenedor app y por la cuenta restringida.
- Host key previamente verificada, StrictHostKeyChecking=yes.
- `status`, `players`, `resources`, `logs 3`, `config-get`, `worlds`, `addons`:
  exit 0, envelope v1 y code=ok. Bedrock online; no se envían esos resultados a chats.
- Comando SSH prohibido `id`: exit 64, `Rejected`. No hubo shell ni ejecución de id.
- Administración personal por petrov continúa accesible tras el reload de sshd.
- Ningún start/stop/restart/backup/config-set/consola administrativa contra el
  servidor real. `players` usa únicamente `list` para lectura de nombres.

Esto acredita inspección técnica; no se presenta como prueba física en WhatsApp.

## Secuencia manual en Botsky Lab — opcional, no bloqueante y no ejecutada

Usar exclusivamente el grupo de pruebas. No activar otros grupos.

| Mensaje/actor | Respuesta esperada |
|---|---|
| Miembro vigente: `bot ayuda minecraft` | Solo estado y jugadores. |
| Miembro: `bot mc estado` | Online/offline observado; contenedor activo sin ping se declara sin confirmación de Bedrock. |
| Miembro: `bot mc jugadores` | Conteo actual, nombres únicamente con evidencia o aviso de no disponibles. |
| Miembro y admin WhatsApp: `bot mc start` | No; cero solicitud administrativa. |
| Owner: `bot ayuda minecraft` | Lista completa de acciones de infraestructura. |
| Owner: `bot mc console list; id` | Argumentos inválidos; no llega al wrapper ni a shell. |
| Owner: `bot mc operaciones` | Estado real de la cola y UUID, sin fingir cambios. |
| Owner: `bot mc stop`, después `no` | Confirmación y cancelación; servidor sigue igual. |
| Owner: `bot mc restart`, responde otra persona `sí` | No usa confirmación ajena ni reinicia. Owner cancela con `no`. |

Las siguientes pruebas recomendadas, no bloqueantes, requieren ventana coordinada
si se decide realizarlas. **Antes de ejecutarlas, el constructor debe anunciar al
dueño exactamente la acción y por qué es necesaria**:

1. Start idempotente con servidor ya activo, desde Lab; comprobar que StartedAt no cambia.
2. Stop confirmado, comprobar ausencia del proceso/estado y mensaje final real.
3. Segundo stop ya detenido: no se vuelve a mandar Docker stop.
4. Backup con servidor detenido, comprobar tar/bytes/hash en redspi; segunda solicitud
   mientras la primera está pendiente debe rechazarse. Restaurar en servidor aislado
   autorizado para verificar que el mundo abre; nunca restaurar sobre producción.
5. Start detenido y restart confirmado, comprobar ping y StartedAt; solo una ejecución
   ante doble webhook. No se exige una segunda interrupción si la lógica ya se probó.
6. Consola permitida o config-set de prueba y reversión solo con instrucción explícita
   y evaluación de sus efectos; ninguna edición silenciosa por Gemini.

No se han ejecutado estas acciones sobre redspi. Si SSH falla o hay un resultado
incierto, consultar operación/auditoría/recibo antes de cualquier nuevo intento.
El mismo UUID nunca se reenvía para repetir efectos.

## Incidencia del procedimiento de pruebas

Una primera regresión y una corrida focalizada se solaparon compartiendo
`.local/test-db.json`; se descartaron sus resultados por interferencia entre bases
exclusivamente de pruebas. Se repite una sola corrida aislada. No se modifican
expectativas ni se elimina cobertura para obtener verde; producción queda intacta.

## Corrida aislada confirmada antes del último ajuste de auditoría

Typecheck, lint y build correctos. `npm test`: **356/356**, **24 archivos**,
**175,96 s**, inicio **16:16:26 UTC, 16-10-2026**. Las 318 pruebas anteriores se
conservan completas. El test del wrapper ejecuta además **14/14 casos Python**.
Log privado `.local/phase4-final-tests.log`. Tras añadir la auditoría de lecturas y
cuatro casos de resultado remoto se ejecuta de nuevo la suite completa; el resultado
definitivo se registra a continuación.

## Resultado definitivo automático — 16-10-2026

- `npm run typecheck`: correcto.
- `npm run lint`: correcto.
- `npm run build`: correcto.
- `npm test`: **360/360**, **24 archivos**, **179,70 s**, inicio **16:20:25 UTC**.
  Son las **318 regresiones originales + 42 pruebas nuevas**. Se ejecutan además
  **14/14 pruebas Python** dentro de la prueba del gateway.
- Log privado `.local/phase4-final-360-tests.log`; tests/fixtures anteriores intactos.
- La corrida definitiva es única y aislada, sin otra suite concurrente. No quedan
  fallos de pruebas pendientes; SIGKILL de Minecraft y reinicios previos incluidos.
- Scripts shell con sintaxis válida; diff revisado sin claves privadas/API keys.
- Revisión real de permisos efectivos: cuenta solo en su grupo, publickey obligatorio,
  ForceCommand correcto, sin PTY ni forwarding, scripts root 755 y sudoers root 440.
- Minecraft conserva `StartedAt=2026-10-16T10:00:02.624472706Z`; ninguna interrupción real.

## Despliegue y comprobaciones finales

- Desplegado por `scripts/deploy.sh` desde **49a3f14**, con dump previo verificado
  `backups/botsky-20261016T162347-2032949.dump`; log privado `.local/phase4-deploy.log`.
- App/worker healthy, misma imagen inmutable
  `sha256:9c8ea5ecfbda6d60ad4668a609dc91e5e1290940dd7150ad9048e8f7de67e54c`.
- `/health` HTTP 200, base y Evolution conectados, transporte real; comprobado
  aproximadamente a las 16:25 UTC del 16-10-2026.
- Seis migraciones presentes, incluida 006; sin reescribir las cinco anteriores.
- Desde dentro de la nueva app: status/players con respuesta validada por el cliente
  real, code=ok, Bedrock online, 0 jugadores; `id` rechazado por SSH con exit 64.
  Se prueba también que worker no tiene el montaje ni el flag de Minecraft activo.
- Cero warnings/errors de arranque, cero nuevas entradas en error_log.
- Tiempos de arranque de Evolution API/Postgres/Redis idénticos a los previos.
  Minecraft running y mismo StartedAt observado antes; sin parar/reiniciar.
- Cero operaciones administrativas reales y cero grupos habilitados fuera de Lab;
  notas/recordatorios/tareas/partidas conservan sus conteos previos.
- Las inspecciones CLI no se presentan como envíos físicos por WhatsApp.
  La lista manual y la restauración aislada permanecen sin ejecución confirmada;
  son recomendadas/opcionales y no bloquean el cierre técnico (DEC-042).
- Auditoría arquitectónica aprobada sin correcciones de código. No se fusiona a
  main ni se inicia Fase 5; la rama queda aprobada y lista para cierre técnico.

## Verificación tras aprobación arquitectónica — 16-10-2026

- DEC-042: auditoría aprobada sin correcciones de código; evidencia existente
  suficiente para el cierre técnico. Pruebas físicas recomendadas/opcionales y no
  bloqueantes; permanecen sin ejecución física confirmada.
- `npm run typecheck`, `npm run lint` y `npm run build`: correctos.
- `npm test`: **360/360**, **24 archivos**, **182,10 s**, inicio **20:01:10 UTC**.
  Se conservan las 318 regresiones anteriores y las 42 pruebas de Fase 4.
- Wrapper Python: **14/14**, tanto dentro de Vitest como en ejecución independiente
  de `python3 scripts/minecraft/test_gateway.py`; Docker simulado y temporales.
- `/health`: **HTTP 200** a las **20:04:23 UTC**; `ok=true`, `database=true`,
  `evolution=true`, `transport=evolution`.
- Logs privados `.local/phase4-approval-typecheck.log`, `phase4-approval-lint.log`,
  `phase4-approval-tests.log`, `phase4-approval-build.log` y
  `phase4-approval-wrapper.log`; respuesta de salud local en
  `.local/phase4-approval-health.json`.
- Únicamente documentación de control; sin cambios funcionales ni reducción de
  tests/cobertura. Se conserva el despliegue existente; sin merge a main, nuevas
  activaciones o Fase 5. No se esperan pruebas físicas para terminar este registro.
