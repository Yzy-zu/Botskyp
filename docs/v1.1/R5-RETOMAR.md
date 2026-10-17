# R5 — Nota para retomar

**Nota histórica de la pausa del 17-10-2026.** El dueño autorizó retomar y el smoke
se completó. El estado final y los pendientes vigentes están en
[R5-GEMINI-REAL.md](R5-GEMINI-REAL.md); el texto siguiente conserva el punto de pausa.

## Estado del repositorio y límites

- Rama `feat/v1.1-natural-router`, HEAD base `387f3dd47e82f201f78df262ee90d8eb5c16a615`.
- Los cambios de esta sesión están sin commit/push. Revisar `git status` y el diff;
  no descartarlos ni volver al HEAD para empezar de cero.
- No hubo merge, deploy, cambios a Evolution, activación de grupos ni facturación.
- El objetivo sigue siendo el smoke cotidiano con Gemini real, unas 20–30
  conversaciones; sin framework de evaluación, auditoría general ni nuevos bridges.

## Cambios hechos

- REST Gemini: cuatro filtros ajustables oficiales en OFF; registro de bloqueos
  como `provider_blocked_<motivo>` con tokens, en lugar de ok. Sin bypass del proveedor.
- Mensaje de bloqueo identifica Gemini; sanitizer conserva nombres de proveedores.
- Composer acepta JSON envuelto completamente en fence Markdown y mantiene el
  contrato sin efectos. El cálculo del 15 % de 280 ya devuelve 42 de verdad.
- Context Builder envía diálogo reciente scoped del actor/chat como REFERENCE_DATA;
  exposición consulta los dos mensajes recientes. Presupuesto acotado, sin replay
  de functionCalls. «Eso» sobre tacos y «el otro» entre pizza/hamburguesa funcionaron.
- Logs diferencian fallo técnico/proveedor y tool inexistente/fuera de exposición.
- Persona ajustada a cotorreo relajado, con menos insulto forzado. **Aún no se probó
  en Gemini el prompt final**: la tanda activa había cargado la versión anterior.
- Últimos fixes todavía sin validar: descripción de capability explica que notas,
  memoria y recordatorios pertenecen a productivity; notes.list pide omitir query
  al listar todo; declaración Gemini de memory.remember expone solo body obligatorio,
  mientras Policy conserva el alias histórico fact. No se aflojaron permisos/schemas.
- Documentación: Plan §0, DEC-063, Roadmap §16, incidente local e informe
  `R5-GEMINI-REAL.md`. Ese informe está en elaboración.

## Pruebas y evidencia guardada

- Typecheck, lint y build pasaron **antes de los últimos cambios de persona,
  descripción de tools y declaración de memory.remember**. Repetir al retomar.
- 143/143 pruebas focalizadas pasaron (llm, contexto y router natural) antes de esos
  últimos cambios. Log `.local/r5-real-focused.log`.
- Suite completa **interrumpida**, sin resultado final. Log `.local/r5-real-full-tests.log`.
- Smoke principal guardó **21 turnos de 16 conversaciones, 20 llamadas reales**;
  último: `16-correccion-hora`, editar recordatorio a las 21:00.
- `.local/r5-real.json`: transcripción principal, respuestas crudas del proveedor,
  usageMetadata, tools/resultados y tiempos. `.local/r5-real-smoke.log`: log legible.
- `.local/r5-resume.json`: nombre de la BD temporal conservada, consumo y snapshot
  de notas/recordatorios/memoria. No es producción. La BD puede ser limpiada por el
  mantenimiento habitual de tests: el snapshot y la transcripción permanecen.
- `.local/r5-real-smoke.ts`: script ad hoc ignorado por Git. Usa receive/processNext,
  BD temporal, MockEvolution, Gemini real y servicios existentes; nunca WhatsApp real.
- `.local/r5-conversations.json`: las 28 conversaciones planeadas.
- Evidencia adicional y consumo que debe sumarse al total: `.local/r5-baseline.json`,
  `.local/r5-baseline.log` (primer intento con error del script tras una llamada),
  `.local/r5-real-initial.json`, `.local/r5-real-initial-state.json` y
  `.local/r5-real-initial.log`. No confundir reintentos con casos nuevos aprobados.
- El primer intento de tanda encontró cuota local de 5 RPM. La repetición amplió
  **solo en su proceso** a 30 RPM usuario/global, 180 al día, 300000 input TPM;
  pausa real 13,5 s entre solicitudes. Producción/.env conservan sus valores.
  Los tiempos guardan pacedMs para restar esa pausa de la latencia útil.

## Hallazgos reales pendientes

1. Edición de nota «mejor cámbialo»: Gemini pidió capability domain=notes, que no
   existe (debe ser productivity). No hubo cambio ni éxito falso. Se mejoró la
   descripción, pero falta repetir y revisar exposición/referencias si persiste.
2. Listar notas: Gemini mandó query=notas y obtuvo vacío pese a notas existentes.
   Se corrigió la descripción; falta prueba real.
3. Guardar memoria: Gemini mandó body y fact iguales, violando XOR de Policy;
   por eso la memoria no se guardó y el privado devolvió vacío. Se estrechó la
   declaración del proveedor a body; falta validar con typecheck/tests/Gemini.
4. Recordatorio: AM/PM seguido de «de la noche» sí creó mañana a las 20:00 sin
   otra llamada IA. Cambiarlo a las 21:00 falló con INVALID_TIME. **Sin diagnosticar
   todavía**: revisar args reales en transcripción y semantic-time/legacyArguments.
5. El tono anterior era insulto automático incluso en cuentas; verificar persona final.
6. No se observaron bloqueos de contenido de Gemini en la parte ejecutada. No se
   alcanzaron todavía los casos adultos; no afirmar validación NSFW ni ausencia
   global de restricciones. No se halló capa propia general de moderación R1–R5.

## Continuación recomendada

1. Leer esta nota, diff, informe parcial y evidencia local. No repetir preparación.
2. Diagnosticar INVALID_TIME y retestar los fixes de nota/memoria con casos pequeños;
   sumar una regresión específica si se cambia lógica, sin ampliar arquitectura.
3. Continuar conversaciones 17–28: listar recordatorios, polls/voto corregido,
   blackjack, web, QR crear/leer, Minecraft status/players y reinicio como member
   (debe denegarse), temas adultos/doble sentido y funciones no disponibles.
4. **Arreglar antes el script de prueba multimedia:** docker cp crea el directorio
   temporal como root/700, pero docker exec usa node. Dar propiedad node solo a
   ese directorio temporal, o ejecutar el procesador de prueba con usuario coherente;
   no cambiar el worker productivo ni sus procesadores. Este camino aún no se ejecutó.
5. Minecraft en el script usa rutas locales de la llave restringida con sudo; no
   imprimir llaves. Solo consultas reales. Envíos siempre MockEvolution.
6. El script actual crea una BD nueva y recorre TODO el corpus desde el principio;
   **no relanzarlo sin adaptarlo** a los casos pendientes/fixtures de estado.
   Guardar la evidencia existente con otro nombre si se vuelve a usar label=real.
7. Repetir checks finales y suite apropiada tras congelar los fixes. Completar el
   informe con resultados reales, bloqueos por origen, consumo total de todos los
   intentos y latencia sin pausas, pendientes concretos para WhatsApp. No desplegar
   ni fusionar. Detenerse tras la entrega solicitada.
