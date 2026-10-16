# Botsky — Registro de Decisiones Técnicas y Arquitectónicas

**Archivo:** `docs/DECISIONES.md`  
**Última actualización:** 16 de octubre de 2026
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

## 4. Decisiones de Fase 1 (propuestas del constructor; revisión pendiente)

### DEC-019: Gemini gratuito comprobado; una sola clave
El 16-10-2026 se consultaron [modelos](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite),
[precios](https://ai.google.dev/gemini-api/docs/pricing),
[cuotas](https://ai.google.dev/gemini-api/docs/rate-limits),
[function calling](https://ai.google.dev/api/generate-content#FunctionDeclaration),
[visión](https://ai.google.dev/gemini-api/docs/image-understanding) y
[audio](https://ai.google.dev/gemini-api/docs/audio) oficiales.
Se elige `gemini-3.5-flash-lite`: estable, entrada multimodal y salida de texto,
function calling, y entrada/salida con nivel gratuito. La API real devolvió HTTP 200;
una segunda prueba identificó un cuadrado rojo y produjo una llamada tipada con
`color=rojo`. Audio queda verificado como capacidad, sin implementar transcripción
hasta Fase 5. No se usan previews ni generación de audio/imágenes.

El dueño confirmó que los proyectos de las claves locales no tienen facturación
vinculada. Se recuperó únicamente `GEMINI_API_KEY` del archivo local heredado al
`.env` con modo 600; las demás claves no se rotan ni se usan para eludir cuota.
`GEMINI_FREE_TIER_CONFIRMED=true` explicita esa condición operacional. Ninguna
API key permite demostrar por sí sola el estado de facturación.

Los límites efectivos se consultan en AI Studio por proyecto; no hay un RPM/RPD
universal garantizado en la documentación. Los topes locales conservadores en
`config/product.ts` son política de Botsky, no promesa de Google: 8/usuario/min,
5 global/min, 20/día y reserva de 32768 tokens por llamada contra 65536/min
(efectivamente hasta 2 llamadas/min bajo esa reserva). Contexto y salida acotados.
Intentos fallidos también consumen reservas. Día de cuota en `America/Los_Angeles`.
429 tiene como máximo un reintento y luego cooldown persistido. Un bloqueo termina
sin insistir. El presupuesto de tres intentos por mensaje se comparte con búsqueda.

### DEC-020: Búsqueda gratuita autoalojada
Aunque el catálogo anunció `gemini-2.5-flash-lite`, una llamada real a su grounding
respondió 404. Google [restringe los modelos 2.5 a proyectos anteriores](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite).
El grounding de Gemini 3.x no está incluido en su nivel gratuito. Se adopta
SearXNG autoalojado, permitido por §4: contenedor ARM64 sin puertos publicados,
secreto propio independiente del webhook, memoria/CPU limitadas y API JSON interna.
Se verificaron [instalación](https://docs.searxng.org/admin/installation-docker.html)
y [API](https://docs.searxng.org/dev/search_api.html). No requiere cuenta, cookies ni
Redis; el limitador público no aplica a esta instancia privada. Si los motores no
responden, `web.search` explica el fallo y no inventa fuentes. El modo Gemini legado
queda explícito y opcional, siempre con cuota y sin fallback hacia grounding pago.

### DEC-021: Frontera de efectos y persistencia del núcleo
Registro de tools con argumentos Zod estrictos, permisos y módulos verificados otra
vez al ejecutar, también al confirmar. Contexto de ejecución separado del payload
Gemini: nunca hay parámetros actor/chat/permisos. Atajos y ayuda salen del registro.
Las memorias solo se escriben por orden determinista explícita, jamás por propuesta
libre del modelo. Se filtran datos sensibles y no se inyectan recuerdos personales
en respuestas grupales; se consultan por privado. Contexto por usuario/chat, 7 días.
Los resultados de tools se entregan canónicos, sin otra llamada para estilizar.
Confirmaciones de 2 minutos con acción/hash, actor/chat y versión; aclaraciones de
5 minutos. PDF del ejemplo §9.1 corresponde a Fase 5: se explica que aún no existe.

### DEC-022: Tick independiente y entrega de recordatorios
Inbox/efectos locales/respuesta se mantienen transaccionales. Se separan los bucles
de recepción procesada, tick y outbox para que la latencia de Gemini no detenga los
envíos. El tick reclama y vincula cada vencimiento a una outbox única; solo pasa a
sent tras confirmarse la entrega. Inciertos no se repiten. Recurrencias conservan
hora IANA, saltan fechas mensuales inexistentes y condensan atrasos en una entrega.
Tras entregarla calculan la siguiente ejecución futura. Se revisan módulo, chat,
modo de operación y acceso del propietario antes de encolar. La barrera de grupos
de Fase 0 se conserva: solo Botsky Lab; privados requieren membresía reciente o
aprobación manual. Los módulos nuevos están disponibles en Lab y privados elegibles;
los grupos reales permanecen bloqueados. Desplegar SearXNG se añade al script oficial,
sin tocar Evolution. No se fusiona hasta revisión del arquitecto.

### DEC-023: Corrección de reservas locales tras evidencia de WhatsApp
La auditoría del 16-10-2026 confirmó que el rechazo de las 03:14:10 UTC era local:
32768 × 3 excedía el tope de entrada aun cuando las dos llamadas anteriores solo
sumaban 4046 tokens confirmados. Sustituye esa parte de DEC-019. La migración
`003_llm_reservations.sql` añade `reserved_input_tokens` sin borrar ni reescribir
historial. Solicitudes confirmadas usan `input_tokens`; pendientes, fallidas o sin
metadatos mantienen su reserva. La nueva estimación suma bytes UTF-8 del payload
textual, margen de 512 e importe local de 16384 por imagen; el base64 no cuenta como
texto. Es una estimación local conservadora, no una garantía de tokenización exacta.
Se comprobaron [tokens](https://ai.google.dev/gemini-api/docs/tokens) y
[cuotas](https://ai.google.dev/gemini-api/docs/rate-limits) oficiales: se usa el
consumo devuelto sin añadir otra llamada de conteo. Se mantienen todos los topes y
la serialización transaccional de reservas. Google sigue siendo autoridad sobre
su cuota real; no se rota la clave ni se activa facturación.

Esta decisión sustituye el cálculo TPM por reserva fija de DEC-019; los valores
allí descritos quedan como evidencia del despliegue inicial.

La clasificación diferencia `local_limit`, `quota`, `timeout` y `provider`.
`diag.cuota` muestra topes de Botsky y consumo/reservas del último minuto. Visión
permite 40 s, texto 20 s. Un timeout se registra sin detalles sensibles ni reintento
ciego. La primera foto de esta ronda carece de telemetría suficiente para atribuir
su `network_error` exclusivamente al timeout; así queda documentado.

### DEC-024: Recordatorios sin contenido requieren aclaración propia
La solicitud real «haz un recordatorio para dentro de dos minutos botsky» dio una
fecha válida pero Gemini inventó «Recordatorio automático». `reminders.create`
acepta omitir contenido para pedirlo mediante sesión del actor/chat; nunca se
inserta una fila sin contenido. El atajo para esa solicitud conserva la fecha sin
consumir IA. Una respuesta ajena no completa la sesión. Si vence la fecha mientras
se espera contenido, el siguiente paso pide fecha nueva conservando el contenido.
La aclaración conserva la zona IANA explícita de la operación; no la sustituye
por la zona predeterminada del chat. No se cambian las filas históricas que ya se
crearon/entregaron durante la ronda.

### DEC-025: Citas de imagen verificadas contra el inbox del mismo chat
La pregunta de color real de las 03:14:09 UTC contenía `contextInfo.quotedMessage.imageMessage`
y `stanzaId`, aunque `attachments` del mensaje nuevo estaba vacío. El normalizador
anterior descartaba esa referencia: corregir cuota solo no permitía volver a ver
los píxeles. Se conserva un adjunto citado de tipo imagen, sin URL, bytes ni claves.
La app resuelve el ID citado contra un mensaje previamente aceptado en `inbox`,
filtrando siempre por el chat autenticado y retención de contexto; valida el `Msg`
original y usa el adaptador de imagen existente. El modelo no propone el ID ni el
chat. Una imagen citada desconocida o de otra conversación no se descarga: se pide
reenviar en el chat actual. Se mantiene límite de una imagen y comprobación de
módulo, cuota y permisos. No hay recuperación arbitraria desde el historial global.
Un fixture REST real sanitizado y tres regresiones cubren normalización, reutilización
autorizada y rechazo de citas fuera del ámbito. Es cambio crítico pendiente de revisión.


### DEC-026: Búsqueda completa determinista y referencias con intención conservada
La segunda ronda real (16-10-2026, 03:35–03:36 UTC) mostró dos fallos: el atajo
`busca cuando sale la nueva temporada botsky` enviaba una consulta sin tema y con
la invocación final; la corrección posterior recordaba el personaje, pero buscaba
disfraces y perdía la pregunta del estreno. No era un fallo de cuota o transporte.

Se reconocen por separado consultas completas y búsquedas con referente o tema
faltante. Las completas siguen siendo deterministas, sin consumir Gemini, incluso
cuando invocan al bot al final. Esa limpieza solo afecta la consulta web, no notas
ni otros contenidos exactos. Las contextuales usan el historial ya filtrado por
actor/chat/retención y reciben la búsqueda anterior como dato explícito para
conservar qué información se busca. Si falta antecedente, se pregunta el tema sin
consultar proveedores. No se elige un número de temporada o fecha desde memoria. Si el modelo añade un
número a «temporada/season» que no estaba solicitado y la petición era por una
nueva temporada, el código conserva «nueva temporada/upcoming season» antes de
buscar. Se respetan los números que sí especificó el usuario y no se alteran las
fuentes devueltas. Los argumentos adicionales se conservan para que Zod los rechace,
no se eliminan para volver válida una propuesta con actor/chat inyectados.

Esta interpretación solo ofrece `web.search` cuando está permitida; también se
rechazan por código propuestas de otras tools. Actor/chat/permisos siguen fuera
de los argumentos del modelo y Zod valida la consulta. La respuesta canónica de
fuentes no pasa otra vez por personalidad. Sin llamada a la tool solo se permite
pedir aclaración, no presentar una fecha como resultado de búsqueda. No se añaden
servicios, migraciones ni activaciones. Cambio de router pendiente del arquitecto.

### DEC-027: Utilidad antes de personalidad y contexto visual propio para raza

El dueño aclaró que el tono no sustituye la respuesta: primero contenido útil o
incertidumbre concreta, después burla opcional. Se incorpora a §0 del plan y a
`config/persona.md`. Para visión se exige identificación tentativa apoyada en
rasgos observables, sin afirmar pureza/certeza de raza desde una foto ni inventar
detalles de un meme editado. No se añade otra llamada de IA para estilizar.

La auditoría INC-20261016-07 solo acreditaba continuidad textual: la pregunta sin
cita no llevaba píxeles. Para preguntas breves de raza con referente implícito se
aplica §6.5: adjunto actual, cita explícita o última imagen del mismo remitente y
chat, como máximo diez minutos. Se comprueban recepción y fecha del mensaje;
se excluyen entradas fallidas y fotos futuras. Una cita desconocida no se sustituye
por otra foto reciente. Sin original autorizado se pide reenviar, antes de Gemini.
Preguntas completas con sujeto propio (p. ej. raza de un personaje nombrado) siguen
la ruta textual; no se les adjunta una foto ajena a su petición.

La descarga, permiso, módulo, cuota y timeout siguen en sus adaptadores actuales.
No se cambian APIs, herramientas, sesiones, migraciones, outbox ni dependencias.
Regresiones aisladas comprueban ámbito/retención, precedencia y conservación del
texto con incertidumbre. `npm run eval:phase1 -- /ruta/privada/al/meme-del-pug.jpg`
ejecuta además una evaluación explícita con Gemini y SearXNG reales, base aislada
y cero envíos: descripción útil, raza tentativa antes de la burla, una pregunta
aritmética y las dos búsquedas contextuales. La evaluación exige ese meme ya
revisado; no es un identificador universal de razas ni garantía de cada salida
futura del modelo. La confirmación manual en Lab quedó pendiente; posteriormente
el dueño omitió la secuencia propuesta, según DEC-029.

### DEC-028: Conservar una petición segura aunque se filtre el resultado web

La evaluación real de DEC-027 descubrió que la segunda búsqueda perdía el objetivo
aunque la primera consulta fuera correcta. `sensitiveMemory` reconoce como posible
secreto una cadena larga de caracteres, incluyendo rutas de URL públicas. Antes,
`rememberContext` descartaba tanto la respuesta como la pregunta; por eso faltaba
`previousSearchRequest` en el siguiente turno. Las pruebas anteriores sembraban esa
petición y no ejercitaban su persistencia tras recibir fuentes reales.

Se conserva la petición solo si pasa el filtro actual. La respuesta se guarda solo
si también pasa; una petición sensible sigue excluyendo el turno completo. No se
relaja el filtro ni se guardan enlaces rechazados. La secuencia se prueba ahora
pasando por `rememberContext`, no sembrando la búsqueda anterior. El historial
puede tener mensajes consecutivos del usuario: al formar `contents` se agrupan en
partes del mismo turno para conservar la alternancia `user`/`model` indicada en la
[documentación oficial de texto](https://ai.google.dev/gemini-api/docs/generate-content/text-generation).
No se fabrican respuestas del modelo para rellenar huecos. El actor/chat y la
retención siguen filtrados por el programa. Sin cambios a permisos, tools o outbox;
cambio de router pendiente de revisión arquitectónica antes de cualquier merge.

### DEC-029: Omisión de la última secuencia manual por instrucción del dueño

El 16-10-2026 el dueño indicó omitir los cinco pasos manuales propuestos tras
DEC-027/028. Se deja de esperar esos mensajes y se pasa a revisión del arquitecto.
Su estado es **omitidos, sin ejecución física confirmada**; no se fabrican respuestas
de WhatsApp ni se marcan aprobados. Se conserva la evidencia existente: 153 tests,
typecheck/lint/build, integraciones reales aisladas y despliegue con health HTTP 200.
La omisión se limita a esta secuencia; no aprueba otros pendientes, no sustituye la
revisión del arquitecto y no autoriza merge a `main`, Fase 2 ni activaciones nuevas.

### DEC-030: Evidencia automática e integración suficientes para el cierre de Fase 1

**Decisión expresa del dueño, 16-10-2026.** Las validaciones automáticas y de
integración existentes se consideran suficientes para cerrar Fase 1. El dueño
decidió no realizar las pruebas físicas adicionales pendientes en Botsky Lab,
incluidas raza/contexto visual, búsqueda contextual de temporada y recordatorio
con reinicio físico. Se omiten voluntariamente y dejan de ser condiciones de cierre.

Esta decisión amplía DEC-029 a todas las pruebas manuales pendientes de Fase 1 y
sustituye su limitación a la última secuencia de cinco pasos. Se incorpora también
a §0 del Plan Maestro para que no quede una exigencia documental contradictoria.
La fase queda **lista para cierre** con la evidencia documentada. No se presentan
pruebas físicas omitidas como ejecutadas ni se alteran resultados históricos.

La omisión **no elimina ni reduce la cobertura automática o de integración**:
se conservan tests, fixtures, evaluaciones y evidencias. La prueba de reinicio con
SIGKILL sobre un proceso real y transporte simulado, junto con las integraciones
reales de Gemini/SearXNG, mantienen su alcance técnico documentado. Los fallos de
disponibilidad externa ya observados siguen registrados.

Solo cambia el criterio documental de aceptación de Fase 1. La revisión del
arquitecto previa al merge sigue vigente; no se autoriza fusionar a `main`, iniciar
Fase 2 ni activar módulos en grupos reales.

## 5. Decisiones de Fase 2 (aprobadas por el arquitecto sin correcciones de código)

### DEC-031: Inicio autorizado de Escuela y límites operativos

El dueño declara Fases 0/1 cerradas y fusionadas, con `main=28b252d`, y autoriza
únicamente Fase 2 en una rama nueva, sin merge ni Fase 3. Esa instrucción directa
prevalece sobre los estados históricos de DEC-029/030 y ROADMAP. Se trabaja en
`phase-2-escuela`, un solo constructor. No se cambian las reglas de identidad ni
se habilitan grupos reales: la barrera existente de inbox/transporte sigue en Lab.
Escuela solo opera en grupos; queda apagada en privados y por defecto fuera de Lab.
El resumen queda apagado incluso en Lab hasta configurarlo explícitamente.

Se añaden checks de membresía vigente a permisos school y a la ayuda; al ejecutar
se vuelve a verificar membresía/administración en el chat. Las entregas programadas
y los originales en cola comprueban otra vez la autorización antes de enviarse.
El destino es configurable desde comando determinista; Gemini no recibe ese ID.
Por la barrera de producción vigente, actualmente solo se acepta Botsky Lab como
destino. Abrir otros grupos exige la aprobación del dueño y el trabajo explícito
para retirar la barrera anterior, no una activación implícita de esta fase.

### DEC-032: Horario como propuesta validada y confirmación versionada

Migración aditiva `004_school.sql`, sin modificar tablas/datos de Fases 0/1.
Schemas Zod estrictos para materias, horario, fechas y configuración. Horario semanal
CDMX, días 1–7, horas HH:mm, fin posterior al inicio, sin duplicados/superposiciones.
No se inventan periodos escolares ni festivos. Fechas de tareas UTC; sin fecha se
calcula la siguiente clase real del horario semanal o se conserva NULL.

Toda carga/corrección de horario propone un reemplazo semanal completo. El preview
incluye todas las clases y explica el reemplazo; materias/tareas previas se conservan.
`school_imports` guarda el borrador, hash y revisión base, sin crear materias/clases.
Solo «sí» del actor/chat autorizado, dentro de dos minutos y con sesión consumida,
permite el commit interno (no invocable por el modelo). Se comprueban hash del
preview, versión de configuración y permisos otra vez; un cambio concurrente pide
una propuesta nueva. Cancelación, caducidad, manipulación o replay no guardan clases.

La importación determinista hace una llamada de visión usando el adaptador/cuota
de Fase 1, una única función de extracción y ningún efecto de Gemini. Los datos son
propuesta, también si parecen plausibles. Se consultaron de nuevo [visión](https://ai.google.dev/gemini-api/docs/image-understanding),
[function calling](https://ai.google.dev/gemini-api/docs/function-calling) y
[precios](https://ai.google.dev/gemini-api/docs/pricing). Se conserva modelo y
confirmación local de nivel gratuito existentes; sin nuevas claves ni facturación.

### DEC-033: Originales escolares acotados, tareas y recuperación de resúmenes

Una tarea por mensaje de alta, UNIQUE(chat,autor canónico,mensaje); el backend
atribuye autor y adjuntos. Cualquier miembro vigente crea/consulta y edita sus
propias tareas. Solo owner/admin borra (lógico, confirmado), edita tareas ajenas,
administra materias/horario/configuración. Desactivar una materia conserva tareas.

En esta fase se conservan originales de **imagen o PDF**, uno por tarea, máximo
4 MB y siete días. No hay conversión/OCR/PDF ni otras herramientas de Fase 5.
Bytes en `school_attachments.data` de la base propia, cubiertos por el backup
existente; no se añaden volúmenes ni servicios. El tick vacía únicamente bytes
caducados, manteniendo metadatos y tareas. Los backups existentes pueden contener
esos bytes hasta su propia retención (pendiente externa heredada de Fase 0).
Resolución: archivo actual, cita validada del mismo chat, o archivo propio reciente
(10 minutos) cuando se solicita adjunto; sin selección de IDs/URLs desde Gemini.
Una cita puede señalar un original compartido de otro miembro del mismo grupo;
su propietario se resuelve con evidencia del backend, separado del autor de tarea.

La entrega de originales usa una referencia de ámbito en outbox, nunca base64 en
el payload persistido. Se verificó en solo lectura el código instalado de Evolution
2.3.7: `getBase64FromMediaMessage`, router `sendMedia`, esquema y HTTP 201.
El [esquema oficial de esa versión](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/validate/message.schema.ts)
confirma media/base64, MIME, mediatype y cita. No se modificó Evolution. Un timeout
sin ID confirmado queda incierto: una coincidencia de caption no prueba entrega
del archivo y no autoriza un reenvío ciego. La entrega física de archivo queda
pendiente de prueba manual; el contrato HTTP se comprueba con proveedor simulado.

`automations` implementa exclusivamente school_summary, con días/hora CDMX, actor
configurador, destino y próximo vencimiento persistidos. Reclamo + outbox se hacen
en la misma transacción con lock y clave única por ejecución. Solo tras entrega
sent o fallo definitivo avanza a la siguiente fecha futura; uncertain no se repite.
Varios días perdidos se condensan en un resumen con retraso explícito. Conserva
la entrega ya en curso al reconfigurar, evitando duplicación. Desactivar el resumen,
revocar permisos o apagar el módulo impide entregas escolares aún no iniciadas.
No se añaden avisos individuales automáticos por cada tarea: el alcance es resumen
programado; recordatorios personales siguen en su módulo de Fase 1.

### DEC-034: Evidencia suficiente y pruebas físicas opcionales para cerrar Fase 2

**Decisión expresa del dueño, 16-10-2026.** El arquitecto aprobó Fase 2 — Escuela
sin correcciones de código. La evidencia automática, de integración y la auditoría
arquitectónica se consideran suficientes para cerrar la fase, que queda **lista
para cierre**.

El dueño decide no realizar como condición de cierre la importación de horario
con foto real, la entrega física de un adjunto PDF/imagen ni la recepción real del
resumen escolar programado. Estas tres pruebas pasan a ser **opcionales y no
bloqueantes**; permanecen no ejecutadas, sin afirmar éxito físico ni sustituir su
alcance por el de un proveedor simulado. La lista de WhatsApp queda disponible
como referencia para validaciones voluntarias en Botsky Lab.

Esta instrucción directa prevalece sobre las exigencias documentales anteriores
de evidencia física para el cierre de Fase 2, incluidas las de DEC-033. **No se
eliminan tests automáticos, integraciones ni cobertura existente**: se conservan
tests, fixtures, evaluaciones y evidencias, con sus límites documentados.

Solo cambia el criterio documental de aceptación. No se modifica código funcional
ni se activan módulos en grupos reales. Se autoriza commit y push exclusivamente
a `phase-2-escuela`; no se fusiona a `main` ni se inicia Fase 3. Tras registrar las
verificaciones solicitadas, el agente se detiene.

## 6. Decisiones de Fase 3 (aprobadas por el arquitecto sin correcciones de código)

### DEC-035: Alcance autorizado y economía global

El dueño declara Fases 0–2 cerradas y fusionadas en `6566f21` y autoriza únicamente
Fase 3 en `phase-3-economia-juegos`, sin merge ni Fase 4. Prevalece sobre estados
históricos de roadmap/DEC-034. Se conserva la barrera exclusiva de Botsky Lab.
Se implementan §7, §8.1–8.3 y moderación mínima de §9.10. Hora Feliz sí pertenece
a esta fase; cooperacha/packs y nuclear pertenecen a Fases 6 y 7 respectivamente.
La cartera es global por usuario, como exige §7; el aislamiento por chat se aplica
a partidas, actividad, warns, consecuencias y configuración. No se crea una segunda
interpretación económica. Saldo actual determina nivel; Gemini no decide efectos.

### DEC-036: Transacciones, reglas y límites de operación

Migración aditiva `005_economy_games.sql`; sin tablas destruidas ni dependencias
nuevas. Cartera global bloqueada con `FOR UPDATE`; ledger con referencia única,
constraint no negativo, y todas las reservas/pagos/devoluciones en la transacción
que cambia la partida. El inbox toma lock de chat y bloquea en orden las carteras
de sus participantes antes de actividad/atajos; así una recompensa pasiva no invierte
el orden de locks al liquidar una mesa. El tick usa lock de chat no bloqueante y
carteras NOWAIT para no detener recordatorios por una conversación larga.
Un lock no disponible pospone la partida al siguiente tick; no mueve XP parcialmente.

Atajos de economía/juegos no son invocables por Gemini. Apuesta validada, actor/chat
inyectados, mazo Fisher–Yates y azar `crypto.randomInt`; resultados económicos exactos.
El nivel se calcula al consultar, nunca se almacena como XP histórico. Diario global
cada 24 h, racha hasta 48 h y bono hasta 100 XP solo sobre premio positivo. Actividad
usa referencias de chat/mensaje y cooldown por usuario/chat. Configuración `phase3-v1`
registrada en partidas y ledger. Plazos persistidos, partidas versionadas y acciones
idempotentes por chat/actor/mensaje. Las sesiones `game` continúan solo entradas
previstas; su vencimiento lo resuelve la partida, para no perder el siguiente turno.
Cancelar un lobby devuelve reservas; una partida ya iniciada termina por juego/plazo.

Donde §8.3 no fija política de creación, se adopta airdrop manual owner/admin,
60 segundos y máximo uno por hora/grupo, 500 XP fijos y sin pack. Se evita que
cualquier miembro pueda emitir XP sin límite. Valores en `config/product.ts`.
En esta fase las tools económicas/juegos/moderación se ofrecen en grupos; blackjack
individual se juega también en el grupo. Sin servicios/costos nuevos.

### DEC-037: Ruleta, evidencia externa y obligación de restitución

Consecuencias apagadas hasta orden owner/admin (`bot ruleta consecuencias on`).
Se comprueba administración del bot al abrir mediante roster real en Evolution;
si falla se anuncia partida sin consecuencias. Antes de aplicar un warn automático
se exige prueba de que el anuncio inicial con las condiciones llegó (`outbox.sent`).
No se aplica una consecuencia cuyo anuncio quedó pendiente/incierto.

Se verificaron las rutas, schemas y el código instalado de Evolution **2.3.7**:
[router oficial](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/routes/group.router.ts),
[schema oficial](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/validate/group.schema.ts)
y [servicio Baileys](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts).
`GET group/findGroupInfos`, `POST group/updateParticipant` con action remove y un
solo participante, y `GET group/inviteCode`. HTTP 201 por sí solo no prueba expulsión.
Consulta real de solo lectura confirmó Lab, bot/owner admins y contrato válido de
invitación. El enlace no se imprime, publica ni versiona. No se hizo expulsión real.

Una sola obligación de expulsión sin resolver por persona/grupo. Se revisan warns,
configuración y roster antes de escribir. Owner/admin/bot e identidad no verificable
quedan protegidos. Se persiste `sending` ANTES del efecto y se confirma con ausencia
en roster posterior. Se reinician warns y se crea reinvitación en una transacción.
El castigo se cuenta desde el intento persistido, 15 minutos por defecto, configurable
1–1440. Un intento ambiguo y participante presente pasa a `review`, sin segunda
expulsión ciega. Rate limit inequívoco se reintenta con pausa, máximo tres intentos;
fallos/ambigüedad conservan evidencia y avisan al owner. Quitar warns puede revocar
un castigo aún no iniciado; los warns manuales nunca disparan expulsión por sí solos.

La obligación de reingreso es independiente de la autoaprobación privada perdida al
salir y sigue vigente aunque después se apague el módulo. Obtiene enlace válido al
vencer, encola una entrega privada única y solo queda `done` tras `outbox.sent`.
Fallo o incertidumbre agotada quedan `review` y avisan al owner; no se afirma envío.
No se fuerza la incorporación del usuario: se facilita el enlace según §8.2.
Obligaciones tienen bucle propio para que la latencia de Evolution no bloquee
recordatorios. Emergencia/mantenimiento suspenden nuevos efectos; no borran deudas.

### DEC-038: Aprobación arquitectónica y cierre técnico de Fase 3

**Confirmación e instrucción expresa del dueño, 16-10-2026.** La auditoría
arquitectónica de Fase 3 — Economía y Juegos fue **aprobada, sin correcciones de
código requeridas**. La fase queda **aprobada y lista para cierre técnico**.

La evidencia automática y de integración existente se considera suficiente para
cerrar técnicamente la fase. La prueba física de expulsión, recepción privada del
enlace y reingreso en Botsky Lab es **recomendable, opcional y no bloqueante**.
Las pruebas físicas permanecen sin ejecución confirmada; no se presentan como
realizadas ni como evidencia de un efecto externo. Se conserva su lista como
referencia para validación voluntaria.

**No se eliminan tests, fixtures ni cobertura automática o de integración.** Se
mantienen las 318 pruebas existentes, incluidas las 206 regresiones originales y
las 112 nuevas de Fase 3. Solo cambia el criterio documental de aceptación; no se
modifica código funcional ni se requiere un nuevo despliegue.

Esta instrucción directa prevalece sobre los pendientes anteriores de revisión o
prueba física como condición de cierre de Fase 3. No altera las reglas económicas,
permisos, idempotencia, inmunidad de owner/admin ni la obligación de reingreso.
Se autoriza exclusivamente documentación de control, verificaciones y commit/push
a `phase-3-economia-juegos`. **No se autoriza merge a `main`, inicio de Fase 4 ni
activación de módulos fuera de Lab.** Al finalizar, el constructor se detiene sin
esperar acciones físicas del dueño.
