# Fase 3 — Economía y juegos

Estado: implementada, validada y desplegada desde `f656b1c` en
`phase-3-economia-juegos`, base `6566f21`. **Aprobada por el arquitecto, sin
correcciones de código, y lista para cierre técnico** (DEC-038). La evidencia
automática y de integración existente es suficiente; las pruebas físicas de
WhatsApp son opcionales/no bloqueantes. Sin merge a main ni inicio de Fase 4.
Autorización directa del dueño: Fases 0–2 cerradas; solo Fase 3, sin merge ni Fase 4.

Plan previo para revisión crítica (histórico; revisión aprobada sin correcciones):

1. Migración aditiva: carteras, ledger, actividad, partidas, participantes y moderación.
2. Ledger/cartera y reservas/pagos en una transacción con locks PostgreSQL.
3. Saldo global por usuario según §7; partidas, permisos y warns aislados por chat.
4. Reglas puras y azar crypto; configuración versionada conservada por partida.
5. Blackjack individual/mesa persistente, turnos y cancelaciones con devolución.
6. Ruleta anunciada, warns e inmunidad; obligaciones de expulsión y reingreso auditadas.
7. Airdrop atómico de 500 XP; diario/racha y Hora Feliz manual.
8. Integrar registro, atajos, sesiones y tick; mantener barrera exclusiva de Lab.
9. Tests de concurrencia, retries, reinicios, permisos y regresión de 206 pruebas.
10. Deploy oficial con respaldo/health y documentación; detener para arquitecto.

Cooperacha/packs/Drive son de Fase 6; nuclear es de Fase 7. No se adelantan.

## Alcance implementado

- Cartera global, ledger transaccional e idempotente, actividad pasiva, diario,
  racha, nivel calculado desde el saldo actual y Hora Feliz manual.
- Blackjack individual y mesa hasta seis jugadores; reserva al entrar, doble,
  manos/mazo persistidos, turnos y plantarse por timeout; devolución al cancelar lobby.
- Ruleta de 2–6 participantes, perdedor uniforme en código, bote a supervivientes,
  remanente explícito a `system:community` y devolución si faltan participantes.
- Warns por grupo: consulta propia, alta/baja administrativa con mención auténtica,
  consecuencia automática solo si fue anunciada y publicada de forma confirmada.
- Expulsión/reingreso persistentes con comprobación de estado, inmunidad del
  owner/admin, alertas ante fallos e incertidumbre y protección frente a reintentos.
- Airdrop manual administrativo de 500 XP, un ganador atómico, sin pack.
- Registro/ayuda, atajos sin IA, sesiones propias y recuperación por tick. No se
  modifica el contrato ToolCtx, la outbox ni los scripts de despliegue/respaldo.

## Migración

`src/db/migrations/005_economy_games.sql`:

| Tabla | Uso |
|---|---|
| `wallets` | Saldo global no negativo, último diario y racha. |
| `xp_ledger` | Delta, motivo, referencia idempotente, chat y versión de configuración. |
| `activity_marks` | Cooldown por usuario/chat. |
| `games` | Mazo, manos, apuestas, participantes, resultado, plazo y versión. |
| `game_players` | Participantes explícitos; una partida activa por persona/chat. |
| `game_actions` | Respuesta previa por mensaje para no repetir decisiones ni pagos. |
| `moderation_counts` | Conteo actual de warns por chat/persona. |
| `moderation_events` | Historial de warn, unwarn, kick y reset. |
| `obligations` | Expulsión/reinvitación, intentos, estado y vínculo con outbox. |

Se amplía el CHECK de `sessions.kind` para admitir `game`; no se eliminan filas ni
se reescriben migraciones de Fases 0–2. Rollback de imagen deja tablas nuevas
conservadas. Si ya existen partidas con reservas, se debe volver a una imagen capaz
de resolverlas o devolverlas de forma auditada; no se borran ni se altera saldo a mano.

## Reglas económicas finales

