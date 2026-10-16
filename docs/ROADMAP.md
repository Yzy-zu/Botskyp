# Botsky — Roadmap de Desarrollo y Asignación de Tareas

**Archivo:** `docs/ROADMAP.md`  
**Versión:** 2.3  
**Rol responsable:** Arquitecto / Revisor  
**Fuente de verdad:** `docs/PLAN_MAESTRO.md` §3 y `AGENTS.md`

Este documento define las dependencias entre fases, la estrategia de paralelización segura, las tareas críticas que exigen revisión del arquitecto y los perfiles recomendados para los agentes constructores.

---

## 1. Grafo de Dependencias entre Fases

```mermaid
flowchart TD
    prep["Preparación Arquitecto<br/>(Completada)"] --> f0["Fase 0: Esqueleto y Despliegue<br/>(Compose, BD propia, Webhook, Outbox, Mock)"]
    f0 --> f1["Fase 1: Núcleo y Conversación<br/>(Router, LLM, Tools, Sesiones, Notas, Recordatorios)"]
    
    f1 --> f2["Fase 2: Escuela<br/>(Horarios, Tareas, Visión)"]
    f1 --> f3["Fase 3: Economía y Juegos<br/>(Aprobada · lista para cierre)"]
    f1 --> f4["Fase 4: Minecraft<br/>(SSH Bedrock, Tailscale, mc-ctl)"]
    f1 --> f5["Fase 5: Multimedia y Worker<br/>(ffmpeg, PDF, OCR, Jobs)"]
    
    f3 --> f6["Fase 6: Biblioteca, Packs y Cooperacha<br/>(Drive, Sincronización, Cooperacha grupal)"]
    f5 --> f6
    
    f1 --> f7["Fase 7: Mensajes Masivos y Nuclear<br/>(Difusión, Nuclear, Outbox masivo)"]
    f5 --> f7
    
    f2 --> f8["Fase 8: Módulos Opcionales<br/>(Encuestas, Lore, Afinidad, Reacciones)"]
    f3 --> f8
    f6 --> f8
    f7 --> f8

    classDef critical fill:#f96,stroke:#333,stroke-width:2px;
    class f0,f1,f3,f4,f6,f7 critical;
```

---

## 2. Matriz de Fases y Asignación de Roles

| Fase | Título | Dependencias | ¿Paralelizable? | Cambio Crítico | Perfil / Rol de Agente Recomendado |
|---|---|---|---|:---:|---|
| **0** | **Esqueleto y Despliegue** | Preparación arquitecto | **NO** | **SÍ** | Constructor Backend / Infraestructura Docker & SQL |
| **1** | **Núcleo y Conversación** | Fase 0 en verde | **NO** | **SÍ** | Constructor Arquitectura de Software & LLM |
| **2** | **Escuela** | Fase 1 | **SÍ** (con Fase 3, 4 o 5) | No | Constructor Lógica de Negocio & Visión |
| **3** | **Economía y Juegos** | Fase 1 | **SÍ** (con Fase 2 o 4) | **SÍ** | Constructor Transaccional & Algoritmos Puros |
| **4** | **Minecraft** | Fase 1 | **SÍ** (con Fase 2 o 3) | **SÍ** | Constructor Infraestructura & Seguridad Shell/SSH |
| **5** | **Multimedia y Documentos** | Fase 1 | **SÍ** (con Fase 2, 3 o 4) | Parcial | Constructor Procesamiento de Medios & Worker |
| **6** | **Biblioteca, Packs y Cooperacha** | Fases 3 y 5 | **SÍ** (con Fase 4 o 7) | **SÍ** | Constructor Fullstack Transaccional |
| **7** | **Mensajes, Difusión y Nuclear** | Fases 1 y 5 | **SÍ** (con Fase 4 o 6) | **SÍ** | Constructor Resiliencia de Red & Operaciones Masivas |
| **8** | **Módulos Opcionales** | Fases previas según módulo | **SÍ** (módulo a módulo) | Parcial | Constructor Extensiones & Comunidad |

