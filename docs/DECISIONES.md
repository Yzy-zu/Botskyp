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

### CONTRADICCIÓN 2: Estado de Sesión e Instancia de Evolution API
- **Documentos:**
  - `docs/owner-answers.md` B8, C4: Evolution "Ya funciona" y número "Ya está vinculado a Evolution API".
  - `docs/PLAN_MAESTRO.md` §0 (fila WhatsApp): "Un solo número, prepago, desechable, ya vinculado a Evolution."
- **Entorno real observado:**
  - Los contenedores de Evolution están encendidos, pero en los logs (`docker logs evolution_api`) se registró que a las `17:43:36` del 15 de octubre de 2026 la sesión sufrió un `LOGOUT`, y a las `17:43:48` la instancia `botsky` fue `REMOVED`.
  - Actualmente `GET /instance/fetchInstances` retorna una lista vacía `[]`, y la tabla `Instance` de Postgres tiene 0 registros.
- **Conflicto:** Se asumía que la instancia ya estaba lista para capturar eventos de prueba y recibir mensajes en la Fase 0, pero actualmente no existe instancia activa vinculada en Evolution.
- **Recomendación y Mitigación:**
  - En estricto respeto a la Regla de Oro #3 y la instrucción de solo lectura, el arquitecto **no intervino** ni alteró Evolution.
  - Se reporta al dueño que, antes de iniciar las pruebas de la Fase 0 o la captura de fixtures reales, debe crear la instancia `botsky` y escanear el código QR desde el WhatsApp del bot.
  - Para el desarrollo del constructor en la Fase 0, el mock de Evolution y los tests unitarios podrán comenzar utilizando la estructura estandarizada de eventos de Evolution v2.3.7, mientras el dueño realiza la re-vinculación manual.

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
