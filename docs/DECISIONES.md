# Botsky — Registro de Decisiones Técnicas y Arquitectónicas

**Archivo:** `docs/DECISIONES.md`  
**Última actualización:** 15 de octubre de 2026  
**Responsable:** Arquitecto / Revisor de Botsky

Este documento registra las decisiones técnicas tomadas durante la ejecución del proyecto, su justificación y el tratamiento formal de contradicciones documentales o discrepancias con el entorno real.

---

## 1. Decisiones Arquitectónicas Adoptadas en Preparación

### DEC-001: Soporte Obligatorio para Arquitectura ARM64 (`aarch64`)
- **Contexto:** El VPS de Oracle (`miroslav`) corre sobre procesadores ARM Neoverse-N1 (`aarch64`).
- **Decisión:** Todas las imágenes Docker de Botsky (`botsky-app`, `botsky-worker`, base de datos y utilidades) deben ser compatibles nativamente con `linux/arm64`. En el `Dockerfile` de Node.js se usará la imagen oficial multi-arch `node:24-alpine` o `node:24-bookworm-slim`.
- **Razón:** Prevenir errores de emulación en tiempo de ejecución o fallos al ejecutar binarios compilados en C/C++ (ej. `better-sqlite3`, `canvas`, herramientas multimedia).

