# Botsky — Registro de Decisiones Técnicas y Arquitectónicas

**Archivo:** `docs/DECISIONES.md`  
**Última actualización:** 17 de octubre de 2026
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

## 7. Decisiones de Fase 4 (aprobadas por el arquitecto sin correcciones de código)

### DEC-039: Inicio autorizado, acceso remoto restringido y alcance de Minecraft

El dueño confirma Fases 0–3 cerradas/fusionadas, base `27572701d231ff17fa5fba886bd82880b92fe91f`,
y autoriza exclusivamente Fase 4 en rama nueva, sin merge ni Fase 5. Supera los
bloqueos históricos de DEC-038 dentro de ese alcance. Un constructor en
`phase-4-minecraft`; continúa la barrera de Lab sin activar grupos reales.

Inspección confirma redspi `100.104.54.2`, contenedor `mc-bedrock`, imagen itzg y
volumen bind remoto. No se usa la carpeta residual de miroslav. La red bridge actual
alcanza SSH, sin host networking/sidecar. Cuenta botsky-mc sin grupo docker, llave
dedicada, pin de host previamente verificado, restrict/ForceCommand y origen IP
limitado. Sudo únicamente al gateway root-owned validado. La AllowUsers existente
exigió agregar esa cuenta/origen; se conservó petrov y se validó sshd antes del reload.
Miembros vigentes: estado/jugadores; demás infraestructura solo owner. Stop/restart
usan confirmación existente. Administración determinista, sin argumentos SSH del modelo.
Inventario de mundos/addons sin inventar instalación/borrado no especificados.

### DEC-040: Cola durable, recibos remotos e incertidumbre sin replay

Migración aditiva 006; commit queued/sending y auditoría antes del efecto; lock e
índice parcial global evitan escrituras concurrentes. UUID/actor/chat/mensaje y
recibos remotos con hash y fsync previos al efecto impiden doble ejecución.
Un bucle dedicado despacha; no comparte la espera de backups con el tick/outbox.
Timeout/error SSH/protocolo inesperado o reinicio durante sending quedan review,
sin reintentar; queued sobrevive y vuelve a comprobar permisos. Review bloquea
nuevas escrituras hasta resolución técnica auditada por evidencia, nunca por IA.
Resultados a outbox con referencia única; consultas también auditadas sin copiar
contenido sensible de logs/configuración. La implementación no cambia ToolCtx,
router, sesiones, dedupe u outbox; añade registro/atajos y permiso de lectura
Minecraft con membresía vigente. Evidencia y procedimiento en FASE-4.md.

### DEC-041: Backups offline verificables y configuración sin éxito optimista

El manual de Bedrock instalado confirma que un respaldo vivo requiere hold/query,
lista exacta y truncado, no una copia ordinaria de LevelDB. Se implementa backup
solo con servidor ya detenido; si está activo devuelve no realizado y no lo para
implícitamente. Lock exclusivo, rechazo de enlaces, espacio, artefacto parcial,
lectura completa de tar y SHA-256. Todo se ejecuta en redspi; no se añaden servicios
ni costos, no se borran copias y no se afirma restauración probada. Soporte online y
restauración física aislada no se declaran realizados. Es un límite operativo
explícito dentro de la capacidad de backup, no una copia insegura de datos activos.

Propiedades permitidas con valores enumerados; si env del contenedor domina la
clave, se rechaza. Cambios admitidos tienen copia previa, reemplazo atómico y
lectura de verificación, con aviso de reinicio separado. Start/stop/restart se
confirman con estado posterior; consola solo confirma aceptación/salida observada.

### DEC-042: Aprobación arquitectónica y cierre técnico de Fase 4

**Confirmación e instrucción expresa del dueño, 16-10-2026.** La auditoría
arquitectónica de Fase 4 — Minecraft fue **aprobada, sin correcciones de código
requeridas**. La fase queda **aprobada y lista para cierre técnico**.

La evidencia automática, la integración SSH real de solo lectura y la auditoría
existente se consideran suficientes para el cierre técnico. Las pruebas físicas
de **start/stop/restart, backup real y restauración aislada** son **recomendables
pero NO bloqueantes**. Los mensajes `bot mc estado` y `bot mc jugadores` quedan
como **validaciones operativas opcionales**. Se conserva la secuencia de pruebas
para una eventual ventana coordinada en Botsky Lab.

Estas pruebas físicas permanecen **sin ejecución confirmada**; no se presentan
como realizadas ni se atribuyen efectos externos a simulaciones. La inspección SSH
real existente conserva su alcance de solo lectura. La aprobación no transforma
esa evidencia en una prueba física de control, backup o restauración.

**No se eliminan tests, fixtures ni cobertura automática o de integración.** Se
conservan las 360 pruebas existentes (318 regresiones anteriores y 42 de Fase 4),
los 14 casos Python del wrapper y todas las evidencias ya documentadas. Se vuelven
a ejecutar las verificaciones solicitadas sin cambiar código funcional.

Esta instrucción directa prevalece sobre los pendientes anteriores de revisión o
prueba física como condición de cierre técnico de Fase 4. No modifica permisos,
confirmaciones, controles SSH, auditoría, idempotencia ni los límites de backup
con servidor detenido y de revisión de resultados inciertos.

Se autoriza exclusivamente documentación de control, verificaciones y commit/push
a `phase-4-minecraft`. **No se autoriza merge a `main`, inicio de Fase 5 ni
activación de módulos fuera de Lab.** No se requiere nuevo despliegue. Al terminar,
el constructor se detiene sin esperar acciones físicas del dueño.

## 8. Decisiones de Fase 5 (aprobadas por el arquitecto sin correcciones de código ni configuración)

### DEC-043: Inicio autorizado, fuente abierta comprobada y límites conservadores

El dueño declara Fases 0–4 cerradas y fusionadas, base
`afe4b84a853308c02c7e52e650d15b00310083cc`, y autoriza solo Fase 5, sin merge ni
Fases 6/7. Un constructor, rama `phase-5-multimedia-documentos`; sigue la barrera
Lab, sin activaciones en grupos reales. Supera las prohibiciones históricas de
DEC-042 únicamente dentro de ese alcance.

