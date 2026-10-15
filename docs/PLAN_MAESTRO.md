# Botsky — Plan Maestro

**Archivo:** `BOTSKY_PLAN_MAESTRO.md`
**Versión:** 2.3. Parte de la especificación original 1.0 y de la arquitectura 2.2, incorporando las decisiones de producto y operación cerradas por el dueño después del cuestionario (§0).
**Producto:** asistente de WhatsApp en español de México, vía Evolution API.
**Escala real:** 1 dueño, 1 comunidad (decenas de personas), 1 VPS.
**Destinatarios:** quien programe, revise u opere el proyecto (humano o agente).

**Alcance:** todo el catálogo funcional de la especificación original está en alcance, sin recortes. El «orden de construcción» (§3) solo define qué se hace primero.

Este documento es la fuente de verdad. Si el código necesita desviarse de él, se corrige primero el documento.

---

## 0. Decisiones del dueño (obligatorias)

Salen del cuestionario contestado (`docs/owner-answers.md`) y de las confirmaciones posteriores. **Prevalecen sobre cualquier otra sección de este documento.**

| Tema | Decisión |
|---|---|
| Costo | **Cero adicional.** Se aprovechan Oracle Free Tier, Gemini/API gratuita y las suscripciones ya disponibles del dueño para desarrollo. Ningún servicio nuevo de pago ni gasto sin permiso expreso. |
| IA dentro de Botsky | Google Gemini mediante el nivel gratuito disponible en AI Studio: conversación, visión de imágenes y transcripción de audio. Los nombres de modelo se verifican en la Fase 1 y no se fijan de memoria. |
| Agentes de desarrollo | Arquitecto/revisor + constructor(es). Pueden trabajar por SSH en VPS o desde la computadora del dueño, hacer commit y push, y avanzar sin esperar cuando pasan las pruebas. Git es el estado compartido. |
| WhatsApp | Un solo número, prepago, desechable, ya vinculado a Evolution. Es el mismo para pruebas y producción. Estará en los grupos como administrador. |
| VPS | Oracle Cloud, 4 vCPU, 8 GB de RAM, 50–100 GB, Ubuntu Server, Docker y Evolution ya funcionando. El dueño tiene más VPS disponibles para pruebas. |
| Minecraft | Bedrock en Docker, en **otro** VPS, accesible por SSH a través de Tailscale. Las consultas de estado/jugadores pueden usarlas los miembros; las acciones que cambian el servidor son del `owner`. |
| Comunidad | 2 grupos (amigos y escuela), sin menores, todos en hora de Ciudad de México. Sin opción de salirse de XP, juegos o lore. Solo el `owner` es rol global especial; los administradores de WhatsApp tienen permisos del grupo donde son admin. |
| Privados | El `owner` y los miembros actuales de cualquiera de los grupos habilitados quedan autoaprobados para conversar y recibir entregas por privado. Extraños ajenos a esos grupos se ignoran salvo autorización expresa. |
| Escuela | Cualquier miembro del grupo escolar puede registrar tareas. Solo `owner` y administradores del grupo pueden borrar/editar tareas sensibles, materias, horarios y configuración. El horario inicial puede importarse desde una foto con vista previa y confirmación. |
| Tono | Grosero, burlón, directo, sarcástico y humillador. Groserías sin restricción de tono, jerga del grupo, pocos emojis, longitud según el tema. Lleva la contraria y, si lo insultan, responde y humilla. Sin personaje de «lore» propio. |
| Errores y negativas | Si falla, explica brevemente el error. Si le piden algo que no puede o no debe, solo dice que no. Si Gemini bloquea una respuesta, no se insiste ni se gasta más cuota: respuesta corta de negativa. |
| Memoria personal | Opcional por persona (§9.14). Nunca guarda contraseñas, tokens ni datos sensibles. |
| Retención de archivos | Originales 7 días, generados 2 días. |
| XP y nivel | El nivel se calcula con el **saldo actual**: `1 + floor(saldoXP / 20)`. Gastar o perder XP puede bajar de nivel. |
| Hora Feliz | Manual: la activa el `owner` o un administrador del grupo. Duración predeterminada 60 minutos. |
| Ruleta | El perdedor recibe 1 warn. Al llegar a 3 warns se expulsa temporalmente y se programa el envío por privado del enlace de regreso. Tiempo configurable, 15 minutos por defecto (§8.2). |
| Multimedia | YouTube queda fuera. Se aceptan URL directas y búsqueda por texto en fuentes configuradas que funcionen sin cookies/cuentas del usuario y sean compatibles con el worker. |
| Biblioteca y packs | Almacenamiento híbrido: biblioteca local en VPS sincronizable con Google Drive. Las categorías se derivan de carpetas. Los packs se entregan por privado; la cooperacha exitosa publica la recompensa en el grupo. |
| Nuclear | No expulsa miembros. Es una ráfaga owner-only de mensajes/menciones al grupo, con vista previa, confirmación, límites y ritmo controlado (§9.10). |
| Automatizaciones | Resumen escolar y lluvia de contenido tienen horario configurable desde WhatsApp por usuarios autorizados. |
| Alertas | Sin canal secundario. Si WhatsApp se cae, el dueño se entera por su cuenta. Al reconectarse, el bot avisa cuánto estuvo caído (§10.3). |
| Control del dueño | Apagado de emergencia, modo mantenimiento y módulos por chat (§10.5). |
| Fuera de alcance | Proactividad, televisión y terminal libre. |
| Prioridad | Primero: IA y conversación, recordatorios, juegos, escuela y Minecraft. Al final: encuestas, lore/afinidad/doxeo, moderación completa y reacciones. |

**Sobre «sin restricciones»:** el tono del bot no tiene límites. Lo que no es tono sigue vigente porque protege al bot y a sus datos: permisos, confirmaciones de operaciones masivas, secretos fuera de logs y memoria, y que el estilo nunca cambie los datos.

---

## 1. Propósito y reglas de oro

Botsky conversa, organiza pendientes, procesa archivos, coordina actividades, administra dinámicas de grupo y controla servicios autorizados. El usuario debe percibir **un solo asistente**: misma identidad, permisos, contexto, sesiones, mensajes de progreso y tratamiento de errores.

Cinco objetivos:

1. **Fácil de usar:** entiende solicitudes naturales, sin comandos de terminal.
2. **Fácil de ampliar:** una herramienta nueva no modifica el núcleo de conversación.
3. **Confiable:** operaciones y trabajos sobreviven a reinicios.
4. **Diagnosticable:** se puede saber dónde falló una solicitud y qué efectos produjo.
5. **Operable en un VPS:** recursos limitados y tareas pesadas separadas.

**Reglas de oro:** la solución más simple que no pierda datos, no duplique efectos y sobreviva a un reinicio. Donde hay dinero (XP), permisos o acciones masivas, se hace con todo el rigor. En el resto, entre «más robusto» y «terminado», se elige terminado.

**Riesgo aceptado por el dueño:** Evolution API usa una conexión no oficial a WhatsApp. Las acciones masivas se diseñan con ritmo controlado y son reanudables (§9.10), pero esa decisión de riesgo es del dueño.

---

## 2. Principios

1. **El código decide, la IA interpreta.** El modelo propone una herramienta y sus argumentos. Permisos, actor, dinero y efectos los controla el programa.
2. **Una definición por capacidad:** toda función es una `Tool` registrada (§5.5). La ayuda se genera desde el registro.
3. **Validar en la frontera:** webhook, argumentos de tools y variables de entorno pasan por Zod.
4. **Persistir el estado importante:** recordatorios, XP, sesiones, partidas, jobs, entregas y operaciones masivas.
5. **Recibir rápido, trabajar después:** el webhook responde 200 de inmediato y lo pesado va a la cola.
6. **Idempotencia:** un evento repetido no produce un segundo efecto.
7. **No mentir:** nunca se dice «enviado», «guardado» o «cancelado» mientras el resultado esté pendiente o incierto.
8. **Errores externos visibles:** no se ocultan como éxitos.
9. **Código legible,** con responsabilidades acotadas. Una abstracción por necesidad concreta.
10. **Terminado = evidencia observable** en WhatsApp real.

---

## 3. Orden de construcción

Todo el catálogo (menos lo que el dueño sacó en §0) está en alcance. El orden sigue sus prioridades.

**Cómo avanzan los agentes:** pasan a la fase siguiente por su cuenta cuando (1) las pruebas automáticas pasan, (2) el despliegue pasó su healthcheck y (3) dejaron `docs/fases/FASE-N-PRUEBAS.md`: una lista corta de mensajes para probar en el grupo de pruebas, con la respuesta esperada. El dueño ejecuta esa lista cuando pueda. **No bloquea a los agentes, pero un módulo no se activa en los grupos reales hasta que esa lista esté probada y el dueño lo ordene** (`bot activa <módulo> aquí`, §10.5). Todo módulo nuevo se despliega deshabilitado en los grupos reales.

