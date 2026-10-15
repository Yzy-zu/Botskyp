# Botsky — Guía de arranque para el dueño

**Archivo:** `BOTSKY_GUIA_ARRANQUE.md`  
**Versión:** 2.3

Esta guía explica qué haces tú y qué hacen los agentes. El objetivo es que no tengas que programar ni copiar código manualmente.

---

## 1. Estado esperado antes de empezar

Necesitas:

- VPS de Oracle con Docker y Evolution funcionando.
- acceso SSH;
- repo privado de GitHub;
- carpeta `botsky/` clonada/inicializada en el VPS;
- grupo de pruebas con el bot como administrador;
- llave gratuita de Gemini lista para escribir directamente en `.env`;
- acceso a Antigravity y Codex CLI.

Si el repo y el primer commit ya existen, **no los vuelvas a crear**.

---

## 2. Archivos que deben quedar en el repo antes de soltar agentes

Estructura mínima:

```text
botsky/
├── AGENTS.md
└── docs/
    ├── PLAN_MAESTRO.md
    ├── owner-answers.md
    └── PROMPTS.md
```

Los siguientes los crea el arquitecto durante la preparación:

```text
docs/
├── DECISIONES.md
├── ENTORNO.md
├── INCIDENTES.md
├── ROADMAP.md
└── fases/
```

Correspondencia del paquete:

- `AGENTS.md` → raíz del repo.
- `BOTSKY_PLAN_MAESTRO.md` → `docs/PLAN_MAESTRO.md`.
- `Botsky_Cuestionario_Contestado.md` → `docs/owner-answers.md`.
- `BOTSKY_PROMPTS_AGENTES.md` → `docs/PROMPTS.md`.
- Esta guía es para ti; puede quedarse fuera o guardarse en `docs/GUIA_DUENO.md`.

No uses la v2.2 mezclada con la v2.3.

---

## 3. Quién entra primero

### Primero: Antigravity — arquitecto/inspector inicial

En la primera pasada no debe programar Botsky.

Su trabajo:

1. leer los documentos;
2. inspeccionar el VPS en solo lectura;
3. identificar cómo corre Evolution;
4. documentar Postgres, Docker, redes, Tailscale y repo;
5. crear `ENTORNO.md`, `ROADMAP.md`, `DECISIONES.md` e `INCIDENTES.md`;
6. hacer commit/push de esa preparación.

Usa el **Prompt A** de `docs/PROMPTS.md`.

### Después: Codex CLI — constructor de la Fase 0

Cuando el arquitecto termine la preparación, Codex recibe la Fase 0 y construye el esqueleto real.

No le pegues un mega-prompt inventado: dile que lea el repo y ejecute el bloque de Fase 0 de `docs/PROMPTS.md`.

### Más adelante

No hay una división rígida “Codex siempre hace X / Antigravity siempre Y”.

El arquitecto decide por fase según:

- dependencia;
- cambios en curso;
- disponibilidad/cuota;
- qué herramienta haya rendido mejor;
- si se puede paralelizar sin tocar los mismos archivos.

GitHub es el puente entre ambos.

---

## 4. Regla para que no se pisen

- Un agente por rama/worktree.
- Nunca dos agentes editando `main` a la vez.
- Antes de empezar una tarea, el agente lee `git status` y los documentos.
- Los cambios críticos se revisan antes de fusionar.
- Si algún agente encuentra cambios ajenos sin commit, se detiene sobre esos archivos y reporta el conflicto.

---

## 5. Tus pocas tareas manuales

### Grupo de pruebas

Crea/usa un grupo como `Botsky Lab`:

- bot como admin;
- tú;
- idealmente otra cuenta/persona voluntaria para juegos y prueba de expulsión/reingreso.

### Gemini

La clave se escribe directamente en el servidor cuando el agente la pida.

Nunca la pegues en ChatGPT, Antigravity, Codex ni GitHub.

### Fixtures de Evolution

Durante Fase 0 tendrás que mandar mensajes reales para que el constructor capture el formato de tu instalación:

- texto privado;
- texto en grupo;
- respuesta/cita;
- mención;
- audio;
- imagen;
- documento;
- los eventos de participantes/admins que la versión real exponga.

### Escuela

En Fase 2 podrás enviar una foto/captura de tu horario. El bot debe mostrar una vista previa y tú confirmas antes de que se guarde.

### Ruleta

Para probar la expulsión temporal hace falta una cuenta voluntaria que pueda salir y volver a entrar.

### Drive

Se configura cuando llegue el momento. No metas tokens de Drive al repo.

---

## 6. Flujo de fases