### DEC-002: Base de Datos PostgreSQL 17 Dedicada para Botsky
- **Contexto:** El Plan Maestro §4 especifica PostgreSQL 17 con base propia. En el VPS ya corre `evolution_postgres` (PostgreSQL 15.19) limitado a 512 MB de RAM y 0.2 CPU.
- **Decisión:** Desplegar un servicio PostgreSQL 17 propio (`postgres:17-alpine`) en el `docker-compose.yml` de Botsky, con su propio volumen persistente (`botsky_pgdata`) y red interna.
- **Razón:**
  1. **Aislamiento de producción (Regla de Oro #3):** Evita que consultas pesadas, migraciones o errores de Botsky afecten a Evolution API.
  2. **Compatibilidad funcional:** PostgreSQL 17 incluye mejoras significativas en rendimiento para consultas con `FOR UPDATE SKIP LOCKED` y funciones JSON.
  3. **Independencia operativa:** Permite ejecutar respaldos (`pg_dump`), upgrades de versión o rollbacks de base de datos sin tocar el contenedor de Evolution.
  4. **Capacidad del VPS:** Con 3.9 GiB de RAM disponible, el impacto de ~120 MB adicionales es insignificante frente a la estabilidad obtenida.

### DEC-003: Sin Redis para Botsky
- **Contexto:** Aunque `evolution_redis` está activo en el VPS para Evolution API, se evaluó si Botsky debía usarlo para colas o caché.
- **Decisión:** Confirmar la regla del Plan Maestro §4: **Sin Redis**. La cola de tareas pesadas reside exclusivamente en la tabla `jobs` de PostgreSQL con `FOR UPDATE SKIP LOCKED`.
- **Razón:** Simplifica la arquitectura, minimiza el consumo de memoria, garantiza persistencia transaccional ACID de los jobs junto a los datos del bot y evita puntos únicos de fallo adicionales.

### DEC-004: Comunicación Interna vía Red Docker (`evolution_evolution_net`)
- **Contexto:** Botsky necesita recibir eventos de webhook desde Evolution API y enviar mensajes mediante su API REST (`http://127.0.0.1:8080`).
- **Decisión:** El `docker-compose.yml` de Botsky se integrará a la red existente `evolution_evolution_net` declarándola como externa (`external: true`).
- **Razón:**
  1. Permite comunicación directa entre contenedores (`http://evolution_api:8080`) sin requerir abrir puertos adicionales en la interfaz pública ni depender de nombres de dominio o proxies inversos.
  2. Protege el webhook de Botsky (`http://botsky-app:3000/webhook`), el cual no necesita exponerse a Internet público, reduciendo drásticamente la superficie de ataque.

### DEC-005: Control Remoto de Minecraft en `redspi` vía Tailscale + SSH Restringido
- **Contexto:** Se verificó que el servidor Bedrock corre en el nodo `redspi` (100.104.54.2), ejecutando el contenedor Docker `mc-bedrock` (`itzg/minecraft-bedrock-server:latest`).
- **Decisión:**
  1. Adoptar el diseño obligatorio de §9.13: Crear una llave SSH dedicada para Botsky (`~/.ssh/botsky_mc_id_ed25519`).
  2. En `redspi`, configurar `authorized_keys` con restricción estricta `restrict,command="/opt/botsky/mc-ctl.sh"`.
  3. El script `mc-ctl.sh` validará exhaustivamente `SSH_ORIGINAL_COMMAND` con una allowlist cerrada de comandos (`status`, `players`, `logs`, `start`, `stop`, `restart`, `backup`, `console`), traduciéndolos a llamadas seguras a Docker (`docker exec mc-bedrock send-command ...`).
- **Razón:** Aislamiento total de privilegios. Ningún miembro ni fallo en el bot podrá ejecutar comandos arbitrarios de shell en el servidor de Minecraft.

---

## 2. Contradicciones y Discrepancias Detectadas

En cumplimiento del punto 7 de las instrucciones del arquitecto, se detallan a continuación las contradicciones entre documentos y las discrepancias con el entorno real:

---

### CONTRADICCIÓN 1: Recursos de Hardware (CPU y RAM)
- **Documentos:**
  - `docs/PLAN_MAESTRO.md` §0 (fila VPS): "Oracle Cloud, 4 vCPU, 8 GB de RAM, 50–100 GB".
  - `docs/owner-answers.md` B2–B3: 8 GB RAM, 4 vCPU.
- **Entorno real observado:**
  - `nproc`: 1 vCPU en línea (`lscpu` confirma 1 CPU activa Neoverse-N1).
  - `free -h`: 5.8 GiB RAM total (aprox. 6 GB), con 3.9 GiB disponible.
- **Conflicto:** El servidor cuenta con 1 vCPU en lugar de 4 vCPU, y 6 GB de RAM en lugar de 8 GB.
- **Recomendación y Mitigación:**
  - El arquitecto y los constructores deben diseñar el worker con concurrencia estricta `concurrency: 1`.
  - Las tareas pesadas de medios (ffmpeg, LibreOffice, OCR) deben tener límites de CPU y memoria (`limits.memory: 768M`, `limits.cpus: '0.5'`) y ejecutarse con prioridad baja (`nice`), para no degradar el tiempo de respuesta del webhook principal.
  - El dueño puede revisar posteriormente en la consola de Oracle si la instancia fue provisionada con 1 OCPU/1 vCPU en vez del tamaño Ampere A1 completo (4 vCPU / 24 GB), pero el proyecto debe ser completamente estable con los recursos actuales observados.

---

### CONTRADICCIÓN 2: Estado de Sesión e Instancia de Evolution API [RESUELTA]
- **Documentos:**
  - `docs/owner-answers.md` B8, C4: Evolution "Ya funciona" y número "Ya está vinculado a Evolution API".
  - `docs/PLAN_MAESTRO.md` §0 (fila WhatsApp): "Un solo número, prepago, desechable, ya vinculado a Evolution."
- **Entorno real observado inicialmente:**
  - A las `17:43` del 15 de octubre de 2026 la sesión sufrió un `LOGOUT` y la instancia fue removida temporalmente.
- **Resolución (16 de octubre de 2026):**
  - El dueño recreó exitosamente la instancia `botsky` y completó la vinculación por QR con WhatsApp.
  - Verificado en solo lectura: `connectionStatus: "open"`, `ownerJid: "${BOT_JIDS}"`.
  - Grupo oficial de pruebas `Botsky Lab` (`${LAB_CHAT_ID}`) creado y verificado con el bot como administrador (`admin: "admin"`) y el dueño como `superadmin`.
  - **Estado:** Bloqueo resuelto. El entorno cuenta con sesión de WhatsApp activa y grupo oficial de pruebas listo para la Fase 0.

---

### CONTRADICCIÓN 3: Política de Acceso a Chats Privados
- **Documentos:**
  - `docs/owner-answers.md` D6: "¿Quién puede hablar con el bot en privado? -> Solo personas que yo apruebe".
  - `docs/PLAN_MAESTRO.md` §0 (fila Privados) y §6.2: "El owner y los miembros actuales de cualquiera de los grupos habilitados quedan autoaprobados para conversar y recibir entregas por privado. Extraños ajenos a esos grupos se ignoran salvo autorización expresa."
- **Conflicto:** La respuesta preliminar del cuestionario exigía aprobación manual para todos, mientras que la especificación final del Plan Maestro (§0, que tiene jerarquía absoluta sobre el cuestionario) otorga autoaprobación a los miembros de los grupos habilitados.
- **Recomendación:** Aplicar la jerarquía documental de `AGENTS.md` §1: **`docs/PLAN_MAESTRO.md` §0 prevalece**. Los miembros de grupos habilitados tienen autoaprobación para privados; las personas ajenas requieren aprobación manual explícita (`users.private_ok_manual`).

---

### CONTRADICCIÓN 4: Ubicación de los Datos de Minecraft
- **Documentos:**
  - `docs/owner-answers.md` B15: "Minecraft no corre en este VPS".
  - `docs/PLAN_MAESTRO.md` §9.13: "Corre en otro VPS, dentro de Docker, y se controla por SSH a través de Tailscale."
- **Entorno real observado:**
  - En el VPS actual (`miroslav`) existe un directorio residual `/home/petrov/docker/minecraft` con datos y un compose antiguo (detenido).
  - En Tailscale se verificó que el VPS `redspi` (100.104.54.2) es el que actualmente corre el servidor oficial de Bedrock en el contenedor `mc-bedrock`.
- **Conflicto:** Podría haber confusión sobre si se debe controlar la carpeta local de `miroslav` o el servidor remoto de `redspi`.
- **Recomendación:** La carpeta local `/home/petrov/docker/minecraft` en `miroslav` debe considerarse inactiva/backup y **no tocarse**. El objetivo de control para la Fase 4 es única y exclusivamente el contenedor `mc-bedrock` en `redspi` a través de Tailscale.

---

### CONTRADICCIÓN 5: Versión de Base de Datos
- **Documentos:**
  - `docs/PLAN_MAESTRO.md` §4: "PostgreSQL 17. Base propia de Botsky. Si Evolution ya usa un Postgres, se reutiliza el servidor con otra base. El agente lo inspecciona en la Fase 0."
- **Entorno real observado:**
  - `evolution_postgres` corre PostgreSQL versión 15.19, no 17.
- **Conflicto:** Reutilizar el Postgres existente implicaría degradar la especificación a PostgreSQL 15 y someter a Botsky a los límites de memoria de Evolution (512 MB).
- **Recomendación:** Seguir la directriz de mayor jerarquía técnica del Plan Maestro (DEC-002): desplegar PostgreSQL 17 dedicado para Botsky.

## 3. Decisiones de implementación de Fase 0 (pendientes de revisión)

### DEC-006: Inbox persistente y procesamiento serial
El webhook confirma solo después de insertar `seen_events` e `inbox` en la misma
transacción. Dedupe usa hash de instancia, chat e ID del proveedor. La app procesa
la recepción en orden, de uno en uno; la transición a outbox y el cierre del inbox
son atómicos. Locks de PostgreSQL impiden dos emisores o dos workers simultáneos.
Los eventos viejos se rechazan al recibirlos; un evento aceptado antes de caer
conserva su derecho a procesarse después del reinicio.

### DEC-007: Incertidumbre de entrega conservadora
Un timeout, una excepción de red o una caída en estado `sending` pasa a `uncertain`.
Solo evidencia positiva del proveedor confirma la entrega. La ausencia de un
mensaje en una página de historial no demuestra que no salió: si no puede
comprobarse, permanece incierto y se notifica al dueño sin reenvío ciego.
El mock puede demostrar ausencia porque controla íntegramente sus entregas.

### DEC-008: Alcance de laboratorio y recuperación de imágenes
En Fase 0 hay una barrera explícita para grupos distintos de Botsky Lab, incluso
ante un comando del dueño. Los privados requieren dueño o pertenencia/aprobación
persistida. No se infieren alias por nombres. El despliegue conserva la configuración
resuelta privada y la imagen anterior por ID inmutable. El rollback revierte app y
worker; nunca restaura automáticamente datos sobre producción. La migración inicial
es aditiva/transaccional. La restauración se prueba en una BD nueva aislada.

### DEC-009: Entorno local y límites de implementación
Node 24 se descargó del sitio oficial y se verificó por SHA-256 dentro de `.local/`;
no se reemplazó Node 20 del host. El `.env` heredado tenía separadores inválidos para
Compose: se respaldó completo de forma privada y el activo usa solo Fase 0.
Gemini y las capacidades de fases futuras no se inicializan. El worker rechaza tipos
de trabajo desconocidos; ninguna herramienta multimedia queda habilitada.

### DEC-010: DNS exclusivo de la base y alcance del healthcheck simulado
El alias `postgres` existe también en la red de Evolution. Botsky utiliza
`botsky-db` solo en su red privada; modo Evolution exige ese host, usuario y base
propios. El incidente de autenticación fallida no ejecutó ninguna migración sobre
Evolution. `/health` en mock devuelve `evolution:null` para evitar atribuir al
proveedor real un resultado simulado. El capturador se verificó desde Evolution
antes de considerarlo accesible y permanece separado de app/worker.

### DEC-011: Respaldo diario local y pendientes externos explícitos
El despliegue programa una única entrada cron local sin sobrescribir las otras del
dueño. No se instala/configura Drive sin credenciales locales comprobadas. Se
mantienen todas las copias por ahora: la copia externa, retención de siete copias
y restauración en un VPS de pruebas siguen pendientes y no se declaran realizadas.

### DEC-012: Fixtures originales con procedencia y reconciliación por cita
Se recuperaron cinco webhooks originales mediante los reintentos de Evolution.
Los textos iniciales de grupo/cita/mención habían agotado reintentos y se capturaron
por `chat/findMessages` como respuesta REST real separada (`history.json`). No se
fabrican envelopes de webhook; el normalizador de datos acepta las claves originales
comunes a ambas fuentes. Un manifiesto registra origen y SHA-256 del archivo local.
Se eliminan metadatos criptográficos y se anonimizan JIDs/IDs antes de Git.

El envío cita el ID de la solicitud. La reconciliación solo confirma por ID conocido
o por una única coincidencia de chat, mensaje propio, texto exacto y cita al ID de
solicitud. Una página de historial sin coincidencia devuelve `unknown`, nunca prueba
ausencia. Las reacciones se normalizan por separado y no producen efectos en Fase 0.

### DEC-013: Despliegue real sin tráfico durante promoción
El primer despliegue Evolution se verifica mientras su webhook aún apunta al
capturador y no hay inbox/outbox pendientes del simulador. Solo tras quedar sano se
cambia el webhook a la app. Así un rollback inicial al simulador no puede consumir
entregas reales. Después de promoverse, los siguientes rollbacks conservan una imagen
y configuración reales. Participantes/alias se verifican por API al iniciar y se
refrescan periódicamente; no se convierten `participantAlt` o nombres en privilegios.

### DEC-014: Revocación conservadora ante conflictos de identidad
Si una actualización autenticada del roster contradice un alias ya verificado,
se conserva su vínculo anterior y se marca la evidencia `conflict:`. El resolvedor
excluye esa asociación de privilegios hasta volver a disponer de evidencia coherente.
No se borra ni reasigna automáticamente una identidad. La actualización de roster
se serializa por lock transaccional y no aplica snapshots parcialmente contradictorios.

### DEC-015: Resultado real y alcance del simulacro de reinicio
El dueño confirmó `pong`. Un simulacro encoló tres respuestas de diagnóstico a tres
mensajes reales distintos de Botsky Lab y reinició solo la app después de la primera.
Las tres se verificaron por estado/ID en outbox y por una coincidencia exacta por cita
en Evolution. Se realizó inicio explícito tras `docker kill`, porque Docker considera
esa acción una parada manual; no se modificó `unless-stopped` para ocultar esa semántica.
La evidencia de inbox/réplicas HTTP con caída abrupta se verifica además en tests aislados.

### DEC-016: Identidades operativas fuera del árbol versionado
Los scripts cargan `OWNER_JIDS`, `BOT_JIDS`, `LAB_CHAT_ID` e `INSTANCE` desde
`.env` o el entorno. El exportador usa `.local/fixture-identities.json`, sustituible
por `FIXTURE_IDENTITIES_FILE` o `--identities`; rechaza identidades largas sin mapa.
Los valores reales y el mapa se conservan solo localmente; las fixtures siguen siendo
las capturas reales anonimizadas. Se revisaron archivos actuales y cambios de la rama,
sin imprimir valores. Los commits históricos previos no se reescriben; sus versiones
antiguas todavía contienen las identidades retiradas del árbol actual.

### DEC-017: Disponibilidad al arrancar y avance de la outbox
Un error del refresco inicial de miembros genera advertencia y permite iniciar
Fastify. `/health` sigue consultando al proveedor y responde 503 mientras esté
caído; el refresco periódico puede recuperar la sincronización sin reiniciar.
La outbox conserva los envíos `uncertain` agotados para auditoría, pero solo
bloquean FIFO mientras queden intentos de reconciliación. Los pendientes con
intentos disponibles siguen respetando el orden del chat.

### DEC-018: Ciclo de vida seguro de las bases de tests
El setup identifica explícitamente el servicio Compose `botsky/postgres`, su red
privada, PostgreSQL 17, usuario `botsky` y propiedad de la base `botsky` antes de
crear o limpiar. El teardown elimina la base de esa ejecución tras cerrar pools.
Un setup posterior recoge bases inactivas de más de 24 horas si una ejecución
fue interrumpida. Solo admite `^botsky_test_\d{13}_[1-9]\d{0,9}$`, comprueba
propiedad y ausencia de conexiones; no usa `FORCE` ni termina sesiones.
Una base activa queda intacta, incluso si hay una conexión concurrente al borrado.
Las bases de producción y nombres no coincidentes se rechazan antes del DROP.