| Fase | Contenido | Terminado cuando… |
|---|---|---|
| **0. Esqueleto** | Docker Compose del bot junto al Evolution existente (solo se toca su webhook), base de datos propia, webhook con secreto, normalización, dedupe, chats habilitados, activación, atajo `ping`, outbox, logs, migración inicial, `scripts/deploy.sh` con respaldo previo y rollback, Evolution simulado (mock) con payloads reales capturados. | `bot ping` responde `pong` en el grupo de pruebas. Reiniciar la app en plena ráfaga no duplica ni pierde respuestas. Los mensajes viejos tras una reconexión se ignoran. Un chat no habilitado recibe silencio. `deploy.sh` revierte solo ante un fallo (probado provocándolo). |
| **1. Núcleo** | Adaptador de Gemini con control de cuota, router, registro de tools, ayuda autogenerada, permisos, sesiones, personalidad, conversación con búsqueda web y visión de imágenes, notas, recordatorios, memoria personal opcional, apagado de emergencia, modo mantenimiento y módulos por chat. | El ejemplo de §9.1 funciona en WhatsApp real. Un recordatorio sobrevive a un reinicio y llega con ±30 s. Sin cuota de IA, los atajos siguen funcionando y el bot lo dice con claridad. Una sesión ajena no se puede usar. `ayuda` solo lista lo permitido. |
| **2. Escuela** | Materias, horarios, tareas (lenguaje natural y adjuntos), importación inicial de horario desde imagen, permisos del grupo, grupo de destino y resúmenes programados configurables. | Una foto de horario produce vista previa y solo se guarda tras confirmación. Una tarea sin fecha usa la próxima clase o queda «sin fecha de entrega». Cualquier miembro puede registrar tareas; solo owner/admins gestionan horarios, materias y borrados sensibles. Un resumen programado llega una sola vez aunque haya habido una caída. |
| **3. Economía y juegos** | Ledger y carteras, XP, Hora Feliz manual, premio diario y racha, nivel por saldo, blackjack (individual y mesa), ruleta con warns, expulsión temporal y obligación de reingreso, moderación mínima (warns), airdrop (solo XP). | Tests de reglas en verde. Reiniciar a mitad de partida conserva mazo, manos y plazo. Un evento duplicado no paga dos veces. El saldo no puede quedar negativo. El nivel refleja el saldo actual. Con 3 warns se expulsa temporalmente a una cuenta de prueba y queda programado el enlace de regreso. Sin ser administrador, el bot juega sin consecuencias y lo avisa. |
| **4. Minecraft** | Control remoto de Minecraft Bedrock por SSH y Tailscale (§9.13), con lectura compartida y escritura restringida. | Miembros pueden consultar estado y jugadores. Solo owner puede iniciar, detener, reiniciar, respaldar, cambiar configuración o usar consola. La llave restringida rechaza un comando fuera de la lista (probado). Todo cambio queda en `audit_log`. |
| **5. Multimedia y documentos** | Jobs y worker, adjuntos con ámbito, stickers, conversiones, QR, OCR, PDF, transcripción (Gemini), voz (Piper), búsqueda por texto y descarga desde fuentes compatibles sin cookies. YouTube queda excluido. | Un job pesado no retrasa el `pong`. Una URL o búsqueda textual compatible produce selección/descarga sin depender de YouTube. Si el worker se reinicia, el job se reanuda o falla con un mensaje claro. Se aplican los límites de tamaño y tiempo. |
| **6. Biblioteca, packs y cooperacha** | Biblioteca híbrida VPS/Drive, categorías por carpetas, packs (reserva, entrega privada, confirmación), cooperacha con entrega grupal, lluvia de contenido configurable y pack del airdrop. | La sincronización local/Drive no duplica ítems. Un pack fallido libera la reserva. Una entrega incierta queda en `pending_review`. La cooperacha devuelve 100 % al cancelar y 80 % al vencer; al completarse publica la recompensa en el grupo. |
| **7. Mensajes, difusión, `nuclear` y Drive** | Envíos a contactos y chats, campañas de difusión, `nuclear` entendido como ráfaga controlada de mensajes/menciones y Google Drive. | Cada operación masiva tiene vista previa, confirmación ligada, límites, resultado por objetivo y es reanudable (probado solo en el grupo de pruebas). `nuclear` nunca expulsa personas. Drive entrega con acceso restringido al destinatario cuando corresponda. |
| **8. Opcionales** | Encuestas, lore, afinidad y doxeo ficticio, moderación completa (strikes y reglas) y reacciones. | Cada módulo cumple su propio criterio de §9 sin tocar el núcleo. |

---

## 4. Stack

**Restricción general: costo cero.** Si una pieza exige pagar, se busca una alternativa gratuita o se consulta al dueño.

| Capa | Decisión | Nota |
|---|---|---|
| Lenguaje | TypeScript estricto (`strict`, sin `any`) | |
| Runtime | Node.js 24 LTS | |
| HTTP | Fastify 5 | Webhook y `/health`. |
| Contratos | Zod 4 | Webhook, args de tools, env. |
| Base de datos | PostgreSQL 17 | Base **propia** de Botsky. Si Evolution ya usa un Postgres, se reutiliza el servidor con otra base. El agente lo inspecciona en la Fase 0. |
| Acceso a datos | Cliente SQL ligero (`postgres` o `pg`) y migraciones `.sql` numeradas | Sin ORM. |
| Cola de jobs | Tabla `jobs` con `FOR UPDATE SKIP LOCKED` | Sin Redis. |
| Tiempo | Luxon (o Temporal si ya es estable) | Zonas IANA siempre. |
| Logs / tests | pino (JSON) / Vitest | |
| Despliegue | Docker Compose, `restart: unless-stopped` | Imágenes multiarquitectura: el VPS podría ser ARM (`uname -m`). |
| LLM | Google Gemini, nivel gratuito | Adaptador único `core/llm.ts`. Modelos y límites según la documentación vigente (§14). |
| Visión y transcripción | Gemini (multimodal) | Mismo proveedor y misma cuota. |
| Voz (TTS) | Piper local con voz `es_MX` | Gratis y sin API. Alternativa: TTS de Gemini si el cupo gratuito alcanza. Se verifica en la Fase 5. |
| Búsqueda web | Adaptador `web.search` | Gratuita. Primero la búsqueda integrada de Gemini si el cupo gratuito alcanza. Si no, un buscador autoalojado. Se decide en la Fase 1. |
| Media | ffmpeg, yt-dlp, LibreOffice headless, Tesseract, pdf-lib/qpdf | Solo en el worker. |
| Minecraft | SSH sobre Tailscale con una llave dedicada y un script restringido | Ver §9.13. |
| Respaldos | `pg_dump` + `rclone` a Google Drive | Ver §10.2. |
| Código | GitHub privado | Sin datos ni secretos. |

---

## 5. Arquitectura

### 5.1 Vista general

```text
WhatsApp ⇄ Evolution API ──webhook──▶ [app · Fastify]
                                        │ 1. validar + dedupe + responder 200
                                        ▼
                                  cola por chat (memoria)
                                        ▼
              activación → ¿sesión? → router (atajos | LLM + tools)
                                        ▼
                                  Tool.run(ctx, args)
                                        ▼
                      compositor (cuando aplica) → OUTBOX → envío + reconciliación
                                        │
         PostgreSQL ◀───────────────────┴──────────▶ tabla jobs ──▶ [worker]
                                                                   ffmpeg · pdf · ocr · yt-dlp · operaciones masivas
```

Dos procesos, un solo repositorio:

- **app:** webhook, router, tools ligeras, tick de tiempo (§5.10) y envío.
- **worker:** jobs pesados, con concurrencia 1 (configurable) y límite de memoria del contenedor.

### 5.2 Estructura del repositorio

```text
botsky/
  src/
    main.ts  worker.ts  config.ts
    db/ (client.ts, migrations/001_init.sql …)
    wa/
      evolution.ts         # cliente REST de Evolution
      webhook.ts           # ruta + validación
      normalize.ts         # único lugar que conoce el formato crudo
      outbox.ts            # envío, reintentos y reconciliación
    core/
      router.ts  activation.ts  sessions.ts  permissions.ts
      tools.ts             # registro y contrato
      llm.ts  composer.ts  jobs.ts  time.ts
    modules/               # cada módulo: index.ts (tools), service.ts, queries.ts, *.test.ts
      notes/ reminders/ polls/ school/ media/ voice/ files/ drive/
      xp/ games/ packs/ lore/ moderation/ messaging/ bulk/
      minecraft/ memory/
  config/
    product.ts             # XP, juegos, packs, límites: versionado por Git
    minecraft.ts           # host de Tailscale, contenedor y acciones permitidas
    persona.md             # personalidad de Botsky (prompt)
  tests/fixtures/          # payloads reales capturados de tu Evolution
  docker-compose.yml
```

### 5.3 Pipeline de un mensaje