```text
Preparación del arquitecto
        ↓
Fase 0 — Esqueleto
        ↓
Fase 1 — Núcleo
        ↓
Fase 2 — Escuela
        ↓
Fase 3 — Economía y juegos
        ↓
Fase 4 — Minecraft
        ↓
Fase 5 — Multimedia/documentos
        ↓
Fase 6 — Biblioteca/packs/cooperacha
        ↓
Fase 7 — Mensajes/difusión/nuclear/Drive
        ↓
Fase 8 — Opcionales
```

El roadmap puede paralelizar tareas **solo después de que las dependencias estén listas**.

Por defecto, no paralelices Fase 0 ni Fase 1.

---

## 7. Cómo lanzar una fase

En una sesión nueva del constructor:

```text
Lee AGENTS.md, docs/PLAN_MAESTRO.md, docs/ENTORNO.md,
docs/DECISIONES.md y docs/ROADMAP.md.

Ejecuta la Fase N siguiendo la plantilla del constructor y el bloque
de Fase N en docs/PROMPTS.md.
```

No hace falta volver a pegar todos los documentos si el agente está trabajando dentro del repo y puede leerlos.

---

## 8. Qué recibes al final de cada fase

El agente debe dejar:

```text
docs/fases/FASE-N.md
docs/fases/FASE-N-PRUEBAS.md
```

Y darte un resumen corto.

`FASE-N-PRUEBAS.md` contiene mensajes concretos que tú pruebas en `Botsky Lab`.

Aunque el agente avance, **un módulo nuevo no se activa en los grupos reales hasta que tú lo hayas probado y lo actives**.

---

## 9. Comandos de dueño previstos en WhatsApp

Estos no dependen del LLM:

| Comando | Función |
|---|---|
| `bot activa <módulo> aquí` | Activa módulo en ese chat. |
| `bot desactiva <módulo> aquí` | Lo desactiva. |
| `bot módulos` | Lista módulos. |
| `bot apagado de emergencia` | Detiene respuestas/tools. |
| `bot reactiva` | Sale del apagado. |
| `bot mantenimiento on` / `off` | Modo mantenimiento. |

Los nombres finales deben quedar documentados por el constructor y mantenerse estables.

---

## 10. Decisiones ya cerradas que no debes volver a discutir con un agente

- Nivel = saldo actual / 20.
- Hora Feliz manual.
- Ruleta: 3 warns → expulsión temporal; 15 min por defecto, configurable; link de regreso por privado.
- `nuclear`: ráfaga de mensajes/menciones; no expulsa a todos.
- Cualquier miembro del grupo escolar puede subir tareas.
- Borrar/gestionar horario escolar: owner/admins.
- Horario escolar importable desde foto + confirmación.
- Miembros de grupos habilitados: privado autoaprobado.
- Minecraft: members leen estado/jugadores; owner controla.
- YouTube: fuera.
- Multimedia: URL y búsqueda por texto en fuentes comprobadas sin cookies personales.
- Packs: entrega privada.
- Biblioteca: VPS + Drive.
- Categorías de packs: carpetas.
- Cooperacha exitosa: recompensa al grupo.
- Resumen escolar y lluvia: horario configurable por WhatsApp.
- Si Gemini bloquea: respuesta corta; no bucles.

Si un agente intenta reabrir una de estas decisiones sin haber encontrado una imposibilidad técnica real, remítelo al Plan Maestro.

---

## 11. Si algo falla

No improvises borrados o reinstalaciones.

1. Si el bot aún responde, prueba `bot ping`.
2. Si no, revisa el estado general del VPS.
3. Abre una sesión de agente con el **Prompt de incidente** de `docs/PROMPTS.md`.
4. Si el problema empezó tras un despliegue, el agente debe priorizar rollback.
5. Si WhatsApp perdió la sesión, tú haces el paso manual de QR cuando el diagnóstico lo confirme.

---

## 12. Secretos

Nunca compartas:

- `GEMINI_API_KEY`;
- `EVOLUTION_APIKEY`;
- tokens OAuth/rclone;
- llaves SSH privadas;
- contraseñas;
- `.env`.

Sí puedes compartir llaves públicas SSH cuando haga falta.

Los agentes pueden indicar **dónde** escribir un secreto, pero no deben pedirte que se lo pegues en el chat.

---

## 13. Checklist inmediato

- [x] Carpeta `botsky/` creada en el VPS.
- [x] Repo inicializado y primer commit hecho.
- [ ] Copiar `AGENTS.md`.
- [ ] Crear `docs/`.
- [ ] Copiar `PLAN_MAESTRO.md`.
- [ ] Copiar `owner-answers.md`.
- [ ] Copiar `PROMPTS.md`.
- [ ] Commit + push del paquete v2.3.
- [ ] Crear/verificar `Botsky Lab`.
- [ ] Tener lista la API key gratuita de Gemini sin pegarla en chats.
- [ ] Lanzar Antigravity con el Prompt A.
- [ ] Revisar conmigo el reporte del arquitecto antes de soltar Fase 0.
