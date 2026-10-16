# Fase 3 — Pruebas

## Pruebas automáticas

Ejecución sobre PostgreSQL 17 dedicado, bases aisladas `botsky_test_*`; nunca sobre
las tablas reales. Se conservan íntegros los 206 tests originales.

- Concurrencia: 30 créditos simultáneos, referencia repetida, dos gastos que compiten,
  dos diarios desde chats diferentes y reclamo simultáneo de airdrop.
- Ledger/saldo atómicos: rollback por excepción, no negativos por servicio/constraint,
  gasto/pérdida y descenso del nivel; devolución/pago y cancelación sin duplicados.
- Diario: todos los límites probabilísticos, cooldown global, racha 24/48 h, bono
  limitado y premio cero; retry no vuelve a tirar el azar.
- Actividad: sin dirigirse al bot, cooldown por chat, duplicados, texto corto,
  bots/extraños, módulos desactivados, mantenimiento y emergencia.
- Blackjack: ases, natural/empate/bust/dealer, pagos, baraja inyectable, doble,
  saldo insuficiente, turnos, timeout, cancelación, seis jugadores, sesiones ajenas.
- Ruleta: reparto/remanente, falta de participantes, reglas anunciadas, bot sin admin,
  anuncio no entregado, liquidación revertida y posterior reintento.
- Moderación: menciones verificadas, permisos locales, conteo aislado, dedupe,
  umbral, inmunidad owner/admin y promoción posterior al resultado.
- Obligaciones: evidencia de ausencia, reset/reingreso, plazos, recuperación de
  sending, rate limit y límite de reintentos, fallo de invitación, entrega incierta,
  preservación de restitución al desactivar módulos y suspensión de emergencia.
- Contrato Evolution 2.3.7 mediante HTTP simulado: rutas/métodos/payloads, respuesta
  por participante, invitación válida, rechazo fuera de Lab, errores y ambigüedad.
- SIGKILL de proceso real con transporte simulado: mismo mazo/manos/plazo tras
  reiniciar, plantarse por timeout y exactamente un pago, incluso otro reinicio.

Estos tests no acreditan una expulsión o recepción física en WhatsApp.

## Verificación real de solo lectura

Evolution 2.3.7 instalado inspeccionado sin modificaciones. API real confirmó Lab,
bot y owner administradores, y respuesta de invitación consistente con URL válida.
Sin imprimir el enlace, sin mensajes de prueba enviados, sin expulsiones reales.

## Lista manual: solo Botsky Lab

Estado: **opcional y no bloqueante**, sin ejecución física confirmada (DEC-038).
La evidencia automática e integración existente basta para el cierre técnico.
Si se decide ejecutar esta lista voluntaria, participa el dueño y, para expulsión,
una cuenta voluntaria que no sea admin.
No utilizar grupos reales ni cuentas ajenas al ensayo.

| Paso | Mensaje/acción | Resultado esperado |
|---|---|---|
| 1 | `bot ayuda juegos`, `bot xp`, `bot diario` | Ayuda disponible, saldo/nivel actuales y un único diario; repetir diario indica espera de 24 h. |
| 2 | Owner/admin: `bot hora feliz`; participante envía texto de ≥3 caracteres después de 60 s sin premio | Recibe 20 XP; `bot xp` lo refleja. No hay lluvia/packs. |
| 3 | `bot blackjack 20`; después `estado`, `carta` o `plantarse` | Reserva 20; solo tu sesión continúa; pago exacto al finalizar. El resultado puede terminar inmediatamente si hay natural. |
| 4 | `bot blackjack mesa 20`; segunda persona `bot entro` | Reserva individual; lobby 35 s y turnos 30 s. Solo jugador del turno puede actuar; dejar vencer equivale a plantarse. |
| 5 | Abrir otra mesa; `cancelar` antes de 35 s | Todas las reservas devueltas una sola vez. |
| 6 | Owner/admin `bot airdrop`; dos participantes `bot yoo` | Solo uno gana 500 XP. No se entrega pack; nueva apertura bloqueada durante una hora. |
| 7 | Owner/admin `bot warn @voluntario`, `bot warns` desde voluntario, `bot quita warn @voluntario` | Conteo correcto, solo en este grupo. Un miembro sin administración no puede poner/quitar. |
| 8 | `bot ruleta 20`; segunda persona `bot entro`; esperar 60 s | Se anuncia sin consecuencias inicialmente; un perdedor, bote a supervivientes y sin warns nuevos. |

Para repetir partidas, cada participante necesita saldo suficiente. Si diario da 0,
se puede ganar actividad durante Hora Feliz respetando un minuto entre premios;
no hace falta editar la base ni inventar créditos. Los comandos también pueden
sumar actividad cuando corresponde. Al terminar: `bot hora feliz off`.