1. **Webhook:** verifica el secreto, valida con Zod y responde 200 sin esperar.
2. **Normaliza** el evento a `Msg` (abajo). Los eventos de reacción y voto se normalizan a sus propios tipos. Ignora mensajes propios, de otros bots y los más viejos que `STALE_SECONDS` (120 por defecto), que suelen llegar tras una reconexión.
3. **Dedupe:** `INSERT INTO seen_events … ON CONFLICT DO NOTHING`. Si ya existía, se detiene.
4. **Chat habilitado:** si no lo está, silencio (salvo el comando de habilitación del owner).
5. **XP por actividad** (si es un grupo y el mensaje es elegible). Es independiente de si el mensaje va dirigido al bot.
6. **Dirección:** ¿hay sesión activa del mismo usuario y chat que acepte el mensaje? ¿Se cumple una regla de activación? Si ninguna, silencio.
7. **Router:** atajo determinista o llamada al LLM (§5.6).
8. **Tool:** se ejecuta con el actor autenticado y devuelve un `ToolResult`.
9. **Compositor y envío:** la respuesta pasa por el outbox (§5.11).

Los mensajes de un mismo chat se procesan **en orden y de uno en uno** mediante una cadena de promesas por `chatId`, para evitar carreras en partidas y sesiones.

```ts
type Msg = {
  id: string;                    // id del proveedor; clave de dedupe
  chatId: string;
  isGroup: boolean;
  senderId: string;              // JID canónico, tras resolver alias
  ts: Date;
  text: string;                  // SOLO lo escrito por el usuario
  quoted?: { id: string; text?: string; fromBot: boolean; senderId?: string };
  mentions: string[];
  attachments: InAttachment[];   // referencias, no bytes
  fromMe: boolean;
};
type Reaction = { msgId: string; chatId: string; actorId: string; emoji: string };  // apunta a un mensaje identificado
type PollVote = { pollMsgId: string; chatId: string; voterId: string; options: string[] };
```

### 5.4 Activación (determinista)

En grupos, Botsky atiende cuando se cumple **alguna** de estas condiciones:

- El texto del usuario contiene `botsky`, `bot` o `botsito` como palabra completa. Regex Unicode: `(?<![\p{L}\p{N}_])(botsky|botsito|bot)(?![\p{L}\p{N}_])` con flags `iu`.
- Hay una mención directa al bot.
- El mensaje responde a un mensaje enviado por Botsky.
- El mensaje continúa una sesión activa del mismo usuario y chat.

Reglas:

- No hay prefijos.
- La palabra se busca solo en `text`, nunca en el texto citado.
- `robot` y `botella` no activan.
- Un `2` de otra persona no continúa una sesión ajena.
- Una pregunta al grupo sin llamada ni sesión recibe silencio.
- En privados habilitados se atiende todo mensaje.
- **No se consulta a un modelo** para decidir si iba dirigido al bot.

| Mensaje o situación | Comportamiento |
|---|---|
| `Botsky, guarda esta nota` | Atender. |
| `bot transcribe este audio` | Atender. |
| `botsito, cuánto XP tengo` | Atender. |
| `robot`, `botella` | No activar. |
| `2`, dentro de una selección propia | Continuar. |
| `2`, enviado por otra persona | No usar la sesión ajena. |
| Pregunta al grupo sin llamada ni sesión | Silencio. |

### 5.5 Contrato de `Tool`

```ts
export interface Tool<A extends z.ZodType> {
  name: string;                         // 'notes.create'
  description: string;                  // lo lee el LLM y la ayuda
  examples: string[];                   // alimentan `ayuda`
  args: A;
  permission: PermissionKey;            // ver §6.2
  risk: 'read' | 'write' | 'destructive';   // destructive → confirmación (§5.8)
  scope: 'group' | 'private' | 'both';
  modelCallable: boolean;               // false → solo por comando determinista (p. ej. nuclear)
  run(ctx: ToolCtx, args: z.infer<A>): Promise<ToolResult>;
}

type ToolCtx = {
  actor: Actor; chat: Chat; msg: Msg;
  db: Db; outbox: Outbox; jobs: Jobs; now: Date; log: Logger;
};

type ToolResult =
  | { ok: true; facts: Record<string, unknown>; reply: string; stylable?: boolean; attachments?: OutFile[] }
  | { ok: false; kind: 'user' | 'transient' | 'bug'; message: string };
```

- `facts` y `reply` son la **verdad del resultado**: fechas, cantidades, destinatarios, identificadores.
- `kind: 'user'` es un error explicable. `transient` es un fallo externo reintentable. `bug` se registra en `error_log` y el usuario recibe un mensaje honesto y genérico, nunca un falso éxito.
- Una tool nueva es un archivo más su registro. No se modifica el router.

### 5.6 Router y LLM

Orden de decisión para un mensaje dirigido al bot:

1. **Sesión activa** que acepte el mensaje → la maneja la sesión.
2. **Atajos deterministas** (regex → tool sin LLM): `cancelar`, `terminar`, `ayuda`, `xp`, `bot yoo`, `bot entro`, `sí`/`no` ante una confirmación pendiente, y los comandos de operaciones masivas (§9.10).
3. **LLM con tool-calling:**
   - Contexto: persona y voz, fecha y zona actuales, rol del actor, últimos N mensajes del par usuario–chat, el texto del usuario y el texto citado en un campo aparte marcado como dato.
   - Tools ofrecidas: solo las que el actor puede usar en ese chat (permiso y `scope`) y con `modelCallable: true`.
   - Hasta 3 invocaciones encadenadas por mensaje, sin bucles autónomos.
   - El modelo nunca recibe ni modifica `actor` ni `chatId`. Los inyecta el programa.
4. **Tools `destructive`:** no se ejecutan directo. Se crea una confirmación (§5.8).

**Control de cuota (Gemini, nivel gratuito):** el nivel gratuito tiene límites por minuto y por día que varían según el modelo.

1. Todo lo que tenga atajo determinista se resuelve **sin IA**.
2. Máximo 8 llamadas por usuario y minuto, y un tope global configurable en `config/product.ts` según la cuota vigente.
3. Ante un error de cuota (429): reintento con backoff y, si persiste, un mensaje corto y con la personalidad del bot, sin gastar más llamadas.
4. Puede usar un modelo gratuito más ligero para clasificar y reservar el mejor para conversar.
5. El consumo diario se registra y el owner lo consulta (`diag.cuota`).
6. El agente verifica los límites y nombres de modelo en la documentación oficial antes de fijarlos.

### 5.7 Compositor y voz de Botsky

**Personalidad (decidida por el dueño):** grosero, burlón, directo, sarcástico y humillador, en español de México y con la jerga del grupo. La definición completa vive en `config/persona.md`.

- Groserías sin restricción de tono. Pocos emojis. Longitud según el tema: lo cotidiano, corto. Las explicaciones, las que pida el tema.
- Si alguien está equivocado, le lleva la contraria. Si lo insultan o trolean, responde directo y humilla.
- Si algo falla, explica brevemente el error. Si le piden algo que no puede o no debe, solo dice que no.
- Nunca usa vocabulario de España o Argentina («hola chavales», «ostia» y «che boludo» son ejemplos de lo que NO debe decir).
- **El estilo nunca toca los datos:** fechas, horas, cantidades, destinatarios, ids y resultados salen exactos. El chiste va alrededor del dato, no sobre el dato.

**Compositor (`core/composer.ts`):**

- Entrada: `{ facts, canonical, intent: 'chat' | 'spoken' | 'tool' }`.
- Para resultados de tools, `canonical` se envía tal cual salvo que la tool marque `stylable`. En ese caso el compositor puede reescribirlo con la personalidad.
- **Verificación obligatoria:** todo token protegido de `canonical` (números, fechas, horas, `@menciones`, ids, nombres de destinatarios) debe aparecer en la salida. Si falta alguno, se envía `canonical`.
- Para respuestas habladas, adapta puntuación y ritmo conservando el significado (§9.7).
- Las respuestas conversacionales las genera el modelo en la propia llamada de enrutamiento, con el prompt de persona.
- Para ahorrar cuota, las tools escriben su texto ya con la personalidad (plantillas con variantes). El compositor solo se invoca cuando una tool marca `stylable`.

Cuando hay incertidumbre sobre un efecto externo, la respuesta lo dice con la misma personalidad, sin afirmar un resultado que no se conoce.

La información actual se obtiene con la tool de búsqueda web. El modelo no presenta lo recordado como verificado.

### 5.8 Sesiones y confirmaciones

Las sesiones permiten responder aclaraciones, elegir resultados, seleccionar contactos, reunir archivos, continuar juegos y confirmar operaciones concretas.

```text
Identificador · Chat · Propietario · Tipo · Estado · Versión · Entradas admitidas · Vencimiento
```