Se habilita inicialmente Wikimedia Commons: API de búsqueda audio/video y archivos
originales de upload.wikimedia.org con ruta cerrada. Verificadas búsquedas reales
y descarga de `File:En-us-hello.ogg`, 9036 bytes, desde el VPS sin cookies/cuentas.
No se necesita yt-dlp para esta fuente directa, ni se instala un extractor genérico.
YouTube permanece excluido. Las páginas del archivo permiten consultar autor y
licencia; se atribuye cada descarga a su página. Otras plataformas no se prometen.

Se revisaron el [schema oficial Evolution 2.3.7](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/validate/message.schema.ts)
y [main de esa versión](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/main.ts):
mediatype image/document/video/audio, sendSticker separado y JSON hasta 136 MB.
Son límites del servidor REST, no garantía de WhatsApp. La referencia de
[medios WhatsApp](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media/)
se toma solo como referencia conservadora, no como API instalada. Se fijan máximos
locales inferiores: 8 MB total por entrada/salida, 4 MB imagen/video, 100 KB sticker
estático y 500 KB animado. La entrega física queda pendiente, sin atribuir validez
a un mero HTTP del mock. Sin Drive ni alternativa que amplíe el ámbito de entrega.

### DEC-044: Cola durable, artefactos en BD y aislamiento de procesadores

Migración aditiva 007: ampliación del enum de sesiones, referencias únicas de jobs
y `media_attachments` con ámbito chat/actor, hash y expiración. No borra datos.
Dos activos por actor globalmente, veinte en cola global, worker único SKIP LOCKED.
Originales 7 días, generados 2 (§0); bytes en PostgreSQL propio y por tanto cubiertos
por el respaldo existente. Tope 256 MB de artefactos retenidos; limpieza idempotente
vacía bytes caducados y conserva metadatos. No se añaden volúmenes con originales
fuera del backup. Backups mantienen su política heredada, sin fingir copia externa.

Conversiones en imagen separada del worker (ARM64): ffmpeg, Pillow, Tesseract,
Poppler, pypdf, LibreOffice, zbar y Piper. App mantiene imagen ligera. Deploy oficial
construye y fija por ID inmutable ambas imágenes; rollback conserva ambas y la BD.
Worker 768 MiB/0.50 CPU, 64 PIDs, tmpfs 256 MiB. Procesadores sin entorno de servicios,
con nice, rlimits, timeout y grupo de procesos terminable; seccomp bloquea sockets
IP también en sus descendientes y conserva solo IPC local. Fallo al instalar el
filtro impide procesar. Sin shell, argumentos libres ni rutas del modelo/usuario.

