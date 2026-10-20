# Cierre dirigido de production-unblock — 20-10-2026

Base local/origin/app/worker: `f65a7b15b2b9c4e3d0187f577fc56a968966457e`.
Diff inspeccionado desde `2c137f70298735a68e37f3e836f7e331c45a3f40`:
14 archivos del último unblock, sin revisar toda la historia.

- Mantenimiento se selecciona por Gemini mediante metadata/schema/guidance;
  no había un shortcut textual nuevo. Regresiones comprueban cuatro frases y
  cero efectos cuando el modelo no emite la llamada.
- Tiempo relativo canonical; solo `kind=day` se normaliza antes del schema de
  Policy. Se rechazan aliases arbitrarios y campos de reloj ignorables.
  Fecha sin hora y recordatorio sin tiempo piden aclaración, sin defaults.
  Periodos relativos no admiten campos de reloj; días con hora explícita tienen
  su propio schema. El tiempo nunca se copia de solicitudes históricas.
  Las aclaraciones de am/pm congelan también la fecha de días relativos.
- Qualification y producción full usan exactamente `fullCatalogDeclarations`:
  99 tools públicas + 3 meta-tools. Confirmación/cancelación siguen validando
  la sesión real. El hash cubre también estas meta-tools y el manifest exige
  versión, hash, cantidad y ambos indicadores de compatibilidad correctos.
  El CLI verifica nombres y argumentos de las llamadas, no cualquier llamada.
- Se reduce guidance repetido y el contexto sube de 16k a 18k caracteres
  para conservar solicitud máxima, catálogo, archivos y sesión sin truncarlos.
- Diagnóstico: registered/exposed, rolePermitted, moduleEnabled, configured,
  staticEligible y preconditionDependent. currentlyExecutable=null significa
  que solo Policy con argumentos y DB viva puede determinar ejecución real.
  En Lab: 99 públicas, 92 configuradas; Drive apagado. No promete 99 ejecutables.
- Scoring QA: progreso sustituido no invalida resultado terminal enviado del
  mismo job. Un job fallido se clasifica JOB_FAILED aunque entregue su error.
- Smokes usan `.env`, descubrimiento de red Compose, IDs únicos y recibos;
  exigen worker done y entrega sent. El seed incluye extension y está probado
  contra la DB real de tests. Usan marcador único sin formato UUID (el contexto
  redacta IDs técnicos), limpian notas por recibo/turno/tiempo, recordatorios
  por receipt ID y expiran entradas/salidas media conservando sus recibos. Sin credenciales literales ni rotación.
- Respaldo verificado antes de limpiar dos notas y un recordatorio anteriores,
  identificados por mensaje PROD_SMOKE, actor/chat, contenido y timestamps.
- Games: NO_ACTIVE_GAME se limita a status/cancel y al error de ausencia;
  se conserva. Moderation requiere mención auténtica; se conserva.
- El dueño eximió el smoke físico de miembro normal: se valida automáticamente
  DENIED_PERMISSION y ausencia de efecto. No se solicita intervención manual.

Validación: typecheck y lint PASS; 142/142 en 12 suites dirigidas y 10/10
rechecks de routing/qualification; Policy completa sin fallos. El ajuste temporal
posterior pasó 71 regresiones y una adicional de aclaración relativa. Fixtures con runner real del
worker (PNG→sticker, OGG→MP3, PDF→pdf_compress), y smokes A–F tras qualification.
No se ejecuta campaña nightly. Manifest runtime ignorado por Git; lo escribe
`npm run llm:qualify` atómicamente después del deploy y se reinicia app para cargarlo.
Push/deploy solo en `feat/universal-tool-calling`, sin merge. Observer=false.

Recheck del helper de fixtures y scorer: 45/45 pruebas dirigidas PASS.
