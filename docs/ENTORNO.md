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
- **Hallazgo crítico en logs de Evolution API:** A las `17:43:36` del 15 de octubre de 2026, la instancia `botsky` (WUID: `${BOT_JIDS}`) registró un evento `LOGOUT`, seguido a las `17:43:48` de `Instance "botsky" - REMOVED`.
- **Estado actual de instancias:**
  - La tabla `Instance` en `evolution_db` contiene 0 filas.
  - La consulta autenticada a `GET /instance/fetchInstances` retorna una lista vacía `[]`.
  - La base de datos Redis (`DB 1`) conserva 6 entradas de metadatos de grupos (`evolution:groups:*`) y una clave de protocolo Baileys previa.
- **Acción requerida:** El dueño debe crear nuevamente la instancia y re-vincular el número mediante código QR antes de que se inicien las pruebas reales de la Fase 0.

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