- Una interacción en primer plano por usuario y chat (índice único parcial sobre `status='active'`).
- Selecciones y aclaraciones: 5 minutos de inactividad. Juegos: plazos de sus reglas. Confirmaciones: 2 minutos.
- Una sesión solo acepta sus entradas previstas.
- `cancelar` cierra la interacción correspondiente.
- Los trabajos multimedia en ejecución no ocupan el primer plano.
- Sobreviven a un reinicio mientras no hayan vencido.
- Actualizaciones con control de versión (`UPDATE … WHERE version = $n`).
- Las partidas colectivas tienen participantes explícitos. Un nuevo participante entra con `bot, entro` y después usa las continuaciones admitidas.

**Confirmación:** sesión `kind='confirm'` ligada a **actor, chat, acción, hash de argumentos y vencimiento**. Solo ese actor puede aceptarla y solo para esa operación.

### 5.9 Jobs y worker

- Tabla `jobs`: `kind`, `payload`, `status` (`queued|running|done|failed`), `attempts`, `run_after`, `chat_id`, `owner_id`, `result`, `error`.
- El worker toma jobs con `SELECT … FOR UPDATE SKIP LOCKED`. Al arrancar, devuelve a `queued` los `running` huérfanos (máximo 2 reintentos y luego `failed` con aviso al usuario).
- Cada `kind` declara tiempo máximo y tamaño máximo de entrada y salida.
- Cada job trabaja en `tmp/<jobId>/`. La limpieza de temporales solo toca `tmp/`.
- Al terminar, el worker envía el resultado al chat de origen mediante el outbox.
- Un usuario puede tener como máximo 2 jobs activos (configurable).
- Las operaciones masivas (§9.10) se ejecutan como jobs reanudables.

### 5.10 Tick de tiempo

Un único bucle cada 5 s, en la app, que:

1. Reclama recordatorios vencidos (`status='pending' AND due_at <= now()`) con actualización atómica.
2. Cierra sesiones y partidas vencidas (lobbies, turnos, airdrops, cooperachas).
3. Ejecuta automatizaciones programadas (§9.12) y procesa obligaciones pendientes (restituciones).
4. Reintenta y reconcilia entradas del outbox.

La fuente de verdad del tiempo es la BD (`due_at`, `expires_at`), no los temporizadores en memoria. Tras un reinicio, el tick retoma todo.

### 5.11 Outbox y reconciliación de entregas

Todo mensaje saliente se registra primero en `outbox` y luego se envía.

```text
queued → sending → sent
                 → failed       (error definitivo, p. ej. 4xx)
                 → uncertain    (timeout o error ambiguo)
```

- **Registro individual de entrega:** cada fila tiene `dedupe_key` única, destinatario, tipo y `provider_msg_id` cuando existe.
- **`uncertain`:** antes de repetir, el reconciliador consulta al proveedor si el mensaje ya salió (por id o por contenido reciente en ese chat). Si salió, pasa a `sent`. Si no, se reintenta. Si no puede verificarse tras N intentos, queda `uncertain` y se avisa al owner. **Nunca se confirma al usuario como enviado.**
- Los reintentos solo ocurren ante errores transitorios, con backoff.
- Separación mínima entre mensajes por chat (~1 s) y presencia «escribiendo» opcional.
- Un recordatorio se marca `sent` solo cuando su fila del outbox está `sent`.
- Las campañas y operaciones masivas usan una fila de outbox por destinatario (§9.10).
- Ninguna operación de XP depende de un mensaje informativo. Los packs usan reserva, entrega y confirmación (§9.9).

### 5.12 Reacciones

Una reacción solo inicia una acción cuando:

1. Apunta a un mensaje identificado. Los mensajes del bot que admiten reacciones se registran en `message_links(provider_msg_id, kind, ref, chat_id, expires_at)`.
2. El actor autenticado tiene permiso para esa acción.
3. El enlace no ha vencido.

Cualquier otra reacción se ignora.

---

## 6. Identidad, permisos y datos

### 6.1 Roles

| Rol | Cómo se obtiene | Alcance |
|---|---|---|
| `owner` | `OWNER_JIDS` en el entorno | Configuración global, infraestructura, permisos especiales y acciones masivas. |
| `group_admin` | Verificado contra los participantes del proveedor (caché de 5 min) | Configuración y moderación **del grupo donde se verifica ese rol**. No es un rol global. |
| `member` | Participante de un chat habilitado | Conversación, herramientas comunes, datos propios y actividades habilitadas. |

No existe `operator`. Tampoco hace falta `school_editor`: en el grupo escolar cualquier `member` puede registrar tareas; `owner` y `group_admin` administran materias, horarios, borrados y configuración.

Los roles se traducen a **permisos concretos** (`PermissionKey`) y siempre se vuelven a verificar al ejecutar una acción sensible.

### 6.2 Permisos y reglas

Ejemplos de `PermissionKey`: `chat.use`, `notes.manage_shared`, `chat.configure`, `polls.manage`, `moderation.act`, `school.write`, `school.manage`, `jobs.diagnose`, `drive.use`, `minecraft.read`, `infra.minecraft`, `bulk.broadcast`, `bulk.nuclear`, `config.global`. La asignación vive en `core/permissions.ts`.

Reglas:

- La identidad procede de eventos autenticados del proveedor.
- Los nombres visibles no conceden permisos.
- Los identificadores se comparan completos.
- Las identidades alternativas del proveedor (`@lid`) solo se asocian en `user_aliases` cuando Evolution aporta evidencia verificable que relacione ambos identificadores. Nunca se adivina por nombre o teléfono parcial. Si no puede resolverse, se conserva como identidad sin privilegios especiales.
- La pertenencia activa a cualquiera de los grupos habilitados autoaprueba el uso privado mediante `group_memberships`. Una aprobación manual independiente vive en `users.private_ok_manual`; por eso salir de todos los grupos revoca solo la autoaprobación, no la concesión manual.
- Las operaciones sensibles verifican permisos **al ejecutar**, también si fueron programadas.
- El modelo no puede modificar el actor autenticado.
- Las confirmaciones se vinculan a actor, chat, acción, argumentos y vencimiento.
- Un chat solo funciona si está en `chats.enabled`. El owner lo habilita desde el propio grupo.
- Las consultas de datos privados siempre filtran por chat y autor.
- `school.write` está disponible a miembros del grupo escolar; `school.manage` solo al owner y administradores de ese grupo.
- `minecraft.read` está disponible a miembros del chat habilitado para Minecraft; `infra.minecraft` solo al owner.

### 6.3 Esquema base

```sql
create table users (
  id text primary key,                       -- JID canónico o identidad estable del proveedor
  display_name text,
  flags jsonb not null default '{}',
  private_ok_manual boolean not null default false,
  created_at timestamptz not null default now()
);
create table user_aliases (
  alias text primary key,
  user_id text not null references users(id),
  evidence text,
  verified_at timestamptz not null default now()
);
create table group_memberships (
  chat_id text not null,
  user_id text not null references users(id),
  is_admin boolean not null default false,
  active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);
create table permission_grants (
  user_id text not null, permission text not null,
  chat_id text, granted_by text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, permission, chat_id)
);

create table chats (
  id text primary key, is_group boolean not null,
  enabled boolean not null default false,
  settings jsonb not null default '{}',       -- hora feliz, juegos, consecuencias de ruleta, drive, escuela…
  created_at timestamptz not null default now()
);

create table seen_events (provider_msg_id text primary key, seen_at timestamptz not null default now());

create table context_msgs (                   -- solo mensajes dirigidos al bot y sus respuestas
  id bigserial primary key, chat_id text not null, user_id text,
  role text not null check (role in ('user','bot')), text text not null,
  created_at timestamptz not null default now()
);                                             -- ~20 por chat; purgar a 7 días

create table sessions (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null, owner_id text not null, kind text not null,
  state jsonb not null default '{}', version int not null default 0,
  status text not null default 'active', expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create unique index one_active_session on sessions(chat_id, owner_id) where status = 'active';

create table outbox (
  id bigserial primary key, chat_id text not null, kind text not null, payload jsonb not null,
  status text not null default 'queued' check (status in ('queued','sending','sent','failed','uncertain')),
  dedupe_key text unique, provider_msg_id text, attempts int not null default 0,
  next_try_at timestamptz not null default now(), bulk_target_id bigint,
  created_at timestamptz not null default now(), sent_at timestamptz
);
create table message_links (
  provider_msg_id text primary key, kind text not null, ref text not null,
  chat_id text not null, expires_at timestamptz not null
);

create table jobs (
  id bigserial primary key, kind text not null, payload jsonb not null,
  status text not null default 'queued', attempts int not null default 0,
  run_after timestamptz not null default now(), chat_id text, owner_id text,
  result jsonb, error text, created_at timestamptz not null default now()
);
create table attachments (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null, owner_id text not null, kind text not null, mime text,
  path text not null, size bigint, is_original boolean not null default false,
  expires_at timestamptz, created_at timestamptz not null default now()
);
create table error_log (id bigserial primary key, at timestamptz default now(), where_ text, msg_id text, detail text);

create table notes (
  id bigserial primary key, chat_id text not null, author_id text not null,
  body text not null, created_at timestamptz not null default now(),
  updated_at timestamptz, deleted_at timestamptz
);                                             -- índice GIN con to_tsvector('spanish', body)

create table reminders (
  id bigserial primary key, chat_id text not null, owner_id text not null,
  body text not null, due_at timestamptz not null, tz text not null,
  recurrence jsonb,                            -- {freq:'daily|weekly|monthly', byDay?, time}
  status text not null default 'pending' check (status in ('pending','sent','cancelled')),
  created_at timestamptz not null default now()
);
create index reminders_due on reminders(due_at) where status = 'pending';

-- economía (sin FK a users: existen cuentas de sistema como 'system:community')
create table wallets (
  user_id text primary key, balance int not null default 0 check (balance >= 0),
  last_daily_at timestamptz, streak int not null default 0
);
create table xp_ledger (
  id bigserial primary key, user_id text not null, delta int not null,
  reason text not null, ref text not null, chat_id text,
  created_at timestamptz not null default now(),
  unique (reason, user_id, ref)                -- idempotencia de cualquier movimiento
);
create table activity_marks (user_id text, chat_id text, last_at timestamptz, primary key (user_id, chat_id));

create table games (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null, kind text not null,   -- blackjack | roulette | airdrop | cooperacha
  status text not null, state jsonb not null, version int not null default 0,
  expires_at timestamptz, created_at timestamptz not null default now()
);
create table obligations (                     -- restituciones persistentes (p. ej. consecuencias de ruleta)
  id bigserial primary key, kind text not null, chat_id text not null, user_id text not null,
  due_at timestamptz not null, status text not null default 'pending', detail jsonb,
  created_at timestamptz not null default now()
);
```

