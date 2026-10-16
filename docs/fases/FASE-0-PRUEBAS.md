# Fase 0 — Evidencia y pruebas

**Estado: núcleo operativo con Evolution y comprobación manual de `pong`.**
El cierre completo está pendiente de revisión y respaldo/restauración externos.

## Evidencia automática

- Node 24: `npm run typecheck`, `npm run lint`, `npm test` y `npm run build`.
- 71 pruebas en 10 archivos (incluidas las correcciones de revisión): activación Unicode, citas/menciones, dedupe concurrente,
  rechazo de eventos viejos/futuros/propios, grupos reales bloqueados y chats
  deshabilitados, privados y revocación de membresía, alias sin resolver y evidencia
  real de participantes, frontera HTTP (secreto/JSON/tamaño), errores de configuración
  sin secretos, outbox/reintentos/incertidumbre y parada persistida.
- Reinicio real del proceso: 12 mensajes por HTTP; se mata con SIGKILL después de
  que el proveedor simulado aceptó una entrega sin devolver aún respuesta. Al
  reiniciar, se reenvían los mismos webhooks. Resultado: 12 entregas, contador 1
  por entrega y ningún inbox pendiente. El estado del proveedor sobrevivió a la app.
- Despliegue real sano: app, worker y PostgreSQL `healthy`; `/health` con
  `transport=evolution`, base y conexión Evolution verdaderas.
- Rollback provocado: candidato con imagen distinta y app que sale 42. El healthcheck
  falla; el script devuelve error y restaura la imagen/configuración anteriores,
  con app/worker `healthy`. No toca el capturador ni Evolution.
- Emergencia real sobre el despliegue simulado: `scripts/panic.sh` dejó la bandera
  `true` y detuvo app/worker; Evolution siguió `open`. Se restableció la bandera a
  `false` por SQL administrativo para cerrar el simulacro y se redesplegó mediante
  `scripts/deploy.sh`. No se añadió un comando de Fase 1.
- Backup diario: entrada cron única instalada; despliegue final `afe1fcc`, app/worker
  y PostgreSQL sanos, proveedor `mock`. No se invocó el transporte real.
- Backup: dump custom legible y SHA-256. Restauración verificada en
  `botsky_restore_1792111836_820032`, una base nueva del PostgreSQL dedicado;
  migración inicial presente. Se conserva para inspección.

- Normalizador validado contra webhooks originales de grupo, privado, audio,
  imagen, documento y reacción. Cita/mención también con registros REST reales.
- Adaptador REST probado con servidor simulado y fixtures originales; la respuesta
  real `pong` del historial permite verificar reconciliación por cita sin inventar
  que la ausencia en una página demuestre que no hubo entrega.
- Prueba real adicional: tres filas de outbox diagnósticas, con fuentes reales
  distintas del laboratorio, interrupción SIGKILL tras la primera entrega e inicio
  explícito de la app. Resultado: tres `sent`, un intento cada una, una coincidencia
  por fuente en el historial. El primer driver asumía reinicio automático tras
  `docker kill`; al observar parada manual se corrigió iniciando la app, sin volver
  a encolar respuestas ni cambiar la política de reinicio.
- Replay de audio viejo original contra el webhook real: `ignored`, sin envío.
- El dueño confirmó expresamente que su `bot ping` nuevo recibió `pong`.
- Configuración final del webhook releída: destino directo a la app; capturador
  detenido y regla temporal de firewall retirada.

Los logs y resultados completos son locales y privados en `.local/`.
Pruebas de tipos, lint, tests y build en verde. No se declara validada la copia Drive
ni la restauración en otro VPS; siguen pendientes.

## Capturas realizadas

El dueño envió texto de grupo, cita, mención, audio, imagen, documento, reacción y
texto privado. Se recuperaron cinco webhooks por reintento y posteriormente un
webhook original nuevo de texto de grupo. Los textos anteriores de cita/mención se
obtuvieron del historial REST, guardado separadamente. No se fabricó ningún envelope
para presentarlo como webhook capturado. Identidades anonimizadas y metadatos
criptográficos retirados antes de Git; procedencia en `manifest.json`.

## Humo manual

