# Botsky — Estado e Inspección del Entorno

**Fecha de inspección:** 15 de octubre de 2026  
**Rol responsable:** Arquitecto / Inspector Inicial  
**Modo:** Solo lectura (Read-Only)

Este documento detalla la infraestructura física, virtual, de red y de contenedores observada en el VPS de producción y sus nodos asociados en Tailscale.

---

## 1. Servidor Principal (VPS de Producción — `miroslav`)

### 1.1 Hardware y Sistema Operativo
- **Hostname:** `miroslav`
- **Proveedor:** Oracle Cloud Infrastructure (Always Free Tier)
- **Arquitectura CPU:** `aarch64` (ARM 64-bit, Neoverse-N1)
- **vCPU:** 1 vCPU en línea (`nproc` = 1, 1 socket, 1 thread)
- **Memoria RAM:** 5.8 GiB total (1.9 GiB en uso, 3.8 GiB buffer/cache, 3.9 GiB disponible)
- **Swap:** 4.0 GiB (1.1 GiB en uso, 2.9 GiB libre)
- **Almacenamiento:** Disco raíz `/dev/sda1` de 145 GB (31 GB ocupados, 114 GB libres, 22% de uso)
- **Sistema Operativo:** Ubuntu 26.04.1 LTS (resolute, kernel Linux `aarch64`)

> [!IMPORTANT]
> **Compatibilidad de Arquitectura:** Al tratarse de ARM64 (`aarch64`), todas las imágenes de Docker que se construyan o utilicen para Botsky (`botsky-app`, `botsky-worker`, `postgres`, etc.) deben compilarse o descargarse expresamente con soporte para `linux/arm64`.

### 1.2 Runtimes y Herramientas del Host
- **Docker:** Docker Engine version 29.9.0, build `f415da8`
- **Docker Compose:** v5.6.0 (plugin integrado `docker compose`)
- **Node.js (Host):** v20.20.2
- **npm (Host):** 10.8.2
- **Git:** v2.53.0
- **Tailscale:** v1.x (instalado en `/usr/bin/tailscale`)

---

## 2. Servicios y Contenedores Existentes

La inspección de contenedores (`docker ps -a`) detectó tres contenedores activos asociados a Evolution API, desplegados desde `/home/petrov/docker/evolution`:

| Contenedor | Imagen | Estado | Puertos / Red |
|---|---|---|---|
| `evolution_api` | `botsky/evolution-native-tables:2.3.7-c1` (build sobre Evolution API v2.3.7) | Up 3 días | `127.0.0.1:8080->8080/tcp` |
| `evolution_postgres` | `postgres:15-alpine` (PostgreSQL 15.19) | Up 5 días (healthy) | `5432/tcp` (solo interno) |
| `evolution_redis` | `redis:7-alpine` (Redis 7) | Up 5 días (healthy) | `6379/tcp` (solo interno) |

### 2.1 Despliegue de Evolution API
- **Ruta del compose:** `/home/petrov/docker/evolution/docker-compose.yml` con `docker-compose.override.yml`.
- **Versión de Evolution API:** 2.3.7 (`clientName: evolution_v2`, versión WhatsApp Web: `2.3000.1050509545`).
- **Endpoint local:** `http://127.0.0.1:8080/` (responde HTTP 200 OK con mensaje de bienvenida).
- **Límites de recursos de Evolution:**
  - `evolution_api`: 0.4 vCPU, 768 MB RAM (reserva: 256 MB).
  - `evolution_postgres`: 0.2 vCPU, 512 MB RAM.
  - `evolution_redis`: 0.1 vCPU, 256 MB RAM.
- **Red Docker:** `evolution_evolution_net` (Driver bridge, subred interna `172.18.0.0/16`).
  - IP `evolution_api`: `172.18.0.4`
  - IP `evolution_postgres`: `172.18.0.2`
  - IP `evolution_redis`: `172.18.0.3`
- **Volúmenes:**
  - `evolution_evolution_instances` (`/var/lib/docker/volumes/evolution_evolution_instances/_data`)
  - `evolution_evolution_store` (`/var/lib/docker/volumes/evolution_evolution_store/_data`)
  - `evolution_postgres_data` (`/var/lib/docker/volumes/evolution_postgres_data/_data`)
  - `evolution_redis_data` (`/var/lib/docker/volumes/evolution_redis_data/_data`)