### 6.4 Tablas por módulo (resumen)

```text
polls(id, chat_id, author_id, msg_id, multi bool, closes_at, status) · poll_options(poll_id, idx, label)
  · poll_votes(poll_id, voter_id, option_idx)  PK(poll_id, voter_id, option_idx)
school_subjects(id, chat_id, name) · school_schedule(subject_id, weekday, start, end)
  · school_tasks(id, subject_id, title, due_at null, due_source 'explicit'|'next_class'|null, created_by, attachment_ids[])
  · school_config(chat_id, target_group_id, summary_schedule jsonb)
  · school_imports(id, chat_id, author_id, source_attachment_id, preview jsonb, status, created_at)
library_items(id, category, path, mime, size, enabled) · pack_orders(id, user_id, price, items[], status, detail)
lore_events(id, chat_id, text, created_by, at) · lore_cards(id, chat_id, subject, alias[], traits jsonb)
moderation_events(id, chat_id, user_id, kind 'warn'|'unwarn'|'strike'|'kick'|'ban', source 'manual'|'roulette', by, reason, at)
bulk_ops(id, kind 'broadcast'|'nuclear', chat_id, actor_id, status, params jsonb, created_at, confirmed_at)
  · bulk_targets(id, op_id, target_id, status 'pending'|'sent'|'failed'|'skipped'|'uncertain', detail, done_at)
automations(id, chat_id, kind, enabled, config jsonb, next_run_at, last_run_at, catch_up bool)
audit_log(id, at, actor_id, chat_id, action, target, args_hash, result)   -- Minecraft y operaciones masivas
user_memories(id, user_id, fact, created_at)                               -- memoria personal opt-in (§9.14)
system_flags(key, value jsonb, updated_at)                                 -- apagado de emergencia, mantenimiento (§10.5)
```

### 6.5 Adjuntos

- Se resuelven por `id` y por ámbito (chat y usuario). **No existe un «último archivo» global.**
- «Este archivo» significa, en este orden: el adjunto del mensaje, el del mensaje citado o el último adjunto del mismo usuario y chat en los últimos 10 minutos.
- **Originales y artefactos generados tienen identidades distintas** (`is_original`). Originales: 7 días. Generados: 2 días (ambos configurables). La limpieza de temporales nunca elimina originales.
- Cada conversión declara formatos admitidos y límites en una tabla del código. Una combinación no soportada se rechaza con un mensaje claro.

---

## 7. Economía (XP)

Los XP son puntos internos de la comunidad, representados mediante enteros. No representan dinero. **El saldo es global por usuario** (una comunidad, una cartera). Los límites de frecuencia son por usuario y grupo.

### 7.1 Reglas

- Todo movimiento escribe en `xp_ledger` y actualiza `wallets` **en la misma transacción**. El `UNIQUE (reason, user_id, ref)` impide procesar dos veces un mismo evento (por ejemplo `reason='activity'`, `ref=<msgId>`). Los eventos duplicados no otorgan XP adicional.
- El saldo nunca baja de 0 (constraint).
- **Reserva:** una apuesta se debita al entrar a la partida (`reason='bet'`). El pago se acredita al resolver (`payout`). La cancelación acredita `refund`.
- **Cuenta comunitaria `system:community`:** recibe remanentes de divisiones (`community_remainder`) y las retenciones por vencimiento de cooperachas (`community_retention`). Se usa para reservar recompensas (§8.4).
- Todas las cantidades y probabilidades viven en `config/product.ts`, versionado por Git. El valor de la versión de configuración se registra en los eventos de juego.

### 7.2 Valores iniciales (configurables)

| Regla | Valor inicial |
|---|---|
| Saldo inicial | 0 XP |
| Mensaje elegible de grupo | +1 XP |
| Mensaje elegible durante Hora Feliz | +20 XP |
| Frecuencia de recompensa por actividad | Como máximo una por minuto y usuario en cada grupo |
| Nivel | `1 + floor(saldoXP / 20)` |
| Premio diario | Un reclamo cada 24 horas |

**Mensaje elegible:** texto de al menos 3 caracteres, en un grupo habilitado, que no sea del bot ni un duplicado.

**Premio diario:**

| Probabilidad | Premio |
|---:|---:|
| 3 % | 1.000 XP |
| 12 % | 300 XP |
| 35 % | 100 XP |
| 35 % | 40 XP |
| 10 % | 15 XP |
| 5 % | 0 XP |

**Racha:** continúa cuando el siguiente reclamo ocurre dentro de 48 horas. Bono de 20 XP por día consecutivo adicional, hasta 100 XP, solo cuando el premio base es positivo.

Todo el azar usa `crypto.randomInt`.

### 7.3 Hora Feliz

Duración predeterminada de 60 minutos, con configuración por grupo (`chats.settings.happy_hour_until`). **No arranca sola:** la activa manualmente el `owner` o un `group_admin` del grupo mediante una tool/comando determinista. Sus beneficios económicos (XP y precio de packs) son independientes de la lluvia de contenido.

---

## 8. Juegos

Los estados viven en `games.state` (jsonb) con `version` para escrituras optimistas. Los plazos usan `expires_at` y el tick de 5 s. Una partida solo acepta las entradas de sus participantes.

### 8.1 Blackjack

- **Modalidades:** individual y mesa de grupo (hasta 6 participantes).
- **Apuesta:** predeterminada de 50 XP, rango 20–1.000.
- **Plazos:** lobby 35 s, turno de mesa 30 s, turno individual 60 s. Agotar el turno equivale a plantarse.
- **Dealer:** roba hasta alcanzar 17.
- **Doblar:** solo con las dos cartas iniciales y saldo suficiente. Añade una apuesta igual, entrega una carta y cierra el turno.
- **Pagos (devolución total):** empate = devolución (1×). Victoria normal = 2× la apuesta. Blackjack natural = `floor(apuesta × 2,5)`.
- La apuesta se reserva antes de comenzar. Cancelar el lobby devuelve las reservas.
- **Persistencia:** el mazo barajado (Fisher–Yates con `crypto.randomInt`) y las decisiones se guardan, para que un reinicio no cambie la partida.

### 8.2 Ruleta

- Entre 2 y 6 participantes. Lobby de 60 s. Apuesta predeterminada de 50 XP, dentro del rango de juegos.
- Se selecciona de forma uniforme a **una** persona que pierde. El bote se distribuye entre los supervivientes.
- El remanente de la división se registra explícitamente en la cuenta `system:community`.
- Si se cancela o no hay participantes suficientes: devolución completa.
- **Consecuencia (decisión del dueño):** quien pierde recibe **1 warn** en ese grupo. Con **3 warns** recibe un **castigo temporal fuera del grupo**.
  - La consecuencia debe estar habilitada en el grupo (`chats.settings.roulette_warns`) y se **publica antes** de que alguien entre: «quien pierda recibe un warn; al tercero, sale temporalmente».
  - Tiempo de castigo configurable por grupo, **15 minutos por defecto**.
  - Requiere que el bot sea administrador. Se verifica al abrir el lobby. Si no lo es, la partida se juega sin consecuencias y el bot lo avisa.
  - La expulsión se ejecuta mediante una obligación persistente (`obligations`, `kind='roulette_kick'`) que se reintenta si falla y sobrevive a un reinicio.
  - Al expulsar, se crea otra obligación (`kind='roulette_reinvite'`) para el final del castigo. En ese momento el bot obtiene o reutiliza un enlace válido de invitación del grupo y lo envía **por privado** al expulsado. Si Evolution no permite obtenerlo o enviarlo, registra el fallo y avisa al owner; nunca inventa que lo mandó.
  - Tras una expulsión, los warns de esa persona se reinician a 0.
  - El `owner` y los administradores del grupo reciben el warn, pero no se expulsan. En ese caso el bot lo avisa en el grupo.