## Expulsión y regreso con una cuenta voluntaria

1. Verificar en WhatsApp que el voluntario está en Botsky Lab y no es admin; bot
   debe ser admin. Owner/admin: `bot ruleta consecuencias on`, `bot ruleta castigo 1`
   (solo para reducir el tiempo de esta prueba; valor normal 15).
2. Llevar al voluntario a **2 warns** con `bot warn @voluntario` según su conteo
   actual; si sobra alguno, quitarlo. Los warns manuales por sí solos no expulsan.
3. Ambos con ≥20 XP: `bot ruleta 20`, voluntario `bot entro`. Verificar que el aviso
   anunció warn y castigo. Esperar 60 s. El perdedor es aleatorio: si pierde owner,
   conserva su warn y permanece dentro; repetir con saldo suficiente hasta que
   pierda el voluntario. No hay comando para forzar el resultado.
4. Al tercer warn del voluntario: comprobar que sale realmente. Solo entonces el
   bot debe anunciar expulsión confirmada y programar restitución. Revisar que sus
   warns quedaron en 0. Si falla o queda incierto, conservar el aviso de error para
   revisión técnica; no repetir expulsiones manuales para simular éxito.
5. Tras un minuto desde el intento de expulsión, revisar el privado del voluntario:
   enlace del mismo grupo, una entrega. Abrirlo y confirmar en WhatsApp que pudo
   volver. Recibir el enlace y volver son dos comprobaciones diferentes.
6. Restaurar `bot ruleta castigo 15`, `bot ruleta consecuencias off`. Dejar constancia
   del resultado físico, incluyendo fallos, sin pegar enlaces ni identidades privadas.

La prueba real de bot sin administración se puede hacer voluntariamente en Lab:
quitar temporalmente su admin, abrir ruleta, comprobar aviso sin consecuencias y
volver a darle admin. No se necesita para ejecutar los tests simulados ni para
probar partidas sin consecuencias. Un reinicio físico durante partida lo ejecuta
el constructor por el procedimiento autorizado de despliegue si el dueño acuerda
esa prueba; la cobertura SIGKILL automática ya existe en entorno aislado.

## Revisión

Auditoría arquitectónica **aprobada sin correcciones de código**, según confirmación
del dueño del 16-10-2026 (DEC-038). Fase 3 **aprobada/lista para cierre técnico** con
la evidencia automática y de integración existente. La prueba física de expulsión,
enlace y reingreso es recomendable, opcional y no bloqueante. Se conserva toda la
cobertura y la lista voluntaria; las pruebas físicas no se presentan como ejecutadas.
No fusionar a main, iniciar Fase 4 ni activar módulos fuera de Lab.

## Resultado final automático y operativo

16-10-2026: typecheck, lint y build correctos. Suite completa: **318/318 tests** en
**23 archivos**, **162,52 segundos**; 206 regresiones originales + 112 nuevos.
El archivo original de reinicios solo se amplió; el resto de tests/fixtures previos
permanece idéntico. Se comprobó ausencia de valores privados conocidos en archivos
versionados/candidatos. No se añadieron dependencias ni servicios de pago.

Despliegue **`f656b1c`** por el script oficial, backup previo verificado y migración
005 a las 15:14:07 UTC. `/health` **HTTP 200** a las 15:14:44 UTC, base y Evolution
conectados. App/worker con imagen esperada y saludables; sin errores nuevos.
Snapshots de once tablas anteriores idénticos; Evolution no se reinició. Cero grupos
habilitados fuera de Lab y consecuencias de ruleta apagadas inicialmente.

La lista manual anterior sigue **no ejecutada, opcional y no bloqueante**. No hubo
mensajes reales ni expulsiones de prueba enviados por el constructor. La lectura real del enlace
solo valida el contrato de obtención, no su recepción privada ni el reingreso físico.
Rama publicada sin merge; auditoría arquitectónica aprobada y fase lista para cierre
según DEC-038. El constructor se detiene tras registrar la aprobación y verificar
el estado, sin esperar pruebas físicas adicionales.

## Verificación tras aprobación arquitectónica — 16-10-2026

Actualización exclusivamente documental por DEC-038. Typecheck, lint y build
correctos; **318/318 tests en 23 archivos**, **158,50 segundos**. No se eliminó
ningún test ni se redujo cobertura. `/health` **HTTP 200** a las **15:32:43 UTC**,
con `ok=true`, `database=true`, `evolution=true` y transporte Evolution.
Se conserva el despliegue existente. La prueba física sigue no ejecutada,
recomendable y opcional/no bloqueante para el cierre técnico aprobado.