### 2.2 Estado de la Conexión de WhatsApp en Evolution
- **Estado de la instancia:** La instancia `botsky` fue recreada exitosamente por el dueño y su sesión se encuentra **abierta y conectada** (`connectionStatus: "open"`).
- **Identidad del bot en WhatsApp:**
  - `ownerJid`: `${BOT_JIDS}`
  - `lid`: `${BOT_JIDS}`
  - Nombre de perfil: `Botsky`
- **Grupo oficial de pruebas (`Botsky Lab`):**
  - **JID del grupo:** `${LAB_CHAT_ID}`
  - **Nombre:** `Botsky Lab`
  - **Visibilidad:** Verificado y accesible desde Evolution API (`group/fetchAllGroups` y `group/findGroupInfos`).
  - **Rol del bot:** Participante verificado con privilegios de administrador (`admin: "admin"`).
  - **Rol del dueño:** Participante verificado como creador y administrador (`admin: "superadmin"`).
- **Acceso a Evolution Manager por Tailscale:** Tailscale Serve activo en `https://miroslav.mora-krait.ts.net/manager` (proxy hacia `http://127.0.0.1:8080`).

---

## 3. Análisis de Reutilización de Bases de Datos y Caché

### 3.1 PostgreSQL
- **Existente:** `evolution_postgres` (PostgreSQL 15.19 en Alpine).
- **Bases de datos existentes:** `evolution_db`, `postgres`, `template0`, `template1`.
- **Exposición:** Solo dentro de `evolution_evolution_net`, sin puerto mapeado al host.
- **Límites:** Contenedor restringido a 512 MB de RAM y 0.2 CPU.
- **Decisión arquitectónica:**
  - Aunque técnicamente se podría crear una base `botsky_db` dentro de `evolution_postgres`, esto violaría el principio de aislamiento estricto de Evolution (Regla de Oro #3: "Evolution existente se trata como producción. No borres, reinstales, desvincules ni cambies su base de datos").
  - Además, la especificación de Botsky requiere **PostgreSQL 17** (con extensiones y optimizaciones para `FOR UPDATE SKIP LOCKED`).
  - El VPS cuenta con 3.9 GiB de memoria RAM libre. Un contenedor dedicado `botsky_postgres` (`postgres:17-alpine`) consumirá ~120-150 MB y garantizará respaldos (`pg_dump`), migraciones y reinicios independientes sin ningún riesgo de desestabilizar Evolution.

### 3.2 Redis
- **Existente:** `evolution_redis` (Redis 7 en Alpine).
- **Uso actual:** Exclusivo para la caché de sesiones de Baileys de Evolution API en la base de datos `1`.
- **Decisión arquitectónica:**
  - El Plan Maestro (§4 Stack) establece taxativamente: **"Cola de jobs: Tabla jobs con FOR UPDATE SKIP LOCKED. Sin Redis."**
  - Botsky **no utilizará Redis** para su lógica, colas ni estado. Por lo tanto, no se reutilizará ni modificará `evolution_redis`.

---

## 4. Redes, Tailscale y Otros Servidores

### 4.1 Red Tailscale Local
- **IP Tailscale de este VPS (`miroslav`):** `100.109.237.37`
- **Estado:** Activo y conectado a la tailnet del dueño.

### 4.2 Nodos Identificados en Tailscale

| Hostname | IP Tailscale | Sistema | Estado y Conectividad | Propósito / Rol |
|---|---|---|---|---|
| `redspi` | `100.104.54.2` | Linux (`aarch64`) | Activo (ping directo: ~1 ms). SSH operativo por puerto 22. | **VPS de Minecraft Bedrock**. Contenedor Docker `mc-bedrock` (`itzg/minecraft-bedrock-server:latest`, Up 12h, healthy). |
| `tsar` | `100.91.182.62` | Linux | Activo (ping directo: ~13 ms). Puerto 22 cerrado/rechazado. | Nodo en la tailnet. Posible VPS adicional. |
| `jssi-1` | `100.104.132.70` | Linux | Activo vía relay DERP (~52 ms). Puerto 22 abierto con SSH. | Candidato a **VPS de pruebas** si el dueño lo habilita. |
| `jssi` | `100.92.7.72` | Linux | Inactivo / Offline (última vez visto hace 4 días). | Equipo auxiliar. |
| Dispositivos móviles | Varios | Android | En reposo / offline (`camera`, `oppo-reno7-1`, `sputnik`, etc.). | Dispositivos personales. |

### 4.3 Verificación de Conectividad con Minecraft (`redspi`)
- La máquina `redspi` responde de forma inmediata (~1 ms) por Tailscale.
- La clave SSH `~/.ssh/id_ed25519` del usuario `petrov` ya tiene acceso autorizado a `redspi`.
- Se confirmó en solo lectura la presencia del contenedor `mc-bedrock` ejecutando la imagen oficial `itzg/minecraft-bedrock-server:latest`.
- En la Fase 4 se configurará el acceso restringido (`mc-ctl.sh` y comando forzado) con una llave dedicada para Botsky, tal como exige el Plan Maestro §9.13.

---

## 5. Flujo de Trabajo Seguro de los Agentes por SSH

Para garantizar que múltiples agentes o sesiones no colisionen ni expongan información confidencial:

### 5.1 Identidad y Acceso al VPS
- **Usuario del sistema:** `petrov`
- **Autenticación SSH:** Exclusivamente por par de llaves públicas (`~/.ssh/authorized_keys`). Sin contraseñas interactivas.
- **Privilegios:** `sudo` sin contraseña habilitado para administración de Docker y servicios locales.
- **Ruta de trabajo:** `/home/petrov/botsky` (propietario `petrov:petrov`).

### 5.2 Control de Versiones y Repositorio Git
- **Remoto Git:** `git@github.com:Yzy-zu/Botskyp.git`
- **Autenticación con GitHub:** Llave SSH `~/.ssh/id_ed25519` verificada exitosamente (`Hi Yzy-zu! You've successfully authenticated...`).
- **Estado compartido:** `git` en GitHub es la única fuente de verdad entre agentes.
- **Ramas y Worktrees:**
  - Cada fase o tarea se desarrolla en una rama propia: `phase-N-nombre`.
  - Si dos agentes trabajan simultáneamente, deben utilizar `git worktree` o ramas estrictamente separadas; **nunca dos agentes editando la misma rama o directorio de trabajo**.
  - Antes de iniciar cualquier tarea: `git status`, actualizar rama base y revisar documentos de control.

### 5.3 Gestión Segura de Secretos y `.env`
1. **Archivo `.env`:** Permisos restringidos a `600` (`chmod 600 .env`) propiedad de `petrov:petrov`.
2. **Exclusión de Git:** `.env` está expresamente incluido en `.gitignore` para prevenir commits accidentales.
3. **Inyección de secretos:** Los agentes nunca deben solicitar que el dueño pegue tokens, passwords o llaves en las ventanas de chat. El agente generará plantillas `.env.example` y el dueño (o un script seguro local) colocará las credenciales reales directamente en el archivo en el VPS.
4. **Logs y trazas:** Se prohíbe imprimir variables de entorno completas en la terminal o scripts de diagnóstico.

### 5.4 Comandos Estándar del Proyecto (Fase 0 en adelante)
```bash
npm run dev          # Desarrollo local con recarga en caliente
npm run typecheck    # Verificación de tipos TypeScript estricto
npm run lint         # Análisis estático de código
npm test             # Ejecución de suite de pruebas con Vitest
npm run migrate      # Ejecución de migraciones SQL
scripts/deploy.sh    # Despliegue con respaldo previo, healthcheck y rollback automático
scripts/backup.sh    # Respaldo de base de datos con pg_dump
scripts/panic.sh     # Apagado de emergencia inmediato desde consola
```

## 6. Ejecución parcial de Fase 0 (constructor, 16/10/2026)

- Rama de trabajo: `phase-0-esqueleto`; todavía sin fusionar ni cerrar la fase.
- Servicios propios: `botsky-app`, `botsky-worker`, `botsky-postgres-1` y capturador
  diagnóstico `botsky-capture`. PostgreSQL 17 propio; volumen `botsky_botsky_pgdata`.
- Red privada `botsky_internal`, alias de base exclusivo `botsky-db`. El alias
  genérico `postgres` es ambiguo al compartir red con Evolution y no debe utilizarse.
- App y worker usan Node 24 ARM64. Para comandos locales:
  `export PATH="$PWD/.local/node/bin:$PATH"` (Node 24 verificado, sin cambiar el host).
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` desde el repo.
  Los tests crean una BD con prefijo `botsky_test_`; nunca reinician tablas de producción.
- `npm run migrate` usa la imagen/configuración del último despliegue sano.
- `npm run dev` carga `.env`; usar solo un entorno de desarrollo con proveedor mock
  y BD/puerto propios. No ejecutarlo sobre el `.env` de producción. Los nombres
  Docker de la BD son resolubles dentro de las redes correspondientes.
- Despliegues únicamente con `scripts/deploy.sh`; para esta ejecución pendiente
  de fixtures se usó `TRANSPORT=mock scripts/deploy.sh`.
- Estado completo, pruebas y límites en `docs/fases/FASE-0.md` y
  `docs/fases/FASE-0-PRUEBAS.md`. `/health` mock no acredita conexión de WhatsApp.
- Capturador: webhook `http://botsky-capture:3001/webhook`, secreto en cabecera,
  limitado al laboratorio/privado del dueño y sin bytes o claves multimedia.
  Configuración anterior y credenciales solo bajo `.local/` y `.env` (600).
- No hay `rclone` instalado ni remoto Drive confirmado. Respaldos locales verificados;
  quedan pendientes copia externa, retención y restauración en otro VPS autorizado.

### 6.1 Actualización tras capturas y comprobación real

- Adaptador y normalizador reales desplegados; instancia `botsky` sigue `open`.
- El dueño confirmó `bot ping` → `pong` en Botsky Lab; tres respuestas adicionales
  de diagnóstico sobrevivieron al reinicio de la app, una entrega por cita.
- Webhook final: `http://botsky-app:3000/webhook`, secreto en cabecera. Capturador
  detenido; no hay puerto diagnóstico publicado ni excepción temporal de firewall.
- `/health` ahora devuelve `transport=evolution`, `database=true`, `evolution=true`.
- Fixtures originales y procedencia en `tests/fixtures`; 61 pruebas automáticas.
- Sigue pendiente revisión del arquitecto y copia/restauración externa. SSH al
  candidato `jssi-1` se rechazó por clave de host desconocida; no se aceptó sin verificar.

## 8. Evidencia de despliegue de Fase 1 (constructor, 16-10-2026)

- Rama `phase-1-nucleo`, código desplegado `218b38e`, sin fusión a `main`.
- Script oficial ejecutado con respaldo previo; migraciones `001_init.sql` y
  `002_core.sql` presentes en la base propia. App y worker saludables.
- `/health` HTTP 200 con base y conexión real de Evolution en verde.
- Gemini principal `gemini-3.5-flash-lite`; clave primaria local recuperada con
  autorización del dueño y confirmación de proyecto sin facturación. El `.env`
  heredado y el activo son locales, ignorados por Git y con permisos 600.
- SearXNG `2026.10.16-ff8f5ddcc`, contenedor `botsky-searxng-1`, ARM64, sin puertos
  publicados, 256 MiB / 0.20 CPU, red de salida propia y acceso por la red interna.
  Firma con secreto propio (`SEARXNG_SECRET`) generado localmente, distinto al webhook.
- API JSON de búsqueda comprobada desde app: cinco enlaces para PostgreSQL.
- Cero grupos habilitados fuera de Botsky Lab. El dueño confirmó nota y programación
  con aclaración de fecha en WhatsApp. Entrega tras reinicio y demás pruebas físicas pendientes.
- Node local 24 sigue en `.local/node/bin`; no se sustituyó el Node del sistema.
- Guía y evidencia: `docs/fases/FASE-1.md`, `docs/fases/FASE-1-PRUEBAS.md` y DEC-019–022.


## 9. Revisión de pruebas manuales de Fase 1 (16-10-2026)

- Código final de correcciones: `90a63a3`, desplegado por el script oficial con
  respaldo previo. Rama `phase-1-nucleo` solamente; la documentación posterior no
  cambia la imagen de código desplegada.
- Base propia con `001_init.sql`, `002_core.sql`, `003_llm_reservations.sql`.
  La migración nueva solo añade reserva de tokens; no modifica datos de usuario.
- `/health` HTTP 200 con base y Evolution conectados; app, worker y SearXNG saludables.
- Nueve solicitudes de esta ronda auditadas contra historial del proveedor. Nota #1,
  aclaración/fecha de recordatorio #1, entrega de #2 con 1,139310 s de retraso,
  búsqueda y visión correctas. La entrega de #2 no incluyó un reinicio intermedio.
- Corregidos exceso de reserva TPM, diagnóstico de timeout/límite local, contenido
  faltante del recordatorio y resolución de imágenes citadas del mismo chat.
- Typecheck, lint, build y 127 tests correctos. Dos integraciones de imagen con
  proveedor real en base aislada; la cita respondió en 1266 ms sin envíos a WhatsApp.
- Se conserva el estado histórico de notas/recordatorios y cero grupos habilitados
  fuera de Lab. Evolution no se modificó ni reinició.
- Evidencia detallada, fallos y pendientes: `docs/fases/FASE-1-PRUEBAS.md`, DEC-023–025
  e INC-20261016-05. Pendiente repetición física de correcciones y revisión del arquitecto.


## 10. Segunda revisión manual de Fase 1 (16-10-2026)

- Tres solicitudes nuevas, 03:35–03:36 UTC, auditadas por ID y texto contra Evolution.
  Visión y entregas sin duplicación; búsquedas fallidas por contexto/intención.
- Corrección DEC-026 e INC-20261016-06: consultas completas sin IA y referencias con
  contexto del mismo actor/chat, conservación del objetivo y tool web exclusivamente.
- Typecheck, lint, build y 140 tests en 14 archivos correctos. Integración real
  Gemini/SearXNG en base aislada: consultas pertinentes en 1747/2328 ms, cero envíos.
- Sin migraciones o servicios nuevos; no se cambian datos ni activaciones de grupos.
- Estado físico y pendientes en `docs/fases/FASE-1-PRUEBAS.md`. La corrección requiere
  repetición física; no sustituye la revisión del arquitecto ni autoriza Fase 2.
- Despliegue final de código **`f56dbc1`** por script oficial, respaldo verificado
  y `/health` HTTP 200 a las 03:48 UTC. App/worker/SearXNG saludables; base y
  Evolution conectados. Sin errores nuevos de arranque, sin cambios a Evolution.
  Notas/recordatorios conservan sus campos auditados; cero grupos activos fuera de
  Lab. Los commits documentales posteriores no cambian esa imagen desplegada.

## 11. Corrección de utilidad visual y contexto de búsqueda (16-10-2026)

- Código **`38163f2`**, desplegado únicamente desde `phase-1-nucleo` por
  `scripts/deploy.sh`, con respaldo previo verificado. Sin migraciones nuevas.
- DEC-027: contenido/uncertidumbre antes de la burla; preguntas breves de raza
  reutilizan la última imagen propia del mismo chat, máximo diez minutos.
- DEC-028: una petición segura conserva su contexto aunque la respuesta con enlaces
  sea filtrada. Los filtros de datos sensibles y los ámbitos siguen vigentes.
- Typecheck, lint, build y **153 tests** correctos. Gemini real confirmó utilidad
  visual e incertidumbre; dos búsquedas posteriores con persistencia de contexto
  usaron Gemini/SearXNG reales, 4349/4132 ms. Cero envíos desde las bases aisladas.
- `/health` HTTP 200 a las **10:20 UTC**, base y Evolution conectados; app/worker
  con la imagen esperada y saludables, sin advertencias/errores nuevos de arranque.
- Notas y recordatorios idénticos al snapshot previo; cero grupos habilitados
  fuera de Lab. Evolution no se reinició ni modificó. La documentación posterior
  no cambia el código de la imagen desplegada.
- Todas las pruebas físicas adicionales pendientes de Fase 1 omitidas voluntariamente
  por el dueño (DEC-030), incluido recordatorio con reinicio físico. La evidencia
  automática/integración existente es suficiente para cierre y se conserva su
  cobertura. Fase 1 lista para cierre; siguiente paso: revisión del arquitecto,
  sin merge a `main` ni Fase 2. No se afirma ejecución física de las pruebas omitidas.

## 12. Fase 4 — inspección y acceso restringido a redspi (16-10-2026)

- Base autorizada `27572701d231ff17fa5fba886bd82880b92fe91f`; rama
  `phase-4-minecraft`, sin merge ni Fase 5. Fases 0–3 cerradas según el dueño.
- Redspi `100.104.54.2`: SSH puerto 22 con host key ya verificada en known_hosts.
  Imagen real `itzg/minecraft-bedrock-server:latest`, ID
  `sha256:e4a2e3cbbf9b02af56aef962af85a1462a94f39b3063048ae33b0598b3e84c6c`.
  Contenedor `mc-bedrock`, arranque observado `2026-10-16T10:00:02.624472706Z`.
- Datos autoritativos bind `/home/petrov/docker/minecraft/data` → `/data`.
  Ocho carpetas de mundos, unos 16 MiB al inspeccionar; behavior/resource packs
  presentes. Existe además `backup_peppa_mod`; no se modifica ninguna copia previa.
- Consola real `/usr/local/bin/send-command`, proceso Bedrock sobre box64 en ARM64.
  Escribe stdin sin confirmación. `mc-monitor status-bedrock --host 127.0.0.1`
  responde versión `1.26.52`, conteo y máximo actuales. Uptime es del contenedor.
- Red actual de app alcanza redspi:22 desde dentro del contenedor; sin modificar
  redes de Evolution, sin network_mode host ni sidecar Tailscale.
- Cuenta nueva `botsky-mc`, home root-owned `/var/lib/botsky-mc`, sin docker group.
  Llave Ed25519 dedicada local en `.local/minecraft` (privada 600, directorio 700,
  UID/GID 1000 para node del contenedor). App monta únicamente esa carpeta read-only;
  worker no recibe la llave. Ninguna clave personal se monta en Botsky.
- Authorized_keys root-owned con `from="100.109.237.37",restrict,command="/opt/botsky/mc-ctl.sh"`.
  `ForceCommand` adicional para la cuenta en `/etc/ssh/sshd_config.d/60-botsky-minecraft.conf`;
  solo publickey, sin PTY, agent/TCP/X11 forwarding ni user rc. AllowUsers conserva
  petrov y agrega solo botsky-mc desde la IP de miroslav. `sshd -t` validado antes
  del reload. Acceso petrov comprobado después; no se reinicia Minecraft.
- `/opt/botsky/mc-ctl.sh` y `mc-control.py`: root 755. Sudoers root 440 permite
  únicamente ejecutar ese Python fijo con protocolo validado; nunca Docker libre.
  Recibos/lock/copias en `/var/lib/botsky-minecraft`, root 700. Backup offline
  únicamente, conservado en `backups/<UUID>.tar`; sin rotación/borrado automático.
- Configuración local `MINECRAFT_ENABLED`; secretos solo locales. El pin se copió
  del known_hosts existente tras comprobar acceso con StrictHostKeyChecking=yes.
  Una rotación exige verificar la nueva huella por un canal confiable antes de
  reemplazar el pin; el bot falla cerrado si cambia. Nunca se usa ssh-keyscan
  como prueba de autenticidad ni se desactiva la comprobación de host.
- Consultas directas de inspección por la cuenta restringida: status, players,
  config-get, worlds, addons, resources y logs respondieron código ok. `id` fue
  rechazado con exit 64 por el comando forzado. Sin acciones administrativas de
  juego, sin mensajes WhatsApp, sin parar/reiniciar el servidor real.
- El contenedor fija DIFFICULTY, GAMEMODE y MAX_PLAYERS; config-set de esas claves
  se rechaza para evitar una edición revertida al arrancar. Pvp/allow-cheats solo
  si no están dominadas por env. Detalles y provisión reproducible en
  `scripts/minecraft/` y `docs/fases/FASE-4.md`.

### 12.1 Despliegue verificado de Fase 4

Código `49a3f14`, rama `phase-4-minecraft`, mediante el script oficial y respaldo
verificado `botsky-20261016T162347-2032949.dump`. App/worker healthy y `/health`
HTTP 200 con base/Evolution conectados, ~16:25 UTC. Migraciones 001–006 presentes.
Minecraft habilitado técnicamente en app únicamente; key mount read-only probado
con status/players reales y rechazo de `id`. Worker sin llave ni flag habilitado.
Evolution y Minecraft conservan tiempos de arranque; cero operaciones administrativas
reales y cero grupos habilitados fuera de Lab. 360/360 pruebas y 14/14 del wrapper;
pruebas físicas de control/restauración pendientes. Sin merge ni Fase 5.