- Los warns y su consulta son los de §9.10.
- No se aplica ninguna consecuencia que no se haya anunciado en la partida.

### 8.3 Airdrop

- Tiene identificador y vencimiento, y publica sus condiciones.
- Acepta `bot yoo` o una continuación válida de un participante.
- Concede el premio a **un único ganador** mediante una operación atómica: `UPDATE games SET status='claimed' … WHERE id=$1 AND status='open'` y comprobación de filas afectadas.
- Premio inicial: 500 XP y un pack (el pack se añade en la Fase 6; antes, solo los 500 XP).

### 8.4 Cooperacha (se construye en la Fase 6)

- Una actividad activa por grupo.
- Meta predeterminada de 500 XP, rango de metas 50–50.000 XP. Duración de diez minutos.
- Aportaciones positivas y transaccionales. Aporte máximo: la cantidad restante para completar la meta.
- **Éxito:** consume los aportes (pasan a `system:community`) y publica la recompensa anunciada **en el grupo para todos**, aunque solo algunos hayan aportado.
- **Cancelación administrativa:** devolución del 100 %.
- **Vencimiento:** devolución del 80 %, redondeada hacia abajo. La retención va a la cuenta comunitaria.
- La retención por vencimiento se muestra antes del primer aporte.
- **Reserva de recompensa:** se reserva antes de abrir la actividad (XP desde `system:community` o stock verificado de un pack). Si no puede garantizarse su disponibilidad, no se aceptan aportaciones.

---

## 9. Catálogo funcional

### 9.1 Asistencia, conversación y ayuda

- Conversación general y respuestas informativas.
- Interpretación de solicitudes naturales.
- Lectura y análisis de contenido autorizado.
- Contexto conversacional limitado por usuario y chat.
- **Ayuda por tema** y descubrimiento de funciones, generada desde las capacidades registradas con ejemplos adecuados al contexto y a los permisos.

**Ejemplo de referencia (debe funcionar tal cual):**

```text
Usuario: Botsky, guarda que la reunión será el viernes.
Botsky: Guardé la nota #18. Quedó visible en este chat.

Usuario: Bot, recuérdame entregar el proyecto.
Botsky: ¿Cuándo quieres que te lo recuerde?

Usuario: Mañana a las 8 de la mañana.
Botsky: Te aviso mañana a las 8:00 a. m., hora de Ciudad de México.

Usuario: Botsito, junta estas fotos en un PDF.
Botsky: Voy a reunirlas. Envía las que faltan y escribe «terminar».

Usuario: Terminar.
Botsky: Estoy preparando el PDF.

Botsky: Listo, aquí está tu archivo.
```

Cuando falta un dato, se pregunta únicamente por ese dato.

### 9.2 Notas

- Crear, consultar, buscar (full-text `spanish`), editar y eliminar (borrado lógico).
- Privado: notas personales. Grupo: notas compartidas dentro de ese chat.
- Cada nota registra autor y fecha. El autor modifica las suyas. Un administrador del grupo gestiona las notas compartidas de su grupo.
- Una nota privada no aparece en búsquedas desde otro chat.

### 9.3 Recordatorios

- Fechas y horas explícitas, expresiones relativas, programaciones recurrentes, consulta de pendientes, modificación y cancelación.
- El LLM devuelve la fecha en ISO-8601 con zona, calculada a partir de la fecha y zona actuales. El programa la valida y rechaza fechas pasadas.
- La confirmación incluye contenido, fecha, zona horaria y destino.
- Si falta la fecha, se pregunta. Si «a las ocho» es ambiguo, se aclara el periodo antes de programar.
- Fechas en UTC. Las recurrencias conservan su zona IANA y la hora local. Recurrencias: diaria, semanal (días) y mensual (día).
- Un recordatorio vencido durante una interrupción se entrega **una sola vez**, indicando el retraso.
- Las publicaciones periódicas de entretenimiento omiten las ejecuciones vencidas (`automations.catch_up = false`).

### 9.4 Encuestas

- Crear, definir opciones, emitir o modificar un voto, consultar resultados y cerrar.
- Desde la creación quedan fijados: chat, autor, opciones, voto único o múltiple y fecha de cierre (si existe).
- **La identidad del votante procede del evento del proveedor**, nunca de nombres escritos por el modelo.
- Se probará primero si Evolution entrega los votos de las encuestas nativas de forma fiable. Si no, la encuesta funciona por mensaje (responder con el número de opción) mediante sesiones de grupo.

### 9.5 Escuela

- Materias, horarios, tareas, fechas de entrega, adjuntos, grupo de destino y resúmenes programados.
- **Registro de tareas:** cualquier miembro del grupo escolar habilitado puede crear tareas con lenguaje natural y adjuntos.
- **Gestión sensible:** solo `owner` y `group_admin` del grupo escolar pueden borrar/editar tareas ajenas, crear o modificar materias, cambiar horarios y configurar el resumen.
- **Importación inicial desde imagen:** el owner envía una foto/captura del horario y pide guardarlo. Gemini Vision extrae una estructura de materias, días y horas. El programa valida el esquema, muestra una **vista previa completa** y no escribe nada hasta una confirmación explícita. La imagen original sigue la política normal de retención.
- Sin fecha explícita: se usa la próxima clase de la materia si hay horario. Si no puede determinarse, se guarda como «sin fecha de entrega». **No se inventa un calendario académico.**
- Las publicaciones se envían al grupo escolar configurado.
- El horario del resumen se puede crear o modificar desde WhatsApp por owner/admin. Los resúmenes programados son automatizaciones (§9.12).

### 9.6 Multimedia y documentos

- Buscar videos y música por **texto** y descargar contenido mediante **URL directa** en fuentes configuradas compatibles; cuando hay varios resultados se abre una sesión de selección.
- **YouTube queda excluido por decisión del dueño.** No se diseña dependencia de cookies personales, cuentas ni evasión de verificaciones anti-bot.
- Las fuentes de descarga/búsqueda se mantienen en una allowlist versionada y solo se habilitan tras comprobar desde el VPS que funcionan sin credenciales del usuario y dentro de los límites técnicos/legales aplicables.
- El router puede ofrecer un atajo determinista para solicitudes claras de búsqueda/descarga multimedia; no es obligatorio gastar una llamada de LLM para detectar una intención obvia.
- Convertir audio, video e imágenes. Stickers estáticos y animados. Efectos de audio.
- Transcribir, sintetizar voz, crear y leer QR, OCR.
- Leer documentos. Convertir documentos de oficina a PDF. Comprimir, recortar y unir PDF. Páginas a imágenes. Reunir imágenes en un PDF.
- Los resultados solicitados desde un grupo se entregan en ese grupo salvo una función que explícitamente indique entrega privada. Los packs comprados son privados (§9.9).
- Cada conversión declara formatos admitidos, tamaño máximo, duración máxima y timeout.
- Todo lo pesado se ejecuta como job (§5.9).

### 9.7 Voz

La producción de voz separa cinco etapas: contenido que debe decirse, preparación del texto para lectura, selección de voz, síntesis y entrega.

- Si el usuario pide leer un texto literalmente, **no se reescribe**.
- Si pide una respuesta hablada, el compositor adapta puntuación y ritmo conservando el significado.
- La transcripción devuelve texto y, cuando se solicita, un resumen claramente separado.

### 9.8 Archivos, bibliotecas y Google Drive

- Buscar y seleccionar archivos, consultar información, descargar contenido autorizado, subir un adjunto y entregar archivos o enlaces con el acceso adecuado.
- Consultar bibliotecas multimedia configuradas (`library_items`). La biblioteca de packs puede usar una **copia/cache local en el VPS sincronizada con Google Drive mediante rclone**; Drive es fuente de contenido y el VPS sirve los archivos locales. Las categorías se derivan de las subcarpetas configuradas.
- Una reacción puede iniciar una acción solo bajo las condiciones de §5.12.
- **Drive:** módulo `drive/` con credenciales de cuenta de servicio o OAuth del owner, habilitado por chat (`chats.settings.drive`). Si un resultado supera el límite de entrega directa, se sube a Drive y se comparte **con el acceso restringido al destinatario** (correo asociado). Si no puede conservarse ese ámbito de acceso, no se usa Drive y se informa del límite.

### 9.9 Packs, Hora Feliz, lluvia de contenido y airdrops