---

## 3. Condiciones Estrictas para Paralelización

De acuerdo con `AGENTS.md` §3, la paralelización entre agentes solo está permitida bajo las siguientes reglas:

1. **Fase 0 y Fase 1 son estrictamente secuenciales:**
   - La Fase 0 sienta la base del sistema operativo, webhook, base de datos y scripts de despliegue.
   - La Fase 1 implementa el contrato de `Tool`, el router principal y el sistema de sesiones que todos los demás módulos consumen.
   - **Bajo ninguna circunstancia se deben abrir constructores en paralelo durante las Fases 0 y 1.**
2. **Aislamiento por Rama o Worktree:**
   - Cada constructor debe trabajar en su propia rama (`phase-N-nombre`) o en un directorio `git worktree` aislado.
   - **Nunca** dos agentes deben modificar la rama `main` o un mismo archivo simultáneamente.
3. **Frentes de Trabajo Paralelos Permitidos tras la Fase 1:**
   - **Paralelo A:** Fase 2 (Escuela) y Fase 3 (Economía y Juegos). No comparten esquemas SQL ni herramientas; Escuela reside en `src/modules/school/` y Economía en `src/modules/xp/` y `src/modules/games/`.
   - **Paralelo B:** Fase 4 (Minecraft) y Fase 5 (Multimedia). Minecraft es puramente infraestructura de red externa (`src/modules/minecraft/`), mientras que Multimedia se concentra en el proceso `worker.ts` y conversiones locales en `src/modules/media/`.
4. **Reconciliación y Merge:**
   - Cada rama que termine debe ejecutar `typecheck`, `lint`, suite de tests y verificar el healthcheck antes de solicitar merge.
   - Si se presenta un conflicto de merge o colisión de migraciones SQL, la tarea vuelve al arquitecto para ordenamiento antes de tocar `main`.

---

## 4. Cambios Críticos que Requieren Revisión Obligatoria del Arquitecto

Antes de fusionar una rama a `main`, el agente debe solicitar la revisión del arquitecto (utilizando el **Prompt de Revisor** de `docs/PROMPTS.md`) en los siguientes casos:

1. **Infraestructura y Despliegue:**
   - Modificaciones a `scripts/deploy.sh`, scripts de respaldo o rollback.
   - Cambios en el `docker-compose.yml` que involucren redes de Evolution o variables sensibles.
2. **Identidad, Permisos y Resolución de Identidades:**
   - Cambios en `core/permissions.ts`, resolución de JIDs canónicos o asociación de identidades `@lid`.
3. **Flujo de Mensajería y Fiabilidad:**
   - Cambios al contrato de `Tool`, router principal, normalización o sistema de sesiones.
   - Deduplicación (`seen_events`), outbox y reconciliación de mensajes inciertos.
4. **Economía y Dinero Comunitario:**
   - Reglas de balance de XP, transacciones del `xp_ledger`, apuestas de blackjack y ruleta.
   - Mecanismo de expulsión temporal (`roulette_kick`) y enlace privado de reinvitación (`roulette_reinvite`).
   - Retenciones y devoluciones de la cooperacha.
5. **Infraestructura Externa y Shell:**
   - Acceso SSH a Minecraft en `redspi`, script `mc-ctl.sh` y comando forzado en `authorized_keys`.
   - Modificaciones a la ejecución segura de comandos externos (`execFile` con argumentos separados).
6. **Operaciones Masivas y Alto Riesgo:**
   - Campañas de difusión y operación `nuclear` (ritmo controlado, vista previa obligatoria y confirmaciones ligadas).
   - Sincronización bidireccional entre Google Drive y la biblioteca local del VPS.

---

## 5. Estrategia de Asignación de Agentes por Capacidad

