# Fase 2 — Escuela

Estado: implementada, validada y desplegada en `phase-2-escuela`, desde `28b252d`.
**Lista para cierre**: el arquitecto aprobó la fase sin correcciones de código.
Por decisión expresa del dueño (DEC-034), la evidencia automática, de integración
y la auditoría arquitectónica son suficientes. La foto real del horario, la entrega
física de PDF/imagen y la recepción real del resumen programado quedan opcionales
y no bloqueantes, sin ejecución física confirmada. Se conserva toda la cobertura.
La instrucción del dueño en esta sesión autoriza Fase 2 tras el cierre y merge de
Fases 0/1; prevalece sobre las restricciones históricas de DEC-030/roadmap.
No se fusiona a main ni se inicia Fase 3.

Plan previo para cambios críticos (histórico; revisión ya aprobada):
1. Migración aditiva de materias, horario, tareas, adjuntos, propuestas y automatizaciones.
2. Escuela limitada a grupos habilitados, miembro vigente; gestión owner/admin local.
3. Schemas estrictos, fechas CDMX, atribución backend e idempotencia por mensaje.
4. Propuesta de horario validada, preview completo y confirmación ligada/versionada.
5. Visión gratuita existente; ningún actor/chat/ruta de archivo desde Gemini.
6. Tareas con originales de ámbito validado y retención de siete días.
7. Resumen persistente con outbox única y recuperación condensada tras interrupción.
8. Registro, ayuda y atajos; conservar regresiones completas de Fases 0/1.
9. Despliegue oficial con respaldo, migración y healthcheck; solo laboratorio.
10. Documentar evidencia y pruebas físicas pendientes; detenerse para el arquitecto.

## Alcance implementado

- Materias por grupo: alta, renombrado y desactivación administrativa.
- Horario semanal completo, consulta por día, propuesta de reemplazo por texto o
  foto; preview completo, confirmación persistente, hash y revisión concurrente.
- Gemini Vision extrae únicamente una propuesta validada. No conoce actor, chat,
  permisos, IDs de archivos ni decide si se guarda. Las cuotas gratuitas de Fase 1
  siguen vigentes; los comandos deterministas funcionan sin Gemini.
- Tareas con lenguaje natural o comando: alta, listado por materia, edición propia,
  edición administrativa y borrado lógico confirmado solo owner/admin.
- Sin fecha: próxima clase; sin horario: sin fecha de entrega. Fechas explícitas
  futuras con zona; almacenamiento UTC y presentación America/Mexico_City.
- Originales imagen/PDF, uno por tarea, máximo 4 MB, retención siete días. También
  se conserva la imagen original del horario importado. Entrega por outbox del grupo,
  con validación de ámbito/retención/permisos y sin éxito falso al quedar en cola.
- Configuración por chat, grupo de destino y resumen de clases del día/tareas.
  Días/hora modificables desde WhatsApp; apagado por defecto, recuperación única
  con retraso tras caída, sin repetir ejecuciones perdidas ni entregas inciertas.
- Registro de tools, ayuda filtrada, atajos de Escuela y alias «escuela» en módulos.

## Migración y tablas

`src/db/migrations/004_school.sql` crea:

| Tabla | Propósito |
|---|---|
| `school_config` | Destino, zona fija CDMX, revisión y horario de resumen. |
| `school_subjects` | Materias del chat con nombres únicos y desactivación lógica. |
| `school_schedule` | Clases semanales; FK compuesta impide materias de otro chat. |
| `school_tasks` | Título, materia, fecha/origen, autor, mensaje fuente y borrado lógico. |
| `school_attachments` | Originales con ámbito, propietario, bytes y caducidad. |
| `school_imports` | Preview, hash, autor/chat, revisión base, fuente y vencimiento. |
| `automations` | Resumen persistente, configurador y vínculo con outbox. |

Sin dependencias nuevas, servicios nuevos o cambios a scripts de despliegue.
Se reutilizan sesiones, auditoría, inbox, outbox y adaptador Gemini existentes.

## Permisos finales

| Acción | Miembro vigente | Admin del grupo | Owner |
|---|---|---|---|
| Ver materias/horario/tareas/configuración | Sí | Sí | Sí |
| Crear tareas y solicitar su adjunto grupal | Sí | Sí | Sí |
| Editar una tarea propia | Sí | Sí | Sí |
| Editar tareas ajenas | No | Sí | Sí |
| Eliminar cualquier tarea | No | Sí, confirmado | Sí, confirmado |
| Materias y horario | No | Sí; horario siempre confirmado | Sí; horario siempre confirmado |
| Resumen/destino | No | Sí, permisos en origen/destino | Sí |
| Activar/desactivar módulo global por chat | No | No | Sí, control de Fase 1 |

No hay Escuela desde privados. Un admin de otro grupo no administra este grupo.
Las identidades alternativas solo usan la resolución comprobada existente; sin
privilegios por nombre ni por identificadores sugeridos por IA. La ayuda también
excluye herramientas escolares si no hay membresía vigente.

## Herramientas y comandos

- `bot ayuda escuela`, `bot materias`, `bot horario`, `bot horario lunes`.
- `bot materia agrega Matemáticas`, `bot materia edita ID Matemáticas II`,
  `bot materia desactiva ID` (confirmado).