| Regla | Resultado |
|---|---|
| Saldo inicial | 0 XP, global por usuario; la cuenta comunitaria es independiente. |
| Actividad | Texto de ≥3 caracteres en grupo habilitado: +1 XP; una vez/minuto/persona/grupo. |
| Hora Feliz | Manual owner/admin, 60 min por defecto, +20 XP por mensaje elegible. |
| Nivel | `1 + floor(saldo_actual / 20)`; gastar/perder puede reducirlo. |
| Diario | Un reclamo global/24 h; 3% 1000, 12% 300, 35% 100, 35% 40, 10% 15, 5% 0 XP. |
| Racha | Continúa hasta 48 h; +20 XP/día adicional, máximo +100; sin bono sobre premio 0. |
| Apuestas | 50 XP por defecto; rango 20–1000. Se debitan al entrar. |
| Blackjack | Empate devuelve 1×; victoria 2×; natural `floor(apuesta × 2.5)`. |
| Doble | Solo dos cartas iniciales y saldo suficiente; reserva igual, una carta y fin del turno. |
| Ruleta | Un perdedor uniforme; bote dividido entre supervivientes; sobrante a comunidad. |
| Cancelación | Lobby cancelado o ruleta con menos de dos participantes: devolución completa. |
| Airdrop | 500 XP al primero; owner/admin abre; 60 s; máximo uno/hora/grupo. |

Los mensajes que son comandos también pueden ganar actividad si cumplen cooldown.
Toda modificación monetaria escribe ledger y saldo en una transacción. No hay
transferencias libres, crédito negativo, premios elegidos por IA ni XP histórico
usado para el nivel. Configuración `phase3-v1` en `config/product.ts`.

## Comandos y permisos

| Acción | Comando | Miembro | Admin local/owner |
|---|---|---|---|
| Saldo/nivel/racha | `bot xp` | Sí | Sí |
| Premio diario | `bot diario` | Sí | Sí |
| Hora Feliz | `bot hora feliz`, `bot hora feliz 60`, `bot hora feliz off` | No | Sí |
| Blackjack | `bot blackjack 50`, `bot blackjack mesa 50` | Sí | Sí |
| Ruleta | `bot ruleta 50` | Sí | Sí |
| Entrar | `bot entro` | Sí | Sí |
| Tu turno | `carta`, `plantarse`, `doblar` | Participante | Participante |
| Estado | `bot partida` o `estado` durante tu sesión | Participante | Participante |
| Cancelar lobby | `bot partida cancelar` o `cancelar` en sesión | Creador | Sí |
| Airdrop | `bot airdrop` | No | Sí |
| Reclamar | `bot yoo` | Sí | Sí |
| Consultar warns | `bot warns` | Propios | Propios |
| Poner/quitar warn | `bot warn @persona`, `bot quita warn @persona` | No | Sí |
| Consecuencias | `bot ruleta consecuencias on/off` | No | Sí |
| Castigo | `bot ruleta castigo 15` | No | Sí |
| Consultar configuración | `bot ruleta configuración` | No | Sí |

Ayuda: `bot ayuda economía`, `bot ayuda juegos`, `bot ayuda moderación`.
Módulos: `xp`, `games`, `moderation`, con alias economía/juegos/moderación; activación
solo owner mediante los controles existentes. Alcance actual: exclusivamente grupos
habilitados en Botsky Lab. Fuera de Lab permanece la barrera de Fase 0.
Un admin de otro grupo y una identidad no resuelta no reciben privilegios especiales.

## Ruleta y límites conocidos

Consecuencias apagadas inicialmente. Al habilitarlas, cada lobby anuncia warn,
umbral y duración antes de resolver. Si no se comprueba bot admin o publicación
confirmada, juega sin consecuencias y lo dice. Tres warns crean obligación;
owner/admin conserva warns pero no se expulsa. Tras expulsión confirmada se reinicia
conteo y se programa enlace privado; no se asegura que WhatsApp acepte el reingreso
hasta que la persona lo efectúe. El bot facilita el enlace, no agrega a la fuerza.