- **Packs:** entregan elementos de una biblioteca autorizada. Precio normal 150 XP, precio durante Hora Feliz 75 XP. Cantidad normal: entre 3 y 5 elementos. Durante Hora Feliz: entre 4 y 6. Categoría opcional. Entrega privada.
- **Flujo del pack:** se verifica disponibilidad → se debita (reserva) → se envía por privado → se confirma. Un fallo definitivo sin entrega libera la reserva. Una entrega incierta pasa a **reconciliación** (§5.11) y el pedido queda en `pending_review` hasta resolverse.
- **Lluvia de contenido:** automatización separada, habilitada expresamente, con frecuencia y cantidad limitadas. Su horario se puede crear o cambiar desde WhatsApp por el owner/admin autorizado.
- **Airdrop:** ver §8.3.

### 9.10 Mensajes, difusión y operaciones masivas

**Envíos a contactos y otros chats** requieren: actor autorizado, destinatario resuelto, contenido definido y registro individual de entrega (outbox).

**Campañas de difusión**

1. Se construye un borrador (`bulk_ops`, `status='draft'`) con **destinatarios explícitos** y contenido.
2. Se muestra una **vista previa** (contenido y lista de destinatarios).
3. Una **confirmación** ligada a esa operación (actor, chat, id de operación, hash de destinatarios y contenido, 2 min).
4. Ejecución por job con ritmo controlado (pausa entre destinatarios con jitter, configurable) y **progreso** periódico.
5. Resultado individual por destinatario (`bulk_targets`).
6. Las entregas fallidas se reintentan **sin repetir las exitosas** (comando del owner: `bot reintentar fallidos`).

**Operación `nuclear`** (ráfaga masiva de mensajes/menciones; **no expulsa personas**)

- Reservada al `owner` (`bulk.nuclear`). Disponible **solo en grupos** y `modelCallable: false`.
- Produce una ráfaga corta para llamar la atención del grupo: **5 a 10 mensajes** por ejecución, con 8 como valor sugerido inicial y separación aproximada configurable (nunca simultáneos).
- Puede mencionar a los miembros del grupo cuando Evolution lo soporte de forma fiable. Se excluyen siempre el bot y las identidades protegidas.
- Antes de ejecutar muestra una **vista previa** con cantidad, texto/variantes, destinatarios/menciones y ritmo; requiere confirmación ligada a actor, chat, operación y hash de contenido.
- Solo puede existir una operación `nuclear` activa por grupo. Tiene cooldown configurable y límites globales para evitar ejecuciones accidentales repetidas.
- Cada mensaje usa outbox/dedupe y la operación es reanudable: al reiniciar continúa únicamente con los envíos pendientes.
- Si WhatsApp/Evolution empieza a devolver errores de tasa o desconexión, la operación se pausa y se marca como fallo; no acelera ni intenta ocultar el problema.

**Moderación (mínimo desde la Fase 3, completa en la Fase 8):** advertencias (`warn`) con conteo por grupo. El `owner` o un `group_admin` pone y quita warns (`bot warn @x`, `bot quita warn @x`) y cualquiera consulta los suyos (`bot warns`). La política automática de 3 warns se usa para la ruleta y aplica el castigo temporal descrito en §8.2. Las expulsiones manuales y demás acciones destructivas piden confirmación. Los strikes por conductas y las reglas avanzadas son de la Fase 8.

### 9.11 Comunidad, lore y afinidad

- **Lore:** registrar acontecimientos ficticios o relatos de la comunidad, consultar fichas, configurar alias y rasgos de personaje y generar crónicas **a partir de eventos registrados**.
- **Afinidad:** indicador lúdico, separado de los permisos. Nunca determina si un usuario recibe información correcta ni acceso a sus propios datos.
- **Doxeo:** ficha humorística manifiestamente ficticia. No busca ni divulga información privada.
- **Proactividad:** fuera de alcance por decisión del dueño.

### 9.12 Automatizaciones

Tabla `automations`: tipo (`content_rain`, `school_summary`, `lore_chronicle`), grupo, configuración, `next_run_at` y `catch_up`. El tick (§5.10) las ejecuta. El `owner` o el administrador autorizado puede cambiar desde WhatsApp el horario del resumen escolar y de la lluvia de contenido. Las de entretenimiento omiten ejecuciones vencidas. Los resúmenes escolares se entregan una sola vez con el retraso indicado.

### 9.13 Infraestructura: Minecraft Bedrock remoto

Corre en **otro VPS**, dentro de Docker, y se controla por SSH a través de Tailscale.

**Permisos:**
- `minecraft.read`: miembros del grupo habilitado pueden consultar **estado** y **jugadores en línea**.
- `infra.minecraft`: solo `owner`; permite recursos detallados, logs, mundos, configuración, copias, inicio, detención, reinicio y comandos de consola permitidos.

Las consultas de lectura nunca habilitan indirectamente una acción de escritura. Detención y reinicio piden confirmación.

**Capacidades:** estado, jugadores en línea, recursos del contenedor, mundos y configuración (claves permitidas de `server.properties`, con aviso de reinicio), mods o addons, logs (lectura con límite de tamaño), copias, inicio, detención y reinicio y comandos de consola de una lista permitida.

**Diseño de acceso (obligatorio):**

1. Una llave SSH **dedicada** a Botsky, distinta de las de uso personal, registrada en el VPS de Minecraft con `restrict,command="/opt/botsky/mc-ctl.sh"`.
2. `mc-ctl.sh` es un script fijo en ese VPS. Acepta solo acciones con nombre (`status`, `players`, `logs N`, `start`, `stop`, `restart`, `backup`, `console <comando permitido>`, `config-get`, `config-set <clave permitida>`), valida `SSH_ORIGINAL_COMMAND` con patrones estrictos y las traduce a comandos de Docker. No ejecuta nada fuera de esa lista.
3. El bot llega a ese VPS por su nombre o IP de Tailscale. Se verifica **desde dentro del contenedor** que la red de Tailscale es alcanzable. Si no lo es, el contenedor usa `network_mode: host` o un sidecar de Tailscale (decisión del agente).
4. Cada acción se registra en `audit_log` y lleva su timeout.
5. Antes de escribir el script, el agente inspecciona (solo lectura) el VPS de Minecraft: nombre del contenedor, imagen, volúmenes, mundos y copias actuales. Si la imagen es `itzg/minecraft-bedrock-server`, la consola se alcanza con `send-command`. Se confirma antes de asumirlo.

### 9.14 Memoria personal (opcional por persona)

- Es **opt-in**. Solo se guarda algo si la persona lo pide («bot, acuérdate de que…»). `qué sabes de mí` lo lista. `olvida X` y `olvídalo todo` lo borran.
- Datos cortos en `user_memories` (límite de 30 por persona y 200 caracteres cada uno).
- Un filtro rechaza contraseñas, tokens, claves y números de tarjeta.
- Se inyecta en el contexto solo cuando esa persona habla con el bot. Nunca se muestra a otras.

---

## 10. Operación

### 10.1 Despliegue y entornos

- **Producción:** el VPS de Oracle. Docker Compose con `botsky-app` y `botsky-worker` junto al Evolution que ya funciona. **No se modifica la configuración ni la base de datos de Evolution**, salvo apuntar su webhook al bot. No se desvincula ni se vuelve a vincular el número.
- **Desarrollo:** la computadora del dueño o un VPS de pruebas, con un Evolution simulado (mock) alimentado por payloads reales capturados en la Fase 0. En desarrollo no se usa el número real.
- **Pruebas reales:** con el mismo número, en el grupo de pruebas. Los módulos se habilitan solo ahí hasta que el dueño los active (§10.5).
- **Despliegue (`scripts/deploy.sh`, ejecutado por el agente por SSH):** respaldo de la base → `git pull` → build → migraciones → `up -d` → healthcheck → si falla, rollback a la imagen anterior. Nunca se despliega sin respaldo previo.
- Variables de entorno validadas al arrancar (si faltan, la app no inicia), en un `.env` con permisos 600 y fuera de Git: `EVOLUTION_URL`, `EVOLUTION_APIKEY`, `INSTANCE`, `WEBHOOK_SECRET`, `OWNER_JIDS`, `DATABASE_URL`, `GEMINI_API_KEY`, `TZ_DEFAULT=America/Mexico_City`, `STALE_SECONDS`, y las del acceso a Minecraft. Se incluye `.env.example` sin valores.

### 10.2 Respaldos

- `pg_dump` diario por cron: copia local (7 copias) y copia a Google Drive con `rclone`. La base contiene datos personales: **nunca va a GitHub**.
- Respaldo extra antes de cada despliegue.
- Oracle ya hace copias del disco del VPS. No sustituyen al `pg_dump`.
- La restauración se prueba una vez en un VPS de pruebas antes de dar el sistema por bueno.

### 10.3 Observabilidad mínima

