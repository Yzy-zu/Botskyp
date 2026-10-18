# Observer temporal — evidencia de pruebas

## Automatizadas

Primera tanda del recorder: 14/14 PASS. Incluye turno completo, timeout de Gemini,
denegación Policy, handler con rollback a savepoint, rollback del turno, fallo real
de INSERT (tabla observer temporalmente no disponible en BD de tests), spool,
reinicio/replay idempotente con pérdida de checkpoint, worker fallido/recuperado,
artifacts múltiples, modo apagado, redacción, disco sin capacidad y retención.

La suite se amplía con dos replayers simultáneos, archivo previo truncado, export
online/offline y comparación de turnos completos ON/OFF. Checks y cifras finales
se completan después de ejecutar el código congelado.

## Smoke productivo autorizado

Solo salud técnica de app/worker/DB/Evolution y ambos sinks. Comprobar una timeline
de un turno humano que llegue normalmente después del deploy; si no llega, dejar
la validación física explícitamente pendiente. No emitir mensajes sintéticos,
Nuclear, broadcast ni reinicios Minecraft. Las conversaciones reales corresponden
al dueño. No se acreditará una respuesta ni entrega sin recibo persistido.

## Hallazgo preexistente comprobado, sin corrección

`tests/natural-foundations.test.ts:133` exige fast path `pong` en v1.1 con Gemini
apagado. Esa expectativa quedó desactualizada tras la promoción AI-first. Se
reprodujo **sin observer** en un worktree separado del baseline exacto `73ee8b8`:
1 fallo / 24 omitidos al seleccionar solo ese caso; recibió la misma negativa
«La IA no pudo responder…», sin recibo de tool. No se modificó esa prueba ni el
router para volver a introducir el fast path. La suite global no se declara verde
si conserva este fallo heredado. El test de startup sí se adapta al campo técnico
nuevo de `/health`, conservando las comprobaciones DB/Evolution y sus códigos HTTP.

## Suite global previa al cierre focalizado

`npm test`: 1297 PASS, 9 FAIL, 14 omitidos; 59 archivos, 22 min 22 s.
Un fallo era la comparación estricta de `/health`, ya adaptada al nuevo campo.
Los otros ocho no se corrigen en este trabajo:

- Ping v1.1 determinista: mismo fallo reproducido sin observer en 73ee8b8.
- Cinco smoke Gemini con `mockNow=2026-10-18T16:00Z`: sesiones/confirmaciones
  retroactivas violan `sessions_v2_check`/TTL y hubo cuota del proveedor. Scenario 3
  se reprodujo en 73ee8b8 sin llegar a llamar al modelo: mismo constraint. No se
  repiten llamadas reales ni se modifica ese fixture temporal.
- `router-shadow`: exige escoger dominio Minecraft por texto, anterior al retiro
  AI-first de selección semántica en backend. Mismo fallo probado en baseline.
- `context-v2`: su regex `dealer.*10` también alcanza el texto hexadecimal de una
  SafeRef posterior al campo `dealerVisible=9`, produciendo falso positivo variable.
  Mismo fallo probado en baseline, sin revelar el deck. No se modifica la prueba.

Evidencia privada: `.local/observer-full-tests.log`,
`.local/observer-baseline-clock.log`, `.local/observer-baseline-context.log`.
No se afirma que la suite histórica completa esté verde. La revalidación focalizada
comprueba las superficies cambiadas y los fallos específicos del observer.

## Cierre focalizado — código final

**260/260 PASS en 11 archivos**: observer (17), startup, mensajería, jobs media,
Evolution, SessionV2, artifacts, configuración, seguridad biblioteca, Minecraft y
rollout global. Sin llamadas reales nuevas a Gemini. Los escenarios A–J del
recorder pasan, incluidos replay concurrente, truncado y export online/offline.
Typecheck, lint, build, Compose, sintaxis shell, diff y auditoría de secretos PASS.

Overhead mediano de cinco turnos completos con proveedor simulado por condición:
ON 125,09 ms, OFF 82,92 ms; diferencia **42,17 ms/turno**. Respuestas idénticas.
En 100 eventos de 48 KB: mediana 0,23 ms/evento, p95 4,26 ms. Son aproximaciones
locales bajo carga de tests, sin extrapolación de percentiles a WhatsApp real.
