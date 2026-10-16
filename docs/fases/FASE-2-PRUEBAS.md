# Fase 2 — Evidencia y pruebas para WhatsApp

Estado: **lista para cierre**, con aprobación arquitectónica sin correcciones de
código. Por decisión expresa del dueño (DEC-034), la evidencia automática, de
integración y la auditoría arquitectónica son suficientes para cerrar Fase 2.
Importar el horario con foto real, entregar físicamente un adjunto PDF/imagen y
recibir el resumen escolar programado son pruebas **opcionales/no bloqueantes**,
no ejecutadas. No se eliminan tests automáticos, integraciones ni cobertura existente.
Todas las pruebas de desarrollo usan una base PostgreSQL 17 aislada
y proveedor simulado, excepto la evaluación explícita Gemini descrita abajo.
No se fabrican pruebas físicas ni se consideran ejecutadas por tener un mock verde.

## Pruebas automáticas

- Schemas estrictos: materia, horario, días/horas, duplicados, superposiciones,
  campos inesperados y propuestas que intentan incluir actor/chat.
- Fechas: cambio de día UTC/CDMX, siguiente clase y semana, ninguna clase disponible,
  fecha explícita futura con offset, inválida/pasada/sin zona rechazada.
- Permisos: owner/admin local/member, desconocido, membresía caducada/revocada,
  otro grupo, privados y módulo apagado. Ayuda oculta gestión a miembros.
- Confirmación: preview completo sin escribir clases/materias; sí propio, no ajeno,
  ni en otro chat; cancelación, expiración, hash manipulado, preview manipulado,
  revisión concurrente, bypass directo/modelo y replay. Estado en PostgreSQL.
- Tareas: cualquier miembro crea y queda como autor canónico; edición propia,
  edición administrativa, borrado lógico confirmado solo por owner/admin;
  aislamiento de consultas/IDs y dedupe por evento y por mensaje de alta.
- Visión: descarga autenticada con la clave del mensaje real del contexto;
  función de extracción restringida, datos de Gemini validados, errores sin clases.
- Originales imagen/PDF: bytes separados de payload outbox, ámbito, caducidad,
  solicitud por tarea, permiso al enviar, timeout y reconciliación sin duplicar.
  Fallos/MIME no admitido revierten alta/adjunto. PDF no se interpreta como prompt.
- Resumen: apagado inicial, configuración autorizada, reclamos concurrentes,
  caída de varios días condensada en un envío, permiso revocado antes de enviar,
  módulo/chat/resumen apagado, mantenimiento/emergencia, uncertain sin repetición.
- Proceso real con SIGKILL: resumen persistido y vencido durante interrupción,
  recuperación en un único envío por transporte simulado. Conserva los casos
  anteriores de reinicio/inbox/outbox y recordatorio dentro de ±30 s.
- Suite completa de Fases 0/1, incluidas notas, recordatorios, memoria, visión,
  búsqueda contextual, identidad, cuotas, startup y restauración aislada.

## Integración Gemini real, sin WhatsApp

16-10-2026 13:33 UTC: `npm run eval:phase2 -- .local/school-eval.png`.
Una imagen **sintética** de tabla semanal produce exactamente tres clases:
lunes 08:00–09:00 Matemáticas, miércoles 10:00–11:00 Historia y viernes
12:00–13:00 Física. HTTP 200, 6916 ms, 1422 tokens de entrada y 108 de salida.
Se comprueba cero clases antes de confirmar y tres después del «sí» propio.
Descarga de imagen local simulada; Gemini y su adaptador/cuota sí son reales.
Base aislada destruida de forma segura al terminar. Cero filas de outbox y cero
envíos a WhatsApp. Evidencia privada `.local/phase2-school-eval.json` (sin claves).
No demuestra precisión de lectura de cualquier foto ni entrega real de originales.

## Pruebas manuales opcionales (solo Botsky Lab)

Lista conservada como referencia voluntaria tras el despliegue, sin condicionar
el cierre (DEC-034). Sustituye `ID` por el que devuelva Botsky. Para permisos
hace falta una cuenta miembro sin admin además del owner/admin. No ejecutar en
grupos reales. Cada paso indica el resultado esperado; aún no están ejecutados.

1. **Ayuda y permisos.** Envía `bot ayuda escuela` desde ambas cuentas.
   Miembro ve horario, materias, alta/listado/edición propia y adjuntos; no gestión
   de horario, configuración del resumen ni eliminación. Owner/admin sí los ven.
2. **Foto y cancelación.** Adjunta una foto legible con caption
   `bot horario importa foto`. Debe mostrar cada materia, día y hora y pedir `sí/no`.
   Envía `bot horario`: debe mostrar solo el horario anterior, todavía sin cambios.
   Responde `no`; el horario propuesto no se guarda.
