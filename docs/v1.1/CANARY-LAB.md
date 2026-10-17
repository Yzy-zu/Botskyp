# Canary Natural-First — Botsky Lab

Base aprobada: `da4e6d3`, rama `feat/v1.1-natural-router`.
Autorización: primer deploy exclusivamente en Lab; sin merge a main.
El JID real se configura en `.env` privado; nunca se incluye en este informe.

## Plan mínimo

1. Confirmar árbol limpio, local/remoto, salud, respaldo y rollback v1.
2. Repetir únicamente los dos fallos anteriores y clasificar su causa.
3. Agregar allowlist por chat con configuración efectiva compartida por modo.
4. Aplicarla al inbox, router y fronteras de workers/outbox, conservando un pool Gemini.
5. Redactar identificadores de chat en los dos loggers que los emitían.
6. Validar aislamiento Lab/resto, límites locales y checks del cambio.
7. Desplegar con `scripts/deploy.sh`, backup y migraciones aditivas 011–014.
8. Verificar salud y aislamiento; observar un smoke humano pequeño en WhatsApp.
9. Ante un fallo grave, volver Lab a v1; conservar migraciones aditivas.

## Dos fallos de la primera corrida 337/339

- `parses a deduplicated pool, prefers it over legacy and falls back for empty lists`
  (`tests/config.test.ts`): el fixture con punto se añadió mientras estaba cargado
  el validador previo. Fallo de fixture/orden de ejecución durante edición.
- `rolls back a real process death after INSERT before commit, then retries once`
  (`tests/policy-v2.test.ts`): el proceso hijo no llegó a la barrera advisory dentro
  de su ventana durante checks estáticos concurrentes. Timing de arranque.

En el preflight del Canary se repitieron ambos, sin cambios de código ni checks
paralelos: **2/2 en 8,54 s** y **2/2 en 8,07 s**. También estaban verdes en las
repeticiones previas de R5.1. No se amplió el timeout ni se modificó Policy.

## Estado previo

- Local y remoto en `da4e6d3`, árbol limpio. Main local/remoto en `0c1a19e`.
- App/worker y PostgreSQL propio saludables; Evolution conectado, PG/Redis ajenos
  sin cambios. Sólo Lab habilitado; inbox/outbox/jobs sin trabajo pendiente.
- Backup normal existente con SHA-256 y archivo completo verificados; snapshot
  anterior con imágenes inmutables de app/worker disponible para rollback.
- Producción tenía migraciones 001–010. 011–014 añaden tablas, columnas, índices y
  triggers compatibles con los INSERT legacy; no hay DROP ni borrado de datos.
- Pool válido; daily local 0 y concurrencia 4. Cantidad de keys se informa sin valores.

## Límites del smoke

Los mensajes entran desde el WhatsApp del dueño: `fromMe` se ignora en el webhook.
No se simulan mensajes entrantes ni se presenta un mock como prueba WhatsApp.
Sin Nuclear, restart Minecraft, acciones destructivas, activaciones fuera de Lab,
cierre de los ocho bridges ni trabajo DOCX/LibreOffice. El bug DOCX conocido queda
pendiente; si aparece se registra evidencia. Bugs B/C se documentan; sólo A se corrige.


## Selector mínimo y validación

`ROUTER_V1_1_CHAT_IDS` es CSV, trim/dedupe y validación de grupos. Cuando existe,
sólo los grupos listados usan v1.1 y todo lo demás usa v1, incluso si ROUTER_MODE
fuera v1_1. Vacía fuerza v1 en todos. Si la variable no existe, se conserva el
modo global histórico para compatibilidad. Compose siempre propaga la variable;
producción fija default v1 y exactamente una entrada de Lab en `.env`.

Las vistas Config se cachean por modo y comparten el mismo pool Gemini del root:
no se reinicia su cooldown ni se multiplica el semáforo entre Lab y legacy.
Inbox, acceso directo al router, workers media/Drive y outbox resuelven por chat;
recovery y avisos de entregas fallidas resuelven el modo por cada job.
Los loggers de ingreso y tools redactan chatId; el arranque sólo publica cantidad
de keys, tamaño de allowlist, modo default y concurrencia, sin identificadores.

Validación focalizada del cambio: primera tanda 57/58; una expectativa del test
nuevo olvidó el XP de actividad existente. Corregida esa expectativa, aislamiento
**6/6** (inbox/R3 frente a legacy, pool compartido, media/outbox/recovery y rollback
con allowlist vacía). R5 afectado: **6/6**, incluyendo continuidad/agotamiento sin
doble daily, Fast Path, transcripción y retención/entrega. No se repite suite completa.
Typecheck, lint, build y auditoría de secretos se ejecutan antes del deploy.

## Rollback disponible

Main sigue en `0c1a19e`, sin merge. El snapshot v1 anterior se conserva en un enlace
privado `.local/canary-v1-rollback-compose.json` con sus imágenes inmutables.
Rollback de Canary: vaciar `ROUTER_V1_1_CHAT_IDS`, conservar ROUTER_MODE=v1 y ejecutar
`scripts/deploy.sh`; no revertir 011–014. El selector vacío se probó sin efectos.
El script oficial conserva su rollback automático de imágenes si falla el deploy.
No se induce un crash real ni se restauran datos de producción para demostrarlo.