Fallos inequívocos reintentables tienen límite de tres intentos. Un efecto ambiguo
no confirmado pasa a revisión. `bot diag errores` permite detectar estos casos;
la revisión técnica consulta `obligations` y su outbox antes de decidir un nuevo
intento. No se repiten envíos inciertos ni se cambian saldos para resolverlos.
El reingreso adeudado continúa aunque luego se desactive juegos; emergencia y
mantenimiento lo suspenden temporalmente. No hay moderación completa ni expulsión
manual en esta fase. Ver DEC-035–038 y la lista de pruebas de WhatsApp.

## Evidencia de validación y despliegue — 16-10-2026

- Node 24 local: `npm run typecheck`, `npm run lint`, `npm run build`: correctos.
- `npm test`: **318/318 tests, 23 archivos, 162,52 s**. Son los 206 originales
  conservados íntegros y 112 nuevos, incluido SIGKILL de blackjack. No se retiraron
  fixtures ni casos previos. Log privado `.local/phase3-final-tests.log`.
- Despliegue oficial `scripts/deploy.sh` desde **`f656b1c`**, con respaldo previo
  verificado `backups/botsky-20261016T151333-1938244.dump`.
- Migración 005 aplicada a la base propia a las **15:14:07 UTC**. Las nueve tablas
  están presentes; migraciones 001–004 se conservan con sus checksums originales.
- `/health` **HTTP 200**, comprobado a las **15:14:44 UTC** y nuevamente después:
  `ok=true`, `database=true`, `evolution=true`, `transport=evolution`.
- App y worker saludables, con la misma imagen inmutable esperada. Cero warnings
  o errores de arranque y cero entradas nuevas en error_log desde la migración.
- Huellas de once tablas anteriores (notas, recordatorios, Escuela, automatizaciones,
  flags y chats) idénticas al snapshot previo. Evolution API/Postgres/Redis mantienen
  sus fechas de inicio; no se reiniciaron ni modificaron.
- Cero grupos habilitados fuera de Lab; cero partidas/obligaciones reales pendientes;
  cero grupos con consecuencias de ruleta activadas. XP/juegos/moderación disponibles
  por defecto únicamente en Lab, siguiendo controles existentes. Sin envíos reales
  de prueba, sin expulsión física y sin activaciones fuera del laboratorio.
- Rama publicada en origin. `main` permanece en `6566f21fd631ea08886f56267e985c9e00d8e476`.
  Los commits documentales posteriores no cambian la imagen desplegada.

No hay bloqueo técnico pendiente. La revisión crítica del arquitecto fue aprobada
sin correcciones de código, según confirmación del dueño del 16-10-2026 (DEC-038).
La evidencia automática y de integración existente basta para cerrar técnicamente
la fase, que queda **aprobada/lista para cierre**. La prueba física de expulsión,
enlace y reingreso sigue recomendada, opcional y no bloqueante; no fue ejecutada.
Se conservan todos los tests y cobertura, así como la secuencia voluntaria en
`FASE-3-PRUEBAS.md`. Esta actualización solo modifica documentación; sin merge a
main, nuevo despliegue, activaciones fuera de Lab ni inicio de Fase 4.

## Verificación documental tras aprobación — 16-10-2026

DEC-038 registrada y roadmap actualizado, sin cambios funcionales. Typecheck, lint
y build correctos; **318/318 tests en 23 archivos**, **158,50 s**. Se conserva toda
la cobertura existente. `/health` **HTTP 200** a las **15:32:43 UTC**:
`ok=true`, `database=true`, `evolution=true`, `transport=evolution`.
El despliegue existente se conserva. Solo cambian los cuatro documentos de control
autorizados; sin merge a main ni inicio de Fase 4. Prueba física de
expulsión/enlace/reingreso recomendable, opcional y no bloqueante; no ejecutada.