En lugar de atar rígidamente herramientas específicas (como Antigravity o Codex) a fases inamovibles, la asignación de agentes debe basarse en el tipo de tarea y el contexto del entorno:

### 5.1 Perfil: Arquitecto / Revisor
- **Enfoque:** Visión global, coherencia arquitectónica, resolución de contradicciones, auditoría de seguridad y revisión de cambios críticos.
- **Responsabilidad:** Mantenimiento de `ENTORNO.md`, `DECISIONES.md`, `ROADMAP.md` e `INCIDENTES.md`. Aprobación o rechazo de PRs críticos.
- **Modo de operación:** Generalmente en solo lectura para inspección, o edición de documentación de control. No implementa código de negocio.

### 5.2 Perfil: Constructor de Backend e Infraestructura (Fase 0, 4)
- **Enfoque:** Docker Compose, configuración de redes internas, cliente PostgreSQL, migraciones SQL puras, scripts de automatización Bash (`deploy.sh`, `backup.sh`, `panic.sh`), integración SSH y Tailscale.
- **Habilidades clave:** Rigor en validación de variables de entorno, manejo de errores de sistema y scripts idempotentes.

### 5.3 Perfil: Constructor de Arquitectura y Lógica Central (Fase 1)
- **Enfoque:** Modelado de tipos TypeScript estricto, Zod schemas, diseño del pipeline de mensajes, router determinista vs. LLM, integración con Gemini API, control de cuotas y personalidad (`persona.md`).
- **Habilidades clave:** Diseño limpio de interfaces, decoupling y control de contexto de LLM.

### 5.4 Perfil: Constructor de Negocio y Transaccional (Fase 2, 3, 6)
- **Enfoque:** Lógica determinista, transacciones de base de datos (`BEGIN...COMMIT`), máquinas de estados para juegos por turnos, Fisher-Yates, cálculos de rachas y retenciones.
- **Habilidades clave:** Diseño de tests exhaustivos para condiciones de carrera y límites numéricos.

### 5.5 Perfil: Constructor de Procesamiento y Resiliencia (Fase 5, 7, 8)
- **Enfoque:** Colas de procesamiento asíncrono con `SKIP LOCKED`, integración de herramientas CLI (`ffmpeg`, `pdftoppm`, `tesseract`), outbox con backoff exponencial, ritmo de mensajería masiva con jitter.
- **Habilidades clave:** Gestión de memoria de procesos, timeouts seguros y manejo de fallos transitorios.

---

## 6. Estado y siguiente paso inmediato

Las **Fases 0, 1 y 2 están cerradas y fusionadas a `main`**, según la confirmación
del dueño. La base de Fase 3 es `6566f21fd631ea08886f56267e985c9e00d8e476`.

La **Fase 3 — Economía y Juegos está aprobada por el arquitecto y lista para
cierre técnico**, sin correcciones de código requeridas. El dueño comunicó la
aprobación el 16-10-2026; se registra en DEC-038. Está implementada y desplegada
desde `f656b1c`, exclusivamente en la rama `phase-3-economia-juegos`.

La evidencia automática y de integración existente es suficiente para cerrar
técnicamente la fase. La prueba física de expulsión/enlace/reingreso en Botsky Lab
es **recomendable, opcional y no bloqueante**. Las pruebas físicas conservan su
estado de no ejecutadas, sin afirmar éxitos externos. Se mantienen todos los tests,
fixtures y cobertura; la secuencia voluntaria sigue en `docs/fases/FASE-3-PRUEBAS.md`.

El siguiente paso autorizado se limita a registrar esta aprobación y verificar
typecheck, lint, tests, build y `/health`. **No se fusiona a `main`, no se inicia
Fase 4 ni se activan módulos fuera de Lab.** Tras commit y push de la documentación
a `phase-3-economia-juegos`, el constructor se detiene sin esperar pruebas físicas.
Las reglas generales de dependencias y revisión de cambios críticos siguen vigentes.