3. **Confirmación propia.** Cita la foto y envía `bot horario importa foto` otra vez.
   Revisa TODO el preview. Un `sí` de otro miembro no puede confirmarlo. Luego
   responde `sí` desde quien lo solicitó, dentro de dos minutos. `bot horario`
   debe coincidir con el preview; `bot horario lunes` filtra correctamente.
   Si hay un error de lectura, responde `no` y envía una foto mejor o una propuesta
   textual completa como el ejemplo de FASE-2.md; no confirmes una extracción errónea.
4. **Alta y fechas.** Desde un miembro: `bot tarea Matemáticas | ejercicios 1 al 5`
   (usa el nombre exacto de una materia del horario). Debe atribuirla al miembro y
   usar la próxima clase. Owner/admin: `bot materia agrega Proyecto libre`;
   miembro: `bot tarea Proyecto libre | preparar exposición` debe quedar sin fecha.
   `bot tareas` y `bot tareas de Matemáticas` deben mostrar las tareas correctas.
5. **Adjunto.** Envía una imagen o PDF de <4 MB con caption
   `bot tarea Matemáticas | entregar el archivo adjunto`. Después:
   `bot tarea adjunto ID`. Primero indica cola; luego debe llegar el original al
   mismo grupo. No se debe afirmar que se entregó antes de confirmarlo el proveedor.
6. **Edición y borrado.** El autor: `bot tarea edita ID | ejercicios corregidos`.
   Otro miembro no puede editarla. `bot tarea borra ID` desde un miembro debe
   responder `No.` incluso si creó la tarea. Owner/admin solicita borrado y responde
   `sí`; la tarea sale del listado. Otras tareas permanecen.
7. **Resumen.** Owner/admin: `bot escuela destino aquí`; luego
   `bot escuela resumen HH:mm lunes,martes,miércoles,jueves,viernes,sábado,domingo`,
   cambiando HH:mm por una hora de **CDMX** un par de minutos adelante.
   `bot escuela configuración` muestra fecha/hora y destino. Debe llegar un único
   resumen con clases/tareas. Al terminar envía `bot escuela resumen off` para
   no dejar avisos de prueba diarios. La caída/reinicio está cubierta automáticamente;
   una prueba física de reinicio adicional es opcional y debe coordinarse por SSH.
8. **Control.** Owner: `bot desactiva escuela aquí`; `bot horario` debe rechazarse.
   `bot activa escuela aquí` restablece el módulo. No activa el resumen apagado.

La foto real, la entrega física de PDF/imagen y la recepción del resumen real
requieren mensajes/acciones del dueño, que decidió no realizarlas como condición
de cierre. No se esperan estas acciones. El arquitecto ya aprobó Fase 2 sin
correcciones de código; no se activa Escuela en grupos reales ni se fusiona la rama.

## Resultado final

- Node 24: `npm run typecheck`, `npm run lint`, `npm run build` y `npm test` correctos.
- **206 tests / 18 archivos**, suite completa en 89,62 s el 16-10-2026 a las 13:40 UTC.
  Se mantienen los 153 tests de la base y se añaden 53 de Escuela/transporte/reinicio.
- Una ejecución anterior detectó la carrera ya existente entre cerrar el pool y
  observar su desconexión en `pg_stat_activity` del test de limpieza de bases.
  El test aislado pasó (3/3), después la suite completa pasó 205/205; tras añadir
  la regresión final de renombrado/límite, pasó 206/206. Sin modificar ese helper,
  sin forzar desconexiones y sin eliminar ninguna base de producción.
- Escaneo de secretos locales contra árbol versionable y logs de fase: cero coincidencias.
- `scripts/deploy.sh`: correcto, código **e7672e1**, respaldo local verificado.
  `004_school.sql` aplicada 13:41:17 UTC. App/worker saludables con la misma imagen.
- `/health` HTTP **200** a las 13:42 UTC: base y Evolution conectados, transporte real.
  Cero errores nuevos de arranque/BD. Nota y dos recordatorios históricos idénticos
  a la huella previa; Evolution/API/Postgres/Redis sin reinicio ni cambios.
- Cero grupos habilitados fuera de Lab y cero resúmenes activos. Sin datos escolares
  ficticios en producción, cero mensajes reales enviados por estas pruebas.
- Foto real, entrega física PDF/imagen y resumen físico **no ejecutados**,
  opcionales/no bloqueantes por DEC-034. Auditoría arquitectónica aprobada sin
  correcciones de código; fase **lista para cierre**. Se conservan todas las
  pruebas e integraciones. Rama publicada, sin merge a main y sin Fase 3.

## Revalidación para cierre documental (16-10-2026)

- Node **24.22.0**: `npm run typecheck`, `npm run lint` y `npm run build` correctos.
- `npm test`: **206/206 tests, 18/18 archivos**, 97,97 s; salida final 0.
  Se ejecutó la suite completa existente, sin retirar tests ni integraciones.
- `/health` del despliegue existente: **HTTP 200** a las **14:32:14 UTC**,
  `ok=true`, `database=true`, `evolution=true`, `transport=evolution`.
- Solo documentación; las tres pruebas físicas continúan no ejecutadas y
  opcionales/no bloqueantes según DEC-034. Sin nuevo despliegue ni cambios funcionales.