1. **Confirmado por el dueño:** `bot ping` → exactamente `pong`.
2. `robot`, `botella`, pregunta sin llamada → silencio.
3. Mención a Botsky con `ping` → `pong`.
4. Respuesta a un `pong` del bot con `ping` → `pong`.
5. Tres `bot ping` seguidos → tres respuestas, separadas al menos un segundo.
6. Dueño por privado: `bot ping` → `pong`; desconocido → silencio.
7. **Confirmado automáticamente en el laboratorio:** outbox real de tres respuestas
   sobrevive a interrupción y reinicio sin duplicados; replay viejo autenticado en silencio.

No se prueban expulsiones, cambios de administradores, grupos reales ni acciones
masivas. Un módulo no se activa en grupos reales sin orden del dueño.

## Revisión requerida

Antes de fusionar, el arquitecto debe aplicar el prompt de revisor de
`docs/PROMPTS.md` al diff de `phase-0-esqueleto` contra `main`, especialmente:
identidades/alias, recepción atómica, outbox e incertidumbre, aislamiento de redes,
backup, migración, rollback y credenciales. La revisión no se da por realizada aquí.

## Verificación final tras la integración

- Release real `b108a84`, app y worker sanos; webhook directo releído por API.
- Capturador detenido. La inspección confirmó ausencia de publicación de puerto
  diagnóstico y de la regla estrecha temporal de firewall.
- Nuevo backup con datos reales restaurado en
  `botsky_restore_1792113873_876819`: migración inicial y cuatro filas de outbox
  presentes. La base restaurada se conserva aislada, sin procesos emisores.
- Escaneo de valores de credenciales locales contra todos los commits de la fase
  y logs operativos: sin coincidencias de credenciales. Este escaneo no cubría
  identidades personales literales: las detectadas después por el arquitecto se
  retiraron del árbol actual en las correcciones descritas a continuación.
- Git: rama propia, PR de revisión, sin fusión y sin inicio de Fase 1.

## Revisión: evidencia de los cuatro hallazgos (2026-10-16)

1. **Outbox:** las dos regresiones fallaron con la selección anterior. Con la
   corrección pasan tanto `reconcile_attempts = maxReconcileAttempts` como un
   intento por encima: #2 pasa de `queued` a `sent`, el mock recibe solo #2 y #1
   permanece `uncertain` con su contador original. Una tercera prueba confirma
   que #1 con presupuesto disponible todavía bloquea FIFO.
2. **Privacidad:** tres pruebas de configuración privada, precedencia del entorno
   y anonimización con rechazo de identidades no mapeadas. Reexportación de
   capturas reales sin cambios en fixtures. Escaneo de todo archivo versionado
   actual y de líneas añadidas en el diff final: cero identidades reales conocidas,
   cero JIDs largos literales. El historial previo no se reescribió y retiene los
   valores antiguos; no se imprimieron en esta auditoría.
3. **Arranque:** con Evolution simulado caído, el primer refresco advierte y Fastify
   escucha un puerto real; `/health` devuelve 503, base `true`, Evolution `false`.
   El siguiente intervalo, tras recuperar el proveedor simulado, sincroniza dos
   miembros y devuelve HTTP 200. No se detuvo Evolution real para esta prueba.
4. **Bases de tests:** tres pruebas cubren patrón estricto, umbral de 24 horas y
   borrado real de una base de tests inactiva manteniendo otra activa. Se rechazan
   explícitamente nombres de producción y nombres malformados. Tras la suite,
   consulta al catálogo: base de la ejecución ausente (0), producción presente (1).

Validación completa: `npm run typecheck`, `npm run lint`, `npm test` (71/71 en
10 archivos, 23.99 s) y `npm run build`, todos con salida 0 usando Node 24.
La suite repitió la prueba de 12 mensajes HTTP con SIGKILL y reconciliación sin
duplicados; no hizo falta generar otra ráfaga en WhatsApp.

Despliegue por `scripts/deploy.sh`: versión `9d1b422`, salida 0, respaldo verificado
antes de promover. App/worker/PostgreSQL `running healthy`; `/health` HTTP 200:
`{"ok":true,"database":true,"evolution":true,"transport":"evolution"}`.
Estado de sesión Evolution consultado en solo lectura: `open`. No se modificaron
su webhook, configuración ni PostgreSQL. No se modificaron deploy/rollback; el
simulacro controlado previo conserva su evidencia. Logs privados `review-*.log`
en `.local/`. PR #1 sigue abierta como borrador; se solicita nueva revisión.