- Foto con caption `bot horario importa foto` o `bot guarda este horario`.
  También acepta cita del original del mismo chat o imagen propia de hace <10 min.
- Propuesta textual completa: `bot horario propone {"lessons":[{"subject":"Matemáticas","weekday":1,"start":"08:00","end":"09:00"}]}`.
  Revisa preview y responde `sí` o `no` antes de dos minutos.
- `bot tarea Matemáticas | ejercicios 1 al 5`; la foto/PDF adjunta se vincula al alta.
- Fecha explícita: `bot tarea Matemáticas | proyecto | 2026-11-10T08:00:00-06:00`.
- `bot tareas`, `bot tareas de Matemáticas`, `bot tarea edita ID | título corregido`,
  `bot tarea fecha ID | 2026-11-10T08:00:00-06:00`, `bot tarea fecha ID | sin fecha`.
- `bot tarea borra ID` y `sí` (administración), `bot tarea adjunto ID`.
- `bot escuela configuración`, `bot escuela destino aquí`.
- `bot escuela resumen 07:00 lunes,martes,miércoles,jueves,viernes`,
  `bot escuela resumen off`.
- `bot módulos`, `bot desactiva escuela aquí`, `bot activa escuela aquí` (owner).

## Límites y revisión

Ver DEC-031–034. Barrera heredada de producción conserva **solo Botsky Lab**,
incluso para destino de resumen; no se habilitan grupos reales. Escuela se ofrece
en Lab por defecto, el resumen solo por orden explícita. No hay Fase 3.
Una propuesta nueva reemplaza el horario semanal, sin borrar tareas ni materias.
Si otro administrador modifica materias/horario, la propuesta anterior se rechaza.
No se interpreta PDF ni se generan calendarios festivos; formatos adicionales y
conversiones pertenecen a Fase 5. Listados/resúmenes muestran hasta 30 tareas.

Cambios a permisos, contrato de actor/entrega, router (solo tarea con documento),
outbox y tick recibieron aprobación del arquitecto sin correcciones de código.
No se modifican scripts de deploy, backup, rollback, sesiones ni esquema de tablas
de Fase 1.
La migración es aditiva; rollback de imagen deja las tablas nuevas inertes.

## Evidencia de validación

- Gemini real, 16-10-2026 13:33 UTC: una tabla sintética PNG de tres clases se extrajo
  correctamente (lunes 08:00–09:00, miércoles 10:00–11:00, viernes 12:00–13:00).
  HTTP 200, 6916 ms, 1422/108 tokens. Cero clases antes del «sí», tres después.
  Cero mensajes WhatsApp. Evidencia privada `.local/phase2-school-eval.json`.
- `npm run eval:phase2 -- /ruta/privada/horario-sintetico.png` ejecuta esa comprobación
  en base aislada; no equivale a probar la foto real del dueño ni la entrega física.
- `npm run typecheck`, `npm run lint`, `npm run build` y `npm test`: correctos.
  **206 tests, 18 archivos**, 89,62 s; incluye los 153 originales, 49 casos iniciales
  escolares, regresión de renombrado/límite, dos contratos media y un SIGKILL escolar.
  Despliegue/health confirmados abajo.


## Despliegue confirmado (16-10-2026)

- Código desplegado **`e7672e1`**, mediante `scripts/deploy.sh`, con respaldo previo
  `backups/botsky-20261016T134037-1815959.dump` verificado por el script.
- Migración `004_school.sql` aplicada a la base propia a las **13:41:17 UTC**.
  Las siete tablas nuevas están presentes; ninguna migración previa se modificó.
- `/health` **HTTP 200**, `ok=true`, `database=true`, `evolution=true`, transporte
  real. Verificación final a las **13:42 UTC**; app y worker con la misma imagen
  inmutable y saludables. Cero errores recientes en BD y avisos/errores de arranque.
- Nota histórica (1) y recordatorios (2) mantienen exactamente sus filas y estados
  frente a la huella privada anterior al despliegue. Evolution/API/Postgres/Redis
  conservan su fecha de arranque: no se reiniciaron ni modificaron.
- Cero grupos habilitados fuera de Lab; cero resúmenes habilitados; todavía no hay
  horario ni tareas reales. El constructor no envió mensajes reales de prueba.
- Rama publicada en origin, sin merge. `main` permanece en `28b252d`.
  Los commits documentales posteriores no cambian el código de la imagen desplegada.
- Revisión arquitectónica aprobada sin correcciones de código, según confirmación
  del dueño del 16-10-2026. Fase **lista para cierre** por DEC-034; foto real,
  entrega física PDF/imagen y resumen real no ejecutados, opcionales/no bloqueantes.
  La lista de WhatsApp, incluidos permisos con segunda cuenta, se conserva como
  referencia voluntaria; los permisos cuentan con cobertura automática existente.
  Sin autorización para merge a main, Fase 3 ni activaciones en grupos reales.

## Verificación documental para cierre (16-10-2026)

DEC-034 registrada sin cambios funcionales. Node 24.22.0: typecheck, lint y build
correctos; **206/206 tests en 18 archivos**, 97,97 s. `/health` HTTP **200** a las
14:32:14 UTC: `ok=true`, `database=true`, `evolution=true`, `transport=evolution`.
Se conserva el despliegue existente; este cambio solo actualiza documentación.