Se verificaron [protocolos ffmpeg](https://ffmpeg.org/ffmpeg-protocols.html),
[Piper CLI](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/CLI.md),
[voz ald es_MX](https://huggingface.co/rhasspy/piper-voices/blob/main/es/es_MX/ald/medium/MODEL_CARD),
[API MediaWiki](https://www.mediawiki.org/wiki/API:Imageinfo) y
[límites Compose](https://docs.docker.com/reference/compose-file/services/).
Piper 1.8.0 tiene wheel ARM64; ald-medium declara dataset Unlicense. Síntesis local
real comprobada en contenedor sin red; la escucha/calidad física queda pendiente.
No se usa TTS Gemini ni nuevos proveedores. Transcripción reutiliza Gemini/cuota
existentes, sin ofrecer tools al audio y con resumen opcional separado.

### DEC-045: Entrega verificable, reinicios y documentos no ejecutables

El job guarda resultado + outbox en una transacción; `done` solo significa procesado.
La consulta distingue pendiente, incierta, fallida y confirmada por proveedor.
Reinicios recuperan running hasta tres intentos totales, sin repetir jobs terminados
ni entregas inciertas. El outbox conserva la reconciliación conservadora anterior.
Se revalidan permisos/módulo/emergencia antes de procesar y entregar. Referencias
a archivos recibidos vienen de inbox aceptado, nunca de Gemini; citas a generados
requieren artefacto vigente del mismo chat/actor y envío confirmado.

Office admite DOCX/XLSX/PPTX, inspecciona ZIP acotado sin extraer, rechaza macros,
embebidos, referencias externas y rutas peligrosas; LibreOffice usa perfil aislado.
PDF rechaza scripts/acciones ejecutables/embebidos. Una prueba real mostró que
LibreOffice escribe OpenAction con destino inicial pasivo de página/zoom: se admite
solo esa forma de array cerrada. Un diccionario de acción sigue rechazado. No se
relaja ejecución de contenido y seccomp continúa bloqueando red. La revisión
arquitectónica fue aprobada sin correcciones de código ni configuración (DEC-046).


### DEC-046: Aprobación arquitectónica y cierre técnico de Fase 5

**Confirmación e instrucción expresa del dueño, 16-10-2026.** La auditoría
arquitectónica de Fase 5 — Multimedia y Documentos fue **aprobada, sin correcciones
de código ni configuración requeridas**. La fase queda **aprobada y lista para
cierre técnico**.

La evidencia automática, los procesadores reales, el worker, Gemini y la
integración existente se consideran suficientes para el cierre técnico.
**Ninguna prueba física pendiente es bloqueante para ese cierre**. Las pruebas de
**Piper/voz, sticker nativo y QR extremo a extremo** quedan **recomendables antes
de activar Multimedia fuera de Botsky Lab**. Se mantiene la secuencia de Lab para
validaciones voluntarias; no se espera su ejecución para terminar esta tarea.

Las pruebas físicas pendientes permanecen **sin ejecución confirmada**. No se
presentan como realizadas ni se confunde el transporte simulado con recepción
WhatsApp, escucha de la voz o lectura física de un QR.

**No se eliminan tests, fixtures ni cobertura automática o de integración.** Se
conservan las 445 pruebas existentes (360 regresiones anteriores y 85 de Fase 5),
las 82 comprobaciones multimedia, los 17 casos de procesadores reales, los 14 del
wrapper Minecraft y la evidencia de worker/Gemini. Se vuelven a ejecutar las
verificaciones solicitadas sin cambiar sus implementaciones ni la configuración.

Esta instrucción directa prevalece sobre los pendientes anteriores de revisión o
prueba física como condición de cierre técnico de Fase 5. No modifica fuentes,
formatos, límites, retención, permisos, aislamiento, idempotencia ni reconciliación.
Se conserva el despliegue existente desde `7675380`, sin activar grupos reales.

Se autoriza exclusivamente documentación de control, verificaciones existentes y
commit/push a `phase-5-multimedia-documentos`. **No se autoriza merge a `main`,
inicio de Fase 6/7, cambios funcionales o de configuración ni un nuevo despliegue**.
El constructor se detiene al terminar, sin esperar pruebas físicas del dueño.

## 9. Decisiones de Fase 6 (aprobadas; véase DEC-050)

### DEC-047: Alcance autorizado y biblioteca persistente local con Drive readonly

El dueño confirma Fases 0–5 cerradas/fusionadas, base `03cffae779407102a030f95ecf759bdfaeda0438`,
y autoriza únicamente Fase 6 en `phase-6-biblioteca-packs-cooperacha`, sin merge,
Fase 7 ni activaciones fuera de Lab. Esa instrucción supera los bloqueos históricos
de DEC-046/ROADMAP solo dentro de ese alcance. Un constructor, sin delegación.

Se mantiene rclone, Drive fuente opcional y copia de servicio en PostgreSQL del
VPS, separada de multimedia temporal y cubierta por backup. Límite 128 MB de bytes
persistentes históricos, 4 MB/archivo y 500 archivos/snapshot. Identidad por
fuente/ruta, bytes deduplicados por SHA-256, categorías del primer subdirectorio.
Discovery por descriptores fijados/O_NOFOLLOW, sin enlaces/hard links/especiales,
con firma/tamaño/hash y publicación transaccional. No hay categorías de producto
hardcodeadas ni rutas elegidas por modelos/miembros.

`rclone copy` solo Drive → staging, scope `drive.readonly`, remoto fijo y raíz
explícita en configuración local 600. Sin sincronización bidireccional ni borrados
remotos; el plan describe Drive como fuente, no exige escribirlo. Shortcuts omitidos,
execFile/arrays, ambiente mínimo, límites y lock PostgreSQL durante copia. El worker
publica solo snapshots completos; error/timeout deja vigente la copia anterior.
OAuth del dueño y contenido real permanecen pendientes si no existen localmente;
no se requiere ni solicita un secreto en el chat. Detalles y referencias oficiales
en FASE-6.md. La rotación/copia externa de backups heredada sigue pendiente.

### DEC-048: Reservas de packs, outbox y liquidación conservadora

Migración aditiva 008 con ocho tablas propias y ampliación aislada de automations.
Se conservan precios/cantidades de §9.9 y XP de Fase 3. Actor, origen, Hora Feliz,
precio, selección y destino se resuelven en backend; solo la consulta de categorías
se ofrece a Gemini. Herramientas de compra/aporte/administración deterministas.
Verificar bytes y privado autorizado precede al débito. Reserva/pedido/snapshot/
outbox se guardan en una transacción; índices y ledger impiden dobles efectos.

Las reservas referencian copias inmutables ya verificadas: retirar el archivo de
origen no rompe ni sustituye una compra reservada. No caducan a los 2/7 días de
multimedia. Release vuelve a bloquear/leer el pedido, destinatario privado para
compra/airdrop y grupal para cooperacha/lluvia, outbox única por posición.
Solo todos sent confirman. Todos fallidos sin entrega: refund total idempotente.
Cualquier incierto/parcial: pending_review, reserva retenida, detención de archivos
restantes y aviso al owner; no reenvío/refund ciegos. No se crea una herramienta
para declarar evidencia falsa al resolver manualmente un caso pendiente.

### DEC-049: Cooperacha, lluvia y pack reservado del airdrop

Una cooperacha abierta por grupo, 500 XP/10 minutos, meta 50–50.000, recompensa
pack reservada antes de abrir. Lock del chat y carteras estables; se acepta solo
el restante. Dos finalizadores se serializan: el segundo cubre lo restante o no
es debitado si ya se completó. Una sola transición consume aportes a comunidad y
libera el pack al grupo. Cancelación administrativa devuelve 100 %. Vencimiento
aplica floor(80 %) **por aportación registrada**, anunciado antes de aportar;
restos a comunidad. Registro por contribución y replay ligado a chat/actor/mensaje,
incluso entre actividades; cancelación antigua tampoco afecta una actividad nueva.
Reinicio/locks ocupados retoman sin perder fondos ni duplicar devolución/release.

Lluvia expresa owner/admin con días/hora CDMX y 1–3 archivos. Como máximo una
publicación por hora aun al reconfigurar; más de 30 s de atraso se omite. Escuela
filtra su tipo de automation para no modificar la lluvia. Airdrop conserva XP,
plazo/cooldown/ganador único; ahora reserva pack antes de abrir y lo entrega por
privado al ganador en la transacción de reclamo. Sin biblioteca disponible no se
abre prometiendo un pack inexistente; al vencer cancela su reserva.

Cambios críticos de outbox, locks económicos, airdrop y biblioteca sometidos a
revisión del arquitecto, aprobada en DEC-050. No se modifica el contrato Tool,
router de conversación, identidad/@lid, llaves/servicios Minecraft ni Evolution.

Evidencia final del constructor: código 46aeb3a desplegado mediante script oficial,
respaldo verificado, 008 aplicada y health HTTP 200. 548/548 pruebas, multimedia
82/82, procesadores reales 17/17 sobre imagen desplegada, wrapper 14/14 y rclone
real (flags/timeout, sin red). Evolution conserva imagen/arranque y datos previos.
Catálogo vacío, sin OAuth y Drive deshabilitado; cero grupos fuera de Lab.
Al entregar la implementación quedaron pendientes configuración/pruebas físicas y
revisión arquitectónica. La aprobación posterior se registra en DEC-050; no se
atribuye sincronización Drive real. Sin merge ni Fase 7.

### DEC-050: Aprobación arquitectónica de Fase 6 y cierre técnico sin bloqueo operativo

El 16-10-2026 el dueño comunica que **la auditoría arquitectónica de Fase 6 —
Biblioteca / Packs / Cooperacha fue aprobada**. No se requieren correcciones de
código, migraciones, scripts ni configuración. Fase 6 queda **aprobada y lista para
cierre técnico**, con DEC-047–049 y evidencia en FASE-6.md/FASE-6-PRUEBAS.md.

**Contenido autorizado, OAuth/rclone y pruebas físicas no bloquean el cierre
técnico.** Cargar contenido real autorizado es necesario antes de probar o activar
Biblioteca fuera de Botsky Lab. **OAuth/Drive es opcional**: la biblioteca local
puede funcionar sin él. Las pruebas físicas permanecen pendientes y son necesarias
solo antes de activar el módulo fuera de Lab, con autorización expresa del dueño.
No se afirma que esas pruebas ni una sincronización Drive real se hayan realizado.

La instrucción directa actual prevalece sobre pendientes de revisión o prueba
física como condición de cierre técnico de esta fase. **No se eliminan tests ni
cobertura**: se conservan las 445 regresiones y 103 pruebas nuevas, además de las
verificaciones multimedia, procesadores reales y wrapper Minecraft.

Se autoriza únicamente actualizar documentación de control, repetir typecheck,
lint, tests, build, multimedia, procesadores reales, wrapper Minecraft y `/health`,
y hacer commit/push a `phase-6-biblioteca-packs-cooperacha`. Se mantiene el código
desplegado desde `46aeb3a`, sin cambios funcionales/configuración ni nuevo despliegue.
**Sin merge a `main`, Fase 7 ni activación fuera de Lab**. El constructor se detiene
al terminar, sin esperar contenido, secretos, OAuth ni mensajes físicos del dueño.

## 10. Decisiones de Fase 7 (aprobadas; véase DEC-054)

### DEC-051: Alcance autorizado, destinos y confirmación masiva

El dueño confirma Fases 0–6 cerradas/fusionadas y base
`ffc30aa3e210363a8d565defd28901d0639a80f8`. Autoriza exclusivamente Fase 7 en
`phase-7-mensajeria-difusion-nuclear-drive`, sin merge, Fase 8 ni activación fuera
de Lab. Prevalece sobre bloqueos históricos de DEC-050/ROADMAP. Un constructor.

§3 Fase 7, §9.8/9.10: envíos a contactos/chats, difusión, Nuclear y archivos Drive.
No se añade programación genérica: los horarios de Escuela/lluvia de §9.12 ya
pertenecen a Fases 2/6 y conservan sus reglas CDMX/catch-up. Sin moderación avanzada,
encuestas, lore ni reacciones. Las operaciones entre chats y masivas son owner-only;
el modelo no recibe herramientas de mensajería/Drive ni elige identidades.

Los destinos se descubren de chats permitidos y privados ya aprobados por backend,
con referencias locales `dN`. No hay JIDs libres en argumentos. Preview completa,
hash canónico de contenido/destinos/cantidad/ritmo/versión, sesión existente ligada
a actor/chat y vencimiento de dos minutos. Confirmar consume esa sesión y crea un
único job/objetivos; replay y concurrencia no añaden una segunda ejecución.
Migración aditiva 009 con cinco tablas nuevas; no modifica migraciones anteriores.

### DEC-052: Nuclear durable, pausa conservadora y acuses de Evolution

Nuclear es owner-only, solo grupo, determinista y `modelCallable=false`; **nunca
expulsa**. Rango 5–10, defecto 8; texto exacto con sufijo `[n/total]`, mínimo
1,5 s después del envío previo confirmado. Menciones iniciales **cero**: el schema
2.3.7 admite `mentioned`, pero no hay prueba física de fiabilidad. No se usa
`mentionsEveryOne` ni se incluye a bot/identidades protegidas. Sin tormentas de
menciones por texto libre. Configuración versionada en `config/product.ts`.

Jobs cortos reanudables y un único bucle ligero de dispatcher en worker, separado
de esperas de media/Drive/rclone; no se duerme dentro del webhook ni se crea un
timer por mensaje. Cada objetivo tiene una sola outbox. Próximo envío depende de
la BD y del acuse anterior, nunca se acumulan envíos para recuperar una caída.
Se revalidan permisos, destino, hash y módulo al reclamar bajo lock de operación;
cancelación solo retira pendientes y reconoce que un envío en curso puede finalizar.

Un Nuclear activo/pausado por grupo, cooldown 10 min/grupo, máximo dos/hora global.
Difusión: hasta 20 objetivos, mínimo 2 s + jitter de hasta 0,5 s. Máximo dos
operaciones pendientes, cinco confirmadas/hora y 100 mensajes previstos/24 h.
Admisión de jobs conserva dos activos por actor y veinte globales, con locks
compartidos para media/Drive/bulk. Reintentos manuales: máximo dos por objetivo.

Evolution instalado verificado 2.3.7. HTTP 2xx con `PENDING` **no confirma** una
entrega de Fase 7: se conserva ID y queda `uncertain`. Se requiere acuse
`SERVER_ACK`, `DELIVERY_ACK`, `READ` o `PLAYED`, en respuesta o historial
`MessageUpdate`. No implica lectura humana. Ausencia de historial sigue `unknown`.
Nuclear sin ID solo reconcilia texto exacto y cita de origen inequívocos con acuse.
Un 429 pausa, conserva `Retry-After` y exige reintento explícito; 4xx definitivos
fallan, 5xx/red/timeout quedan inciertos. Nunca se reintenta un incierto a ciegas.
Resultados por objetivo y transiciones quedan en outbox, bulk_targets y audit_log.

### DEC-053: Drive operativo separado, alcance y degradación segura

La biblioteca readonly/rclone de Fase 6 no cambia. El módulo de archivos Drive usa
OAuth propio en archivo local 600, solo montado en worker, y `DRIVE_ENABLED=false`
por defecto. Además requiere módulo y `chats.settings.drive` habilitados expresamente
por owner/admin. Miembros vigentes buscan/seleccionan/descargan en su ámbito y suben
solo adjuntos propios; backend liga chat, autor, fuente y correo configurado localmente.

API Google Drive v3, raíces explícitas por chat, archivos binarios de carpeta directa;
sin shortcuts, documentos nativos, Shared Drives, rutas/IDs remotos del modelo o
usuarios. Carpetas propiedad de la cuenta OAuth y ACL solo del dueño. Búsqueda
asíncrona publica referencias locales vigentes por actor/chat. Descargas comprueban
selección, carpeta, MIME/tamaño y checksum; subida crea un archivo nuevo con ID
preasignado/persistido y verifica SHA-256 antes de compartir. No borra/sobrescribe
archivos existentes ni cambia permisos de archivos ajenos al job.

Enlaces solo por privado al actor con correo preconfigurado y ACL verificable del
dueño/destinatario, nunca `anyone`, `domain` o `group`; validación reciente de 30 s
antes de liberar. Si no puede conservarse ese ámbito o se exceden límites, falla
sin enlace. Escritura ambigua/reinicio durante creación o compartición: `review`,
sin replay. La cuota/rotación de backups externos heredada no se declara resuelta.
Los originales/cache locales de Drive usan la retención de siete días y el cupo
multimedia existente; no son blobs persistentes de biblioteca. No se borra remoto
automáticamente; su retención privada requiere política operativa del dueño.

No hay llamadas a Drive sin configuración OAuth local. Fallo/timeout no bloquea
inbox, tick, dispatcher bulk ni outbox. Pruebas físicas/OAuth quedan pendientes;
ninguna simulación se declara entrega WhatsApp o acceso real Google confirmado.

Evidencia final: **88a8281** desplegado mediante script oficial y backup verificado,
639/639 tests (548 anteriores + 91 nuevos), multimedia 82/82, procesadores reales
17/17 en imagen desplegada, wrapper 14/14, typecheck/lint/build y `/health` HTTP 200.
009 aplicada/checksum correcto; datos previos comprobados idénticos y Evolution
sin cambios de imagen/arranque. Cero grupos fuera de Lab y cero jobs de fase.
OAuth/Drive deshabilitado, sin Nuclear ni envíos físicos. **Aprobada y lista para
cierre técnico según DEC-054; constructor detenido, sin merge ni Fase 8.**

### DEC-054: Aprobación arquitectónica de Fase 7 y condiciones de activación

El 17-10-2026 el dueño comunica que **Fase 7 — Mensajería avanzada / Nuclear /
Drive fue aprobada arquitectónicamente**. No se requieren correcciones de código,
migraciones, scripts ni configuración. DEC-051–053 quedan aprobadas y la fase
queda **aprobada y lista para cierre técnico**, con evidencia en
FASE-7.md/FASE-7-PRUEBAS.md.

**Nuclear sin menciones cumple la especificación vigente**: el Plan Maestro
§9.10 condiciona las menciones al soporte fiable de Evolution. Su fiabilidad física
no está comprobada, por lo que se mantienen deshabilitadas. La ráfaga obligatoria
sigue siendo de **5–10 mensajes**, ocho por defecto, con todos los límites ya
implementados de ritmo, cooldown, volumen, concurrencia, permisos, vista previa y
confirmación ligada; nunca expulsa miembros.

**Las pruebas físicas de difusión y Nuclear no bloquean el cierre técnico**;
permanecen pendientes y son requeridas solo antes de activar fuera de Botsky Lab,
con autorización expresa del dueño. Nuclear físico conserva el aviso previo con
texto y cantidad exactos. **OAuth y la política de retención remota de Drive son
necesarias únicamente antes de activar Drive**; no bloquean el cierre técnico ni
se declaran configuradas. Drive sigue deshabilitado. Ningún mock se atribuye a
entrega WhatsApp o acceso Google real.

**No se eliminan tests ni cobertura**: se conservan las 548 regresiones y 91 tests
nuevos, además de multimedia, procesadores reales y wrapper Minecraft. Se autoriza
solo actualizar documentación de control, repetir typecheck, lint, tests, build,
multimedia, procesadores reales, wrapper Minecraft y `/health`, y hacer commit/push
a `phase-7-mensajeria-difusion-nuclear-drive`. El código desplegado sigue siendo
`88a8281`, sin nuevo despliegue ni cambios funcionales o de configuración.
**Sin merge a `main`, inicio de Fase 8 ni activaciones fuera de Lab**. Al terminar,
el constructor se detiene.

## 11. Fase 8 — decisiones del constructor, pendientes de auditoría final

### DEC-055: Alcance cerrado y autorización vigente

El dueño confirma Fases 0–7 cerradas, aprobadas y fusionadas en
`1bbaa5eed07ec4db20713d6f62d1fa11a44fa758`. Autoriza únicamente Fase 8 en
`phase-8-encuestas-pulido-produccion`, un constructor sin delegación. Supera
los bloqueos históricos de DEC-054; no autoriza merge ni declarar v1 terminado.
Se actualiza primero §0/§3 del Plan Maestro por esta instrucción directa.

Quedan formalmente fuera de v1: **afinidad; doxeo ficticio; moderación avanzada/
completa basada en strikes/reglas; reacciones y message_links; lore y crónicas
automáticas; lore_chronicle**. Motivos: bajo valor incremental, complejidad, cuota
de IA, privacidad/riesgo y alternativas funcionales ya presentes (conversación,
notas, encuestas por texto, warns mínimos y automatizaciones escuela/lluvia).
No se elimina infraestructura existente aprovechable en el futuro.

### DEC-056: Encuestas textuales y apertura gradual por chat

Encuestas de voto único modificable, solo grupo; owner/admin crea/cierra y miembros
vigentes votan/consultan. Cierre predeterminado 24 h, opcional `30m`, máximo siete
días; 2–10 opciones y diez encuestas abiertas por chat. Ninguna tool se ofrece al
modelo. Opciones/autor/chat/plazo quedan fijos; voto único por PK y eventos durables
impiden que un replay de un cambio viejo revierta el voto más reciente.

`chats.enabled` sustituye barreras temporales de Fases 0–7 en rutas de producción.
Owner habilita desde el grupo; grupos nuevos guardan todos los módulos OFF,
incluido `media` (faltaba en la lista de control). Solo core/control permanece
accesible para ping/ayuda y activación explícita, según §10.5. Rehabilitar conserva
las activaciones previas explícitas del mismo chat; no copia configuración de Lab.
Privados mantienen autoaprobación/manual por membresía, sin habilitación grupal.
La sincronización refresca secuencialmente todos los grupos habilitados; un fallo
no impide refrescar los siguientes. Refresco nunca crea/habilita grupos por sí solo.

Deshabilitar cancela outbox queued de ese grupo y evita nuevo procesamiento/envío.
Sending/uncertain conservan evidencia y reconciliación; no se promete revocar una
petición ya en vuelo. Jobs/entregas de otros módulos revalidan origen/destino,
permisos y flags. Expiraciones/devoluciones financieras siguen siendo obligaciones
durables y pueden liquidarse sin publicar en el grupo deshabilitado. Restituciones
de ruleta se conservan; proveedor/permisos no disponibles pueden exigir revisión.

### DEC-057: Operación persistente, retención y seguridad del historial

La observación de estado Evolution desde `/health` usa el endpoint instalado ya
verificado y lock transaccional. Primera caída observada conserva fecha/UUID en
system_flags; recuperación inserta una sola outbox privada al primer owner y limpia
la caída en la misma transacción. Repeticiones, concurrencia y reinicios no duplican
el aviso. Nunca se anuncia recuperación sin caída confirmada previamente.

Cleanup horario, lotes de 500: inbox done y seen_events huérfanos tras 30 días,
llm_usage tras 30 días; contexto tras siete días. Inbox de chats con jobs activos
se conserva para no eliminar evidencia de originales. Los eventos antiguos siguen
rechazados por STALE_SECONDS y los efectos durables conservan sus claves únicas.
No se purgan outbox, jobs, ledger, auditoría, escuela, notas, recordatorios, memorias,
usuarios, pedidos ni economía. No hay DELETE CASCADE en la limpieza.

Backup local: dump custom, lectura completa con pg_restore sin ejecutar SQL,
SHA-256 con nombre estricto, fsync, lock y rotación determinista de siete copias
verificadas; corruptas/no verificadas no desplazan a las válidas ni se borran.
Rclone opcional con configuración privada separada ya existente; nunca es requisito
local. Restore solo en contenedor nuevo sin red, tmpfs y sin mounts de producción;
se elimina al terminar incluso ante fallo. No se restaura producción.

Scanner automatizado examina archivos versionados y compara valores secretos del
entorno local sin imprimirlos. `--history` audita además blobs alcanzables. El
árbol actual tiene cero hallazgos; historial heredado contiene **12 blobs con JIDs
personales**, sin claves/tokens detectados por estas reglas, coincidente con DEC-016.
No se reescribe historial en esta fase. El requisito de cero JIDs en TODO Git,
si incluye historia, permanece **incumplido** y requiere una tarea explícita de
saneamiento histórico; no se declara Botsky v1 terminado ni auditoría aprobada.

Fuentes comprobadas: [pg_dump 17](https://www.postgresql.org/docs/17/app-pgdump.html),
[pg_restore 17](https://www.postgresql.org/docs/17/app-pgrestore.html),
[connectionState Evolution 2.3.7](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/routes/instance.router.ts),
[rclone copyto](https://rclone.org/commands/rclone_copyto/).

La auditoría previa al deploy también retira la etiqueta fija «Botsky Lab» de la
preview Nuclear: dice «Grupo actual» y conserva el ID backend en el hash. Discovery
de mensajería toma nombres de snapshots autenticados del propio grupo; no ofrece
un grupo nuevo sin nombre sincronizado como destino remoto. Referencias dN y
permisos persistentes siguen obligatorios. No se aceptan nombres como identidad.

Encuestas requieren identidad canónica resuelta por backend. Un LID no resuelto no
vota: evita contar dos veces a la misma persona antes/después de obtener evidencia
canónica. Un alias verificado se traduce al mismo voter_id que su teléfono. Esta
restricción se limita a encuestas; no cambia el algoritmo global de resolución.

Evidencia de entrega de Fase 8: **d24eded** desplegado por script oficial, 010
aplicada/checksum correcto; 702/702 Vitest (639 + 63), multimedia 82/82, procesadores
reales 17/17, wrapper 14/14, typecheck/lint/build y health HTTP 200. Backup verificado
y restore temporal aislado con diez migraciones; solo Lab habilitado, tablas polls
vacías. Datos persistentes comparados conservados, salvo nombre de grupo autenticado; Evolution
sin cambios de imagen/arranque. Sin merge, activaciones fuera de Lab ni declaración
v1 terminado. Auditoría FINAL pendiente y bloqueo histórico de JIDs explícito.

## 12. Botsky v1.1 — R1 (17-10-2026)

### DEC-058: Fundamentos aislados de Natural-First

Instrucción directa del dueño: baseline aprobado
`main=0c1a19ef919f759ac65bee7117ec26c2d70a286b`. Tag anotado `v1.0.0`
creado/publicado exactamente allí; rama `feat/v1.1-natural-router`.
La autorización actual supera los bloqueos históricos únicamente para R1;
no autoriza R2, deploy, merge ni cambios visibles del router v1.

011 es aditiva: inbox.turn_id con backfill y registro message_turns independiente
de retención; ledger tool_executions con cuatro orígenes, IDs proveedor opcionales,
clave interna determinista, dedupe de efecto y confirmación hija en turno nuevo;
chat_artifacts con parent chain, backing real media/escolar UUID y ownership FK.
Se distinguen chat crudo y chat resuelto por la canonicalización privada ya
existente en v1, sin cambiar actorFor/permisos ni reglas @lid.

Se añaden contratos ToolResult, SafeRefs y SemanticTime sin migrar tools ni
conectarlos al router. Adapter Gemini REST conserva content/parts completos,
call IDs y firmas opacas para un loop futuro. Flag ROUTER_MODE válido pero inerte;
cuotas por entorno mantienen topes locales históricos y solo admiten reducciones
en R1. Compose versionado reenvía esas variables; no se aplica a servicios.
Sin dependencia nueva, facturación, cuota real de proveedor ni mensajes WhatsApp.

Esquema, decisiones, límites, fuentes y evidencia en
[ARQUITECTURA](v1.1/ARQUITECTURA.md) y
[R1-FUNDAMENTOS](v1.1/R1-FUNDAMENTOS.md). La revisión crítica previa a merge sigue
siendo un paso futuro; no se afirma revisión independiente ni activación de v1.1.

## 13. Botsky v1.1 — R2 (17-10-2026)

### DEC-059: Catálogo v2, visibilidad dinámica y observación sin ejecución

R1 aprobada por el dueño; R2 autorizada exclusivamente sobre `92cde7e` en
`feat/v1.1-natural-router`. Un constructor, sin delegación, merge, deploy ni R3.
Esta autorización sustituye el bloqueo de avance histórico de DEC-058 solo en
el alcance explícito de R2. No se conecta Gemini al router v2.

Se conservan las 98 tools y todos sus PermissionKey: snapshot independiente en
`tests/fixtures/v1.1/permissions-r1.json`, contrastado contra v1 y v2. Cualquier
cambio futuro al snapshot requiere una nueva decisión explícita. task_edit
conserva `school.write` y su regla histórica de propiedad dentro del handler.
Los riesgos v2 no derivan ni sustituyen autorización.

Catálogo v2 separado sin handlers: 96 visibles, school.schedule_commit y
bulk.confirm internas, meta-tool core.load_capability adicional sin permisos de
negocio ni efectos. Schemas de modelo explícitos con SafeRefs/SemanticTime,
sanitización anidada y sin puente a handlers. La visibilidad v2 de nuclear y
otras tools no-modelCallable no modifica flags/ejecución v1: es metadata para
etapas futuras. Autorización final sigue siendo backend, pendiente R3.

Base de siete tools + meta, dominios tipados, máximo 20 incluido meta. Selección
por módulo/scope/contexto y señales léxicas; representante por dominio relevante
no-admin y llenado por prioridad, admin al final si relevante para owner. Las
señales no ejecutan, rechazan ni deciden argumentos. Una expansión válida por
turno, disponibilidad para chat/rol por módulo y scope comprobada, sin quitar
schemas ni exceder tope. No se exige señal léxica para expandir: la meta-tool
puede recuperar dominios no detectados por el selector inicial.
Fast Path v2 exacto independiente; frases naturales siempre pasan. Memoria es
semántica de productivity, nunca traducción automática a notes.create en v2.

Shadow solo agrega log de booleano, nombres estáticos y bytes, usando contexto
y sesión ya cargados; sin queries, Gemini ni writes adicionales. La ejecución
visible v1 continúa, incluido su bug legacy memoria/notas por compatibilidad.
Modo v1 no calcula v2; v1_1 permanece reservado y continúa v1 sin activarse.

Se eliminan topes artificiales de cuotas a defaults, con enteros positivos y
máximos defensivos. LLM_* tiene prioridad sobre aliases GEMINI_*; defaults v1
intactos. Reserva configurable es fallback sin reemplazar la estimación v1 de
DEC-023. No se cambian límites reales, `.env`, facturación ni configuración en
servicios. Documentación detallada y evidencia en docs/v1.1/R2-TOOL-REGISTRY.md.

Verificación final R2: 187/187 pruebas focalizadas en nueve archivos,
typecheck/lint/build, auditoría de secretos y validación Compose correctos.
Sin llamadas reales Gemini, ejecución v2, deploy, merge ni cambios a Evolution.


## 14. Botsky v1.1 — R3 (17-10-2026)

### DEC-060: Policy read-only, ejecución transaccional aislada y confirmaciones con linaje

El dueño aprueba R1/R2 y autoriza R3 exclusivamente sobre
`28d0a7e2f8aefe6a9a3a4e91a3acd03dd7265757` en
`feat/v1.1-natural-router`. Prevalece sobre el bloqueo de R3 de DEC-059/roadmap.
Sin merge, deploy, R4/R5, activación de grupos ni conexión de Gemini a tools v2.
Un constructor; no se delega. La revisión crítica previa a main sigue pendiente.

Se separan evaluateToolPolicy (solo SELECT) y executeToolV2 (registry privado,
reevaluación obligatoria, anti-replay, confirmation gate, handler, ToolResult,
ledger). Identidad se reconstruye desde inbox y actorFor; autorización usa
permitted() sin alterar PermissionKey. SafeRefs se revalidan contra datos vivos,
con scope/ownership. Fechas semánticas se serializan con offset CDMX para cumplir
el validador histórico. Los handlers y sus garantías de dominio se reutilizan.

Migración 012 aditiva, sin editar 011 ni tocar BD real: confirmaciones separadas
de sessions, request_hash inmutable para replay aunque cambie el estado, unicidad
de hija efectiva por acción lógica. Se usa uncertain/EXECUTION_IN_PROGRESS como
claim transaccional no visible antes del commit; no se inventa un estado new ni
se cambia la máquina de estados aprobada en R1. La admisión v2 se serializa con
advisory lock global para cubrir todas las claves independientes de dedupe.

Confirmación exige mensaje autenticado «sí», segundo turno y origen session;
revalida todos los gates, rol/permiso y hash con ámbito/versiones de recursos.
Una hija conserva padre/acción; A permanece needs_confirmation. Confirmaciones
consumidas reproducen su resultado. Los estados inciertos no se promueven a éxito
por inferencia. DB/cola/ledger comparten commit y savepoint ante fallos parciales;
los efectos externos siguen sujetos a idempotencia/reconciliación histórica.
No se promete exactly-once universal ni reconciliador nuevo para jobs.

Nuclear conserva implementación y límites históricos. draft añade una opción
backend con default true para preservar sesiones v1; v2 usa false únicamente
después de su confirmación y luego confirm histórico, todo en la misma transacción.
No se ejecutan envíos ni reinicios reales. Los 89 adapters v2 son explícitos;
los nueve contratos de puentes todavía no adaptados fallan con DENIED_ADAPTER_UNAVAILABLE.
No se reescriben los 98 handlers ni se habilita fallback que ignore referencias.

Resultado y evidencia final en docs/v1.1/R3-POLICY-ENGINE.md; no se declara
validación manual WhatsApp ni despliegue/health de este cambio.

## 15. Botsky v1.1 — R4 (17-10-2026)

### DEC-061: Contexto estructurado sin replay, cadena real y sesiones aisladas

R1/R2/R3 aprobadas por el dueño. Base R3
`0858ce1807f610c89084290847d14c63f09376c3`, exclusivamente en
`feat/v1.1-natural-router`, un constructor sin delegación. Esta autorización
supera el bloqueo histórico de R4. No autoriza R5, deploy, merge ni conexión de
Gemini a ejecución v2. La revisión crítica previa a main permanece pendiente.

Contexto con runtime backend separado y envelope serializable de reglas/datos/
turno actual. Se excluye historial libre v1; eventos de acciones ok usan textos
constantes, nunca llamadas/JSON legacy ni estados queued/uncertain. Presupuesto
16 000 caracteres, evicción de nodos completos, cargas scoped y acotadas, sin
resumen mediante proveedor. SafeRefs nuevas sin forma UUID; schemas R2 admiten
nuevo formato y sintaxis anterior, pero el mapa vigente sigue siendo obligatorio.
Memoria personal: cero cuerpos en grupos, DM autorizado y relevancia explícita.

Migración 013 aditiva: metadata/idempotencia por backing y mapping de outbox;
sessions_v2 separada para no alterar v1. Resultados textuales reutilizan
context_msgs con excerpt de 1 200 caracteres y retención 7 días; no se crea una
tabla nueva de textos ni se cambia A_LAST al leer un archivo. Los originales
conservan cronología del turno al registrarse tarde; outputs binarios heredan
actor/turno/job/padre/retención reales. Registro solo en v1_1; no en shadow.

Resolución compatible por matriz media existente, con A_CURRENT/A_REPLY/refs/
A_LAST. Implicación por chat+actor y 24 h; visión 10 min sin señal de raza.
Reply compartido del mismo grupo se permite para selección/reenvío sujeto a
mediaAllowed; privacidad DM/cross-chat estricta. Padres siguen mismo actor/chat
R1; no se habilitan adaptadores cerrados de transformación compartida.
Reenvío interno utiliza outbox, no añade tool #99 ni ejecuta worker.

Session v2 consume únicamente gramática completa o slots tipados. Escape de
intención devuelve not_consumed. Confirmaciones heredan hash/linaje/expiry R3,
revalidan siempre en executor y cancelan/expiran sin efectos; cancelación y
preview comparten el orden de locks de admisión R3. Shadow solo SELECT con
savepoint y métricas sin contenido; v1 y Gemini conservan su ruta visible.
Detalles, pruebas y limitaciones: docs/v1.1/R4-CONTEXT-SESSIONS-ARTIFACTS.md.


## 16. Botsky v1.1 — R5 (17-10-2026)

### DEC-062: Integración natural, transacción compartida y evidencia de respuesta

El dueño aprueba R1–R4 y autoriza R5 solo en feat/v1.1-natural-router desde
3721a6a215218d42f41b275bb9ca948874e73322. Prevalece sobre los bloqueos históricos
de R5: sin deploy, merge, Canary, grupos reales, Nuclear ni reinicios Minecraft.
No se cambian cuotas productivas, procesadores DOCX/LibreOffice ni OAuth.

SessionV2 → atajo exacto → contexto/exposición → Gemini → Policy/executor es el
único flujo v1_1. v1 intacto, shadow conserva respuesta legacy sin efectos extra.
El inbox adquiere admisión antes de locks de chat/wallets y comparte transacción
con ejecución, ledger y outbox. Invocaciones aisladas siguen con transacción propia.
Esto resuelve el bloqueo que habría causado abrir otra transacción desde inbox.

El loop conserva content/parts, firmas, ID literal y functionResponse correlativa;
solo usa partes del turno actual. Límite conservador: tres propuestas de funciones
incluyendo meta/denegadas, una expansión, tres generaciones y un mutation retry.
Synthesis no ejecuta funciones adicionales. Migración 014 agrega referencia
opcional llm_usage.turn_id; no se guardan prompts ni datos personales en métricas.

Los efectos se presentan localmente desde recibos ok/queued del turno actual.
Conversación/síntesis exigen outcome JSON estricto con effects vacío; prosa sin
contrato no autoriza un éxito. Detector léxico adicional solo diagnostica violación
del contrato. No se afirma que una declaración del modelo pruebe persistencia.
Los resultados visibles son proyecciones, nunca JSON interno completo.

Se abre media.process con artifacts scoped y backing validado; resend reutiliza
outbox. Ocho puentes R3 permanecen cerrados (lista y motivos en informe R5).
Textos cortos van al chat, largos con preview + .txt y retención vigente.
Progreso diferido, mensajes de resultado naturales, persona útil primero.
La evaluación de lenguaje en tests usa respuestas Gemini simuladas; no se declara
calidad medida de selección de un modelo vivo ni se consume cuota real.


El cierre de integración añade admisión read-only para contratos legacy cuyo
idempotency key es el mensaje, no los argumentos de cada call. Una segunda acción
distinta de esa familia se deniega; replay exacto conserva el recibo. Evita que
un voto, tarea, juego o job existente acredite falsamente otra acción propuesta.
La selección de artifact entra al hash y polls.vote presenta el voto real en BD.
Los cambios de mensajes de errores/progreso se limitan a v1_1. Una conversación
malformada no induce el retry de acción si no hay intención/afirmación de efecto.

## 17. R5 con Gemini real (17-10-2026)

### DEC-063: Prueba cotidiana real, sin moderación propia ni infraestructura nueva

Autorización del dueño desde `387f3dd47e82f201f78df262ee90d8eb5c16a615`:
Gemini real, unas 20–30 conversaciones de amigos y correcciones pequeñas.
Sin deploy, merge a main, cambios a Evolution ni implementación de los ocho
puentes pendientes. El producto no incorpora una política propia de censura;
§0 del Plan Maestro lo explicita. Cuotas y controles técnicos se conservan.

Se explicita OFF en los cuatro filtros ajustables oficiales de GenerateContent;
las protecciones inherentes y negativas del modelo siguen perteneciendo a Google.
Los bloqueos se contabilizan como provider_blocked_<motivo>, conservando tokens,
sin reintentos de evasión. Se conserva el nombre del proveedor en mensajes de error.

La prueba real descubrió JSON válido envuelto en Markdown que Composer descartaba,
y pérdida de contexto porque R4 solo transmitía eventos fijos de acciones. Se
acepta una envoltura Markdown completa manteniendo el contrato JSON sin efectos.
Se añade diálogo reciente acotado de context_msgs, exclusivamente del actor/chat,
como REFERENCE_DATA; nunca se importa como functionCalls ni instrucciones actuales.
Esto sustituye la exclusión absoluta de prosa histórica de DEC-061 para resolver
«eso» y correcciones naturales. No cambia identidad, permisos ni recibos R3.
No hay tablas nuevas, dependencias nuevas ni despliegue. Evidencia y límites en
`docs/v1.1/R5-GEMINI-REAL.md`.

El smoke real también justificó correcciones concretas: memory.remember expone a
Gemini solo body (Policy mantiene fact para callers históricos); notes.list omite
el filtro genérico «notas»; editar recordatorio conserva campos omitidos desde la
fila propia y acepta 21 pm como 21:00. La exposición llena primero los dominios
pedidos en el mensaje actual, conservando representantes del contexto: un QR y
una encuesta anterior no deben ocultar reminders.edit.

La síntesis usa responseJsonSchema oficial y vuelve a fuentes locales si el modelo
rompe el contrato. La única corrección ya prevista de action_required usa el modo
oficial functionCallingConfig.ANY; no hay retry adicional ni ejecución de pseudo
calls dentro de JSON. La detección de éxito dejó de considerar la palabra aislada
«guardado» como prueba de una mutación: bloqueaba «no hay un QR anterior guardado».
La apuesta mínima se explica sin aumentar el importe pedido; las reglas económicas
permanecen intactas. La persona reduce humillación automática y conserva cotorreo,
groserías y temas adultos. No se añaden filtros de contenido.