- pino con `msgId`, `chatId`, `tool` y `ms` en las líneas relevantes.
- `GET /health`: base de datos y conexión de Evolution.
- `error_log` y una tool de owner (`diag.errores`) con los últimos 20 errores.
- Si Evolution se desconecta, el bot no puede avisar por WhatsApp (no hay canal secundario, decisión del dueño). Queda en logs y en `/health`. Al reconectarse, avisa al owner por privado cuánto estuvo caído.

### 10.4 Errores y reinicios

- Todo error se clasifica como `user`, `transient` o `bug`. Ninguno se convierte en un éxito aparente.
- Al arrancar: migraciones, rescate de jobs huérfanos, reconciliación del outbox y tick sobre lo vencido.

### 10.5 Controles del dueño

Todos son atajos deterministas (sin IA), solo para el `owner`, y funcionan aunque se haya agotado la cuota de Gemini.

- **Módulos por chat** (`chats.settings.modules`): todo módulo nuevo nace deshabilitado en los grupos reales y habilitado en el grupo de pruebas. Comandos: `bot activa <módulo> aquí`, `bot desactiva <módulo> aquí`, `bot módulos`.
- **Apagado de emergencia:** `bot apagado de emergencia`. El bot deja de ejecutar tools y de responder a todos, salvo al owner para `bot reactiva`. El estado se guarda en `system_flags`. Si el bot no responde, `scripts/panic.sh` por SSH hace lo mismo.
- **Modo mantenimiento:** `bot mantenimiento on` y `bot mantenimiento off`. Los demás reciben «estoy en mantenimiento» y el owner sigue operando.

---

## 11. Seguridad

- Webhook protegido con secreto compartido. Evolution no es accesible desde Internet sin él.
- Solo chats habilitados y usuarios conocidos. Lo demás es silencio.
- **Inyección de instrucciones:** todo texto de usuarios, documentos, páginas web o transcripciones es **dato**, nunca instrucciones ni fuente de identidad o permisos.
- Argumentos de tools validados con Zod. Nada llega a shell, SQL o rutas de archivo sin parametrizar o sanear.
- Los comandos externos (ffmpeg, yt-dlp, LibreOffice, Docker) se invocan con `execFile` y argumentos en arreglo, con timeout.
- Las tools de infraestructura (Minecraft) y las operaciones masivas están ligadas a permisos explícitos y dejan `audit_log`.
- Límites: tasa de LLM por usuario, jobs por usuario, tamaño y duración de medios.
- Sin secretos en el repositorio ni en los logs.

---

## 12. Pruebas (las que valen la pena)

No hay objetivo de cobertura. Hay tests donde un fallo cuesta XP, permisos, fechas o efectos masivos:

- `activation`: casos de §5.4.
- `permissions`: owner, admin por grupo, member, autoaprobación privada, alias sin resolver, chat no habilitado, `school.write/manage` y `minecraft.read/write`.
- `sessions`: propietario, vencimiento, entrada ajena, confirmación ligada a actor y argumentos.
- `xp`: ledger idempotente, saldo no negativo, racha, nivel, cuenta comunitaria.
- `blackjack`, `ruleta`, `cooperacha`: reglas puras (manos, dobles, pagos, remanentes, retenciones), castigo temporal/reinvite y entrega grupal con barajado inyectable.
- `reminders`: zona horaria, recurrencias, ambigüedad, vencidos tras una caída.
- `outbox`: transición de `uncertain` y reintento sin duplicar.
- `bulk`: hash de confirmación, límites/cooldown de `nuclear`, exclusión de identidades protegidas, reanudación y que los reintentos no repiten exitosos.
- `composer`: que ningún token protegido se pierda.
- `normalize`: **fixtures reales** capturados de tu Evolution (texto, cita, mención, audio, imagen, documento, reacción, voto y alias).

Además, una **prueba de humo** manual por fase en WhatsApp real (criterios de §3).

---

## 13. Reglas para quien desarrolla

1. Leer este documento antes de tocar código. Si hay que desviarse, cambiar primero el documento.
2. Una fase a la vez.
3. Ninguna dependencia nueva sin una línea de justificación en el commit.
4. Reglas de negocio como funciones puras y probables. Archivos pequeños (referencia: menos de ~300 líneas).
5. Sin `any`, sin `catch` vacíos, sin éxitos falsos.
6. Todo número de producto va en `config/`.
7. Una tool nueva = un archivo + registro. Si requiere cambiar el router, se consulta antes.
8. Commits pequeños y comprensibles.
9. Antes de dar algo por terminado: pruebas automáticas en verde, despliegue con healthcheck y `docs/fases/FASE-N-PRUEBAS.md` listo para que el dueño lo pruebe en el grupo de pruebas. Un módulo no se activa en grupos reales sin esa prueba (§3).

---

## 14. Decisiones abiertas y observaciones

### 14.1 Decisiones ya cerradas por el dueño

- Nivel sobre **saldo actual**: `1 + floor(saldoXP / 20)`.
- Hora Feliz: solo manual por owner/admin, 60 min por defecto.
- Ruleta: 3 warns → expulsión temporal; castigo configurable, 15 min por defecto; luego enlace de regreso por privado.
- `nuclear`: ráfaga de mensajes/menciones, nunca expulsión masiva.
- Escuela: cualquier miembro registra tareas; owner/admin gestionan materias, horarios y borrados sensibles.
- Horario escolar inicial: importable desde foto con visión, vista previa y confirmación.
- Privados: miembros actuales de grupos habilitados quedan autoaprobados.
- Minecraft: miembros consultan estado/jugadores; solo owner ejecuta acciones que cambian el servidor.
- Multimedia: YouTube fuera; URL y búsqueda por texto en fuentes compatibles sin cookies personales.
- Biblioteca: híbrida VPS + Drive; categorías por carpetas.
- Cooperacha exitosa: recompensa al grupo.
- Resumen escolar y lluvia de contenido: horarios configurables desde WhatsApp.
- Si Gemini bloquea una respuesta: negativa corta, sin reintentos en bucle.

### 14.2 Decisiones que resuelve el arquitecto por inspección o documentación vigente

| Decisión | Fase | Criterio |
|---|---|---|
| Modelos de Gemini y límites vigentes | 1 | Documentación oficial vigente. Solo el cupo gratuito que esté realmente disponible. |
| Búsqueda web gratuita | 1 | Opción compatible con costo cero y límites reales. |
| Formato de eventos de Evolution (LID, citas, menciones, administradores, invitaciones, expulsión, estados de conexión) | 0 | Capturar payloads reales y revisar la documentación de la versión instalada. |
| Postgres existente o contenedor propio | 0 | Inspeccionar el VPS. |
| Resolución verificable de `@lid` a identidad canónica | 0/1 | Solo si Evolution expone evidencia suficiente; nunca inferir por nombre. |
| Generación/obtención de enlace de invitación para ruleta | 3 | Verificar API real y permisos del bot. |
| Fuentes multimedia soportadas | 5 | Prueba real desde el VPS; sin cookies personales y YouTube excluido. |
| Voz TTS (Piper `es_MX` o alternativa gratuita) | 5 | Verificar disponibilidad y calidad. |
| Estrategia exacta de sincronización Drive ↔ biblioteca local | 6 | rclone, idempotencia y no duplicar/servir archivos incompletos. |
| Alcance de Tailscale desde el contenedor | 4 | Verificación práctica. |
| Imagen y estructura del contenedor de Minecraft | 4 | Inspección de solo lectura. |

### 14.3 Datos que se configuran cuando corresponda

No requieren cambiar la arquitectura:

- Nombre/id del grupo escolar y grupo de amigos.
- Foto real del horario escolar.
- Categorías reales de packs (se derivan de carpetas).
- Cuenta/remoto de Drive y ruta de la biblioteca.
- Tiempo de castigo de ruleta si se quiere cambiar de 15 min.
- Horarios concretos de resumen escolar y lluvia de contenido.
- Contenido/variantes de texto de `nuclear`, dentro de los límites definidos.

### 14.4 Observaciones

1. **Nivel sobre el saldo.** Es una decisión deliberada: gastar XP puede bajar el nivel.
2. **Inflación de XP.** Con +20 XP por mensaje en Hora Feliz y premios diarios altos, los precios pueden necesitar ajuste tras observar uso real. Se cambian en `config/product.ts`.
3. **Falsos positivos de activación.** «Ese bot está raro» activa a Botsky por la regla de palabra completa. Está aceptado.
4. **Privacidad del proveedor de IA.** Antes de producción se vuelve a verificar la política vigente del nivel gratuito utilizado y se informa al grupo si corresponde.
5. **Filtros de Gemini.** Se configura únicamente lo permitido por la API. Si una respuesta se bloquea, Botsky responde corto y no entra en bucles para forzarla.
6. **Oracle Free Tier.** Los respaldos importantes permanecen también fuera del VPS.
7. **Expulsar administradores.** El bot puede no tener capacidad de expulsar a un administrador o creador; en ese caso registra el warn y avisa, sin afirmar que lo expulsó.
8. **Fuentes multimedia cambian.** El soporte real se trata como capacidad comprobada, no como promesa permanente de una plataforma externa.

