# AGENTS.md — Reglas para los agentes de IA del proyecto Botsky

Léelo completo al inicio de cada sesión. Aplica a arquitectos/revisores y constructores.

## 1. Qué es Botsky y qué documentos mandan

Botsky es un bot de WhatsApp en español de México para el dueño y sus amigos. Corre en un VPS de Oracle junto a Evolution API.

El dueño delega la programación y valida principalmente probando en WhatsApp.

Orden de autoridad:

1. Instrucciones directas del dueño en la sesión.
2. `docs/PLAN_MAESTRO.md`: fuente de verdad de producto, arquitectura y reglas de negocio. Su §0 prevalece sobre el resto.
3. Este archivo.
4. `docs/owner-answers.md`.
5. `docs/DECISIONES.md`: decisiones técnicas tomadas durante la ejecución.
6. Tu criterio, solo donde lo anterior calla.

Si hay contradicción, no implementes dos interpretaciones. Aplica la de mayor autoridad. Si la contradicción está dentro del propio Plan Maestro, el arquitecto la resuelve, actualiza primero el plan y registra el cambio en `docs/DECISIONES.md`.

## 2. Roles de agente

### Arquitecto/revisor

- Mantiene coherencia entre plan, entorno, decisiones y código.
- Hace la preparación inicial del repositorio y la inspección del entorno en solo lectura.
- Mantiene `docs/ENTORNO.md`, `docs/ROADMAP.md` y `docs/DECISIONES.md`.
- Decide qué fase puede ejecutar cada constructor y cuándo se puede paralelizar.
- Revisa cambios críticos antes de fusionarlos.
- No implementa funcionalidad normal salvo que el dueño lo ordene.

### Constructor

- Implementa una fase o tarea concreta.
- Trabaja siempre desde una rama o worktree propio.
- Ejecuta tests, despliegue y documentación de la fase.
- No redefine reglas de producto por su cuenta.

### Aclaración sobre la Fase 0

La preparación inicial y la Fase 0 no son lo mismo:

1. **Preparación del arquitecto:** repo, inspección en solo lectura, `ENTORNO.md`, `ROADMAP.md`, `DECISIONES.md`, estructura documental y recomendaciones.
2. **Fase 0 del constructor:** código del esqueleto, webhook, base de datos, dedupe, outbox, mock, scripts y despliegue.

Así se evita que dos agentes crean que deben hacer el mismo trabajo.

## 3. Trabajo concurrente

- Por defecto, un constructor a la vez.
- Dos constructores solo cuando el arquitecto declare tareas independientes en `docs/ROADMAP.md`.
- Nunca dos agentes editando simultáneamente la misma rama o el mismo worktree.
- Git es el estado compartido. Antes de comenzar: `git status`, actualizar la rama base y leer los documentos de control.
- Un agente no sobrescribe cambios ajenos no revisados.
- Conflictos de merge o decisiones contradictorias vuelven al arquitecto.

## 4. Cambios críticos que requieren revisión del arquitecto

Antes de fusionar:

- permisos, identidad y resolución de `@lid`;
- dedupe, outbox y reconciliación;
- migraciones destructivas;
- `scripts/deploy.sh`, backup y rollback;
- XP, ledger, apuestas, ruleta y cooperacha;
- operaciones masivas, difusión y `nuclear`;
- acceso SSH/Tailscale y control de Minecraft;
- sincronización de Drive/biblioteca;
- cambios al contrato de `Tool`, router o sesiones.

Un plan previo de máximo 10 líneas basta para un cambio grande.

## 5. Flujo normal de una fase

1. Lee `AGENTS.md`, `docs/PLAN_MAESTRO.md`, `docs/DECISIONES.md`, `docs/ENTORNO.md` y el bloque de fase de `docs/PROMPTS.md`.
2. Crea rama/worktree `phase-N-nombre`.
3. Implementa con commits pequeños.
4. Escribe y ejecuta los tests exigidos por el plan.
5. Verifica en documentación vigente cualquier API externa antes de asumir endpoints, payloads, límites o capacidades.
6. Despliega únicamente con `scripts/deploy.sh`.
7. Escribe:
   - `docs/fases/FASE-N.md`
   - `docs/fases/FASE-N-PRUEBAS.md`
8. Si es cambio crítico, solicita revisión.
9. Fusiona a `main` cuando compile, tests y healthcheck estén en verde.
10. Continúa con la siguiente fase solo si el roadmap lo permite.

El dueño ejecuta las pruebas manuales cuando pueda. Un módulo nuevo permanece deshabilitado en los grupos reales hasta que él lo active.

## 6. Definición de terminado

Una fase está terminada cuando:

- `typecheck`, linter y tests pasan;
- cumple su criterio de §3 del Plan Maestro;
- está desplegada y `/health` está en verde;
- existen los dos documentos de fase;
- no quedaron secretos en Git, logs ni documentación;
- las decisiones técnicas relevantes quedaron registradas;
- no se afirmó éxito de una acción externa sin confirmación.

## 7. Reglas de oro

1. **Costo cero adicional.** No actives facturación ni contrates servicios sin permiso expreso.
2. **Secretos solo en `.env` o mecanismos locales equivalentes**, nunca en prompts, Git, logs o documentación.
3. **Evolution existente se trata como producción.** No borres, reinstales, desvincules ni cambies su base de datos. En preparación: solo lectura. En Fase 0 solo se modifica lo estrictamente necesario para el webhook, después de documentarlo.
4. **No borres datos** sin instrucción explícita, respaldo verificado y plan de recuperación.
5. **Pruebas reales destructivas o masivas solo en el grupo de pruebas.**
6. **No inventes APIs.** Verifica la versión instalada de Evolution y la documentación vigente de Gemini, Docker, Tailscale y demás dependencias.
7. **Permisos antes que IA.** El modelo interpreta; el programa decide actor, chat, permisos, dinero y efectos.
8. Todo argumento externo pasa por validación. Comandos de sistema con `execFile`/argumentos separados o equivalente seguro.
9. **Minecraft:** solo mediante la llave y script restringidos definidos en el plan.
10. **Nada de éxitos falsos.**
11. **Los datos exactos no se estilizan.**
12. **No fuerces plataformas externas.** Si una fuente multimedia, API o proveedor deja de funcionar, se marca no disponible y se documenta; no se improvisa una evasión peligrosa con credenciales personales.
13. **IA-First para lenguaje humano (v1.1).** Gemini entiende significado humano, modismos, slang y typos; las tools ejecutan efectos; el backend valida esquemas, tipos técnicos, políticas y permisos. Prohibido añadir expresiones regulares semánticas, listas de sinónimos, homófonos o diccionarios ad-hoc de lenguaje humano en el código de TypeScript para intentar entender al usuario. Formato al código, significado a Gemini.

## 8. Cuándo detenerse y preguntar al dueño

Solo cuando:

1. hay que gastar dinero o activar facturación;
2. una acción irreversible sobre datos es ambigua;
3. hay riesgo material para el número de WhatsApp o la instalación de Evolution;
4. falta información que solo el dueño posee y no puede sustituirse con datos de ejemplo;
5. hace falta una acción física/manual: enviar mensajes reales, escanear QR, confirmar permisos de Google, proporcionar una foto del horario, etc.;
6. el Plan Maestro contiene una contradicción de producto que no puede resolverse por autoridad documental.

Pregunta una sola cosa concreta, da una recomendación y sigue con lo que no dependa de la respuesta.

## 9. Estilo de código

- TypeScript estricto; sin `any` salvo justificación excepcional documentada.
- Sin `catch` vacíos.
- Reglas de negocio como funciones puras y probables.
- Archivos pequeños y responsabilidades claras.
- Números de producto en `config/product.ts`.
- Una tool nueva = implementación + registro; cambiar el router es cambio crítico.
- Dependencias nuevas requieren justificación en el commit.
- Código/comentarios en inglés. Documentación y mensajes del bot en español.

## 10. Comandos estándar

Se crean/documentan durante Fase 0 en `docs/ENTORNO.md`:

```text
npm run dev
npm run typecheck
npm run lint
npm test
npm run migrate
scripts/deploy.sh
scripts/backup.sh
scripts/panic.sh
```

## 11. Reportes al dueño

Al terminar una fase o ante un bloqueo, entrega 5–8 líneas:

1. qué se hizo;
2. qué se probó automáticamente;
3. qué queda para prueba manual;
4. decisiones tomadas;
5. riesgos o límites conocidos;
6. qué necesitas del dueño, si algo.

Sin jerga innecesaria.

## 12. Cuando algo falla

- Diagnostica antes de parchar.
- Si un despliegue rompió producción: rollback primero.
- No encadenes arreglos que no expliquen la causa.
- Registra incidente, causa y solución en `docs/INCIDENTES.md`.
- Si Botsky deja de responder, usa el prompt de incidente de `docs/PROMPTS.md`.

## 13. Mapa esperado del repositorio

```text
AGENTS.md
docs/
  PLAN_MAESTRO.md
  owner-answers.md
  PROMPTS.md
  DECISIONES.md
  ENTORNO.md
  INCIDENTES.md
  ROADMAP.md
  fases/
src/
config/
scripts/
tests/
docker-compose.yml
.env.example
```
