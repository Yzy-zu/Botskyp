# Fase 1 — Núcleo (lista para cierre)

**Estado actual, por decisión del dueño (DEC-030): lista para cierre.** Se aceptan
las validaciones automáticas y de integración existentes como suficientes para
cerrar Fase 1. Todas las pruebas físicas adicionales pendientes en WhatsApp fueron
voluntariamente omitidas, incluidas raza/contexto visual, búsqueda contextual de
temporada y recordatorio con reinicio físico. Ya no se exige realizarlas ni obtener
otra confirmación manual del dueño para cerrar esta fase.

Se conservan íntegros los tests, fixtures, evaluaciones y resultados históricos.
La omisión no se registra como una ejecución manual aprobada. La documentación
inferior mantiene la evidencia de cada etapa; DEC-030 rige el criterio de cierre
actual. Revisión del arquitecto previa al merge pendiente; sin merge a `main`,
sin Fase 2 ni nuevas activaciones en grupos reales.

Plan previo (cambio crítico, pendiente de revisión del arquitecto):
1. Migración aditiva para tools, sesiones, contexto, notas, recordatorios, memoria y cuota.
2. Permisos verificados desde identidad canónica y membresía vigente; modelo sin actor/chat.
3. Registro tipado con Zod, ayuda filtrada y atajos sin IA.
4. Sesiones con versión, vencimiento y confirmación ligada a hash de argumentos.
5. Gemini REST gratuito, cuota persistida, backoff acotado y rechazo sin bucles.
6. Notas, recordatorios con zona/recurrencia y memoria solicitada explícitamente.
7. Búsqueda integrada gratuita y visión mediante descarga autenticada de Evolution.
8. Controles persistentes y tick independiente; módulos solo en laboratorio.
9. Tests, build, despliegue por script, healthcheck y guía de WhatsApp.
10. Sin merge y sin Fase 2; entrega para revisión.

## Implementación

- Adaptador REST Gemini con declaraciones JSON Schema generadas desde Zod, timeout,
  presupuesto compartido, métricas persistidas y tratamiento explícito de 429/bloqueos.
- Registro con permiso, scope, riesgo, modelCallable y módulo. Ayuda generada del
  registro, atajos deterministas y resultados canónicos sin estilización posterior.
- Actor canónico desde evidencia de Evolution; nunca desde argumentos del modelo.
  Admin por grupo y evidencia reciente; privados autoaprobados revocables.
- Sesiones persistidas y versionadas, vencimientos y entradas admitidas. Confirmación
  ligada a acción/hash y propietario/chat. El tick vence sesiones tras reinicios.
- Notas compartidas en grupo, privadas por autor/chat; búsqueda full-text española,
  edición con permiso y borrado lógico confirmado.
- Recordatorios: fechas explícitas y relativas, aclaraciones, edición/cancelación,
  recurrencia diaria/semanal/mensual por hora IANA. Outbox única por vencimiento;
  `sent` depende de entrega confirmada; retrasos explícitos y una sola recuperación.
- Memoria personal de escritura determinista opt-in, 30 × 200 caracteres, filtro
  conservador de credenciales/datos sensibles y consulta privada.
- Persona versionada en `config/persona.md`, contexto por usuario/chat con retención
  de siete días. Visión del adjunto actual mediante Evolution autenticado, sin URLs
  ni IDs propuestos por Gemini. Sin guardar los bytes de imagen.
- Mantenimiento y emergencia persistidos, reactivación owner-only, módulos por chat,
  `diag.cuota` y `diag.errores`. El apagado detiene también las entregas; por ello no
  intenta enviar una confirmación del propio apagado después de reactivarse.
- SearXNG interno con límite de recursos, sin cuentas, sin Redis ni puerto público.
  `scripts/deploy.sh` conserva respaldo y rollback de app/worker y arranca este
  servicio adicional antes de promover la app.

## Decisiones y alcance

Ver DEC-019–022 en `docs/DECISIONES.md`. Solo Fase 1. No hay escuela, PDF, audio,
Minecraft ni economía. Se conserva la barrera de grupos fuera de Botsky Lab; los
módulos privados están disponibles únicamente a usuarios ya autorizados. Ningún
módulo nuevo se activa en grupos reales. El dueño confirmó nivel gratuito sin
facturación; solo se copió la clave primaria al `.env` protegido.

El modelo principal es `gemini-3.5-flash-lite`. El intento de grounding legado 2.5
falló con 404 real; no se deriva tráfico a grounding de pago. SearXNG es la opción
gratuita adoptada. La cuota concreta de Google depende del proyecto; los límites
locales son deliberadamente conservadores. Suscripciones de consumo no se usan
como si fueran créditos de API.

## Evidencia previa al despliegue

- Gemini real: HTTP 200 para conversación.
- Imagen sintética roja + function calling real: `report_color({color:"rojo"})`.
- Router completo con registro real y base aislada: solicitud natural produjo una
  sola nota y respuesta canónica, con cuota registrada (1314/24 tokens).
- Gemini 2.5 grounding: HTTP 404; catálogo por sí solo no demuestra disponibilidad.
- Los tests usan PostgreSQL 17 aislado y Evolution simulado. No envían mensajes reales.
- Al desplegar inicialmente, las pruebas manuales estaban pendientes; resultados
  posteriores en `FASE-1-PRUEBAS.md`.

## Resultado del cierre técnico (16-10-2026 UTC)

- `npm run typecheck`, `npm run lint`, `npm test` y `npm run build`: correctos con Node 24.
- **113 tests, 13 archivos**, incluyendo SIGKILL con recordatorio pendiente y entrega
  única dentro de ±30 segundos, identidades, cuotas, permisos, sesiones, privacidad,
  recurrencias y los tests de Fase 0 sin regresiones.
- Despliegue inicial `4fc033d` y final `218b38e` mediante `scripts/deploy.sh`: respaldo previo
  verificado, migración `002_core.sql` y app/worker saludables. La revisión final de
  documentación posterior no cambia la imagen de código desplegada. El último
  cambio de código ajustó solo el texto de archivo no disponible; se repitieron
  typecheck, lint y build antes del despliegue final.
- `/health`: HTTP 200, `ok=true`, `database=true`, `evolution=true`, transporte real.
- SearXNG `2026.10.16-ff8f5ddcc` saludable; consulta real desde el contenedor app
  devolvió cinco enlaces para el sitio oficial de PostgreSQL. No usa Gemini ni cuota.
- Endpoint de imagen de Evolution instalado: HTTP 201 con MIME y base64 válidos de
  una imagen original de Botsky Lab, comprobado en solo lectura y sin enviar mensajes.
- No se modificaron configuración, contenedores ni base de Evolution. Cero grupos
  habilitados fuera de Lab. No hay errores recientes en `error_log` al verificar.
- Escaneo de valores de secretos locales contra archivos versionados y logs de esta
  fase: cero coincidencias. `.env` y `.env.viejo` conservan modo 600.
- Rama `phase-1-nucleo` publicada en origin. **No fusionada. Fase 2 no iniciada.**

## Validación y límites conocidos

El dueño confirmó en WhatsApp real el flujo mínimo: nota #1 guardada, pregunta de
fecha para el recordatorio #1 y programación exacta en `2026-10-16 08:00`
(`America/Mexico_City`) después de responder «mañana a las 8 am». La hora fue
calculada desde la fecha local del 15 de octubre, sin confundirla con la fecha UTC.

La entrega física tras reinicio se omite voluntariamente por DEC-030; la prueba
automática con SIGKILL se acepta como evidencia suficiente para cierre. La revisión
del arquitecto previa al merge sigue pendiente.
La ronda posterior sí comprobó entrega ordinaria, visión al reenviar y búsqueda;
ver el registro actualizado en `FASE-1-PRUEBAS.md`. La fase está lista para cierre.
El catálogo manual se conserva como referencia; no obliga a enviar nuevos mensajes
ni a reiniciar físicamente Botsky para cerrar la fase.

Los topes locales de IA no garantizan la capacidad del proyecto de Google; para
ampliarlos hay que consultar AI Studio manteniendo costo cero. No se cambia de clave
ante un límite. SearXNG puede perder motores externos: la tool informa un fallo real.
Las memorias se filtran de forma conservadora, no mediante una garantía semántica de
que cualquier texto posible esté libre de datos sensibles. Se evita inyectarlas en
grupos. No hay prueba de PDF/audio porque pertenecen a Fase 5.

Los cambios de permisos, contrato de tools, sesiones, router, timing/outbox y script
de despliegue requieren revisión del arquitecto antes de fusionar. No se habilitan
módulos en grupos reales.

## Plan de corrección tras la ronda manual (16-10-2026)

1. Contrastar inbox/outbox y recordatorios con historial autenticado de Evolution, solo lectura.
2. Registrar entregas buenas sin confundir confirmación de alta con aviso al vencer.
3. Corregir TPM local usando reserva por solicitud y consumo real confirmado; migración aditiva.
4. Mantener topes por minuto/día y distinguir límite local de 429 del proveedor.
5. Registrar timeout de Gemini y permitir un plazo acotado mayor para imágenes, sin reenvío automático.
6. Pedir contenido faltante de recordatorios en vez de aceptar un texto inventado por el modelo.
7. Probar regresiones, desplegar por script, verificar salud y documentar lo que aún falta probar.
8. Conservar citas de imagen y resolverlas únicamente contra inbox del mismo chat.
9. Publicar solamente `phase-1-nucleo`; sin merge ni Fase 2.

## Resultado de la revisión de pruebas manuales

Se auditó la ronda 03:03–03:14 UTC mediante base propia e historial del proveedor,
sin reenviar eventos ni mensajes. Nueve respuestas coinciden por ID y texto exacto;
nota #1, sesión y fecha del recordatorio #1, entrega única del #2 (1,139310 s de
retraso), búsqueda con cinco enlaces y descripción de la imagen comprobadas.
El reinicio ocurrió antes del alta de #2: no se presenta como validación de reinicio
mientras un recordatorio estaba pendiente. La imagen y los datos crudos permanecen
locales y privados, fuera de Git; en los documentos solo hay resultados sanitizados.

Se corrigieron reserva fija excesiva de TPM, mensaje que confundía límite local
con cuota remota, falta de diagnóstico de timeout y el título inventado al crear
un recordatorio sin contenido. Ver DEC-023/024 e INC-20261016-05. Migración aditiva
`003_llm_reservations.sql`; no borra ni modifica notas/recordatorios existentes.
Visión conserva un máximo de espera (40 s), sin retry automático; texto queda en
20 s. Todos los topes de uso y la clave única permanecen. El conteo de entrada
confirmada reemplaza la reserva provisional cuando el proveedor lo informa.

Pasaron typecheck, lint, build y 127 tests. Una integración real aislada con la misma
imagen respondió correctamente en 1508 ms y registró reserva/consumo por separado.
Correcciones desplegadas en `90a63a3` por `scripts/deploy.sh`, con respaldo previo
verificado y migración aditiva `003_llm_reservations.sql`. `/health` HTTP 200 confirma
base y Evolution en verde; app, worker y SearXNG saludables. La nota y recordatorios
históricos conservan su estado, y siguen existiendo cero grupos habilitados fuera
de Lab. Las repeticiones físicas se omiten por DEC-030; la evidencia automática y
de integración es suficiente para cierre, con revisión previa al merge vigente.


La pregunta de color citaba la imagen original. La inspección del registro REST
reveló que el normalizador descartaba su referencia de adjunto. Se conserva ahora
esa referencia y se resuelve solo contra un mensaje recibido en el mismo chat,
dentro de la retención de contexto. El modelo no elige ID ni chat. Una cita sin
original autorizado pide reenviar; jamás consulta otra conversación. Fixture REST
sanitizado y pruebas de cita válida, desconocida y de otro chat. Ver DEC-025.


Comprobación final en el contenedor desplegado: la cita real de la pregunta de color
se resuelve a una imagen autorizada del mismo chat. Integración aislada posterior
con normalización del registro original, resolución por chat, descarga autenticada
y Gemini real: descripción correcta de los colores en 1266 ms, 1112 tokens de entrada
y 64 de salida, cero filas outbox. No se envían respuestas de esta prueba a WhatsApp.
Los archivos versionados y logs de revisión se verifican contra los secretos locales
antes de publicar. Rama únicamente `phase-1-nucleo`; sin merge ni Fase 2.


## Plan de corrección de búsqueda contextual (segunda ronda manual)

1. Verificar solo en lectura las tres respuestas nuevas contra inbox, outbox e historial.
2. Separar búsquedas completas deterministas de solicitudes con referente o tema faltante.
3. Quitar la invocación final al bot únicamente de la consulta de búsqueda.
4. Interpretar referencias usando solo contexto del mismo actor/chat y conservar la intención anterior.
5. Limitar esta interpretación a la tool de búsqueda permitida; sin herramientas de escritura.
6. Pedir el tema si falta antecedente; nunca buscar una consulta genérica para aparentar éxito.
7. Cubrir regresiones, comprobar Gemini sin envíos, desplegar y documentar los límites observados.
8. Commit y push solo a `phase-1-nucleo`; revisión del arquitecto pendiente, sin Fase 2.


## Resultado de la segunda ronda manual

Tres solicitudes nuevas verificadas por ID/texto en Evolution y outbox, con entrega
única. Visión volvió a funcionar; las dos búsquedas posteriores fallaron por tema
y por intención respectivamente. No se atribuyen a cuota ni a transporte. Se
registran como fallidas en `FASE-1-PRUEBAS.md`, con causa en INC-20261016-06.

DEC-026 separa búsquedas completas sin IA de referencias que requieren contexto
y conserva la intención anterior. La interpretación queda limitada a búsqueda,
con rechazo por código de otras tools y respeto del módulo/ámbito autorizado. Una
consulta sin tema pide aclaración; no inventa fechas. Se evita estrechar «nueva
temporada» a un número no solicitado por memoria del modelo. No hay migraciones,
dependencias nuevas ni modificación de notas, recordatorios o grupos.

Typecheck, lint, build y 140 tests correctos. Integración real Gemini + SearXNG en
base aislada con ambas solicitudes: 1747/2328 ms y resultados de la serie/estreno,
cero mensajes a WhatsApp. Fuentes se envían como resultado canónico. No se afirma
que las fechas de terceros estén verificadas editorialmente. La repetición física
de esa secuencia y las demás comprobaciones manuales pendientes se omiten por DEC-030.
Rama `phase-1-nucleo`, sin merge a `main` ni Fase 2; revisión del arquitecto pendiente.

Despliegue final de esta corrección: **`f56dbc1`**, por script oficial con respaldo
verificado. Health HTTP 200 (03:48 UTC), base/Evolution conectados, app/worker/SearXNG
saludables y sin errores nuevos de arranque. Datos de notas/recordatorios auditados
conservados y cero grupos habilitados fuera de Lab. Documentación posterior a ese
commit no cambia el código desplegado.

## Plan de corrección de utilidad visual y personalidad

1. Incorporar la instrucción del dueño: sustancia e incertidumbre antes de la burla.
2. Resolver preguntas de raza sin cita contra la última imagen propia del chat, máximo diez minutos (§6.5).
3. Conservar precedencia de adjunto/cita y rechazar referencias desconocidas sin fallback a otra foto.
4. Mantener permisos, módulo de visión, cuota y descarga autenticada existentes.
5. Añadir regresiones de ámbito/retención y evaluación real reproducible de utilidad más personalidad.
6. Comprobar ambas búsquedas con Gemini/SearXNG reales sin envíos a WhatsApp.
   Conservar la petición segura si un resultado filtrado no puede guardarse en contexto.
7. Ejecutar controles, publicar, desplegar por script con respaldo y verificar salud.
8. Repetición física originalmente propuesta, luego omitida por DEC-030; detenerse para el arquitecto, sin merge ni Fase 2.

## Resultado de corrección de utilidad visual y contexto

DEC-027 prioriza contenido e incertidumbre sobre la burla y recupera los píxeles
propios recientes para preguntas breves de raza sin cita. DEC-028 corrige un fallo
adicional encontrado en la evaluación real: un enlace largo activaba el filtro y
eliminaba también la petición de estreno del contexto. Ahora la petición segura se
conserva; el resultado filtrado permanece excluido. Los turnos consecutivos del
mismo rol se agrupan al construir el payload de Gemini.

153 tests, typecheck, lint y build correctos. Gemini real describió el meme, dio
una raza tentativa con límites explícitos y respondió aritmética antes de la burla.
Tras corregir persistencia, ambas búsquedas usaron SearXNG real conservando
Re:Zero y estreno/nueva temporada. Detalles, consumos y límites en
`FASE-1-PRUEBAS.md`. Ningún mensaje a WhatsApp desde las evaluaciones aisladas;
sin migraciones, dependencias ni cambios a Evolution. El dueño omitió la nueva
secuencia manual y las demás pruebas físicas pendientes (DEC-030); no se registran
como ejecutadas ni aprobadas. La fase queda lista para cierre con la evidencia
automática/integración aceptada y revisión del arquitecto previa al merge.

Despliegue de esta corrección: **`38163f2`**, mediante el script oficial con
respaldo previo verificado. `/health` HTTP 200 a las **10:20 UTC del 16-10-2026**,
base y Evolution conectados; app/worker saludables y con la imagen correspondiente.
Sin errores nuevos de arranque, notas/recordatorios conservados y cero grupos
habilitados fuera de Lab. Los commits documentales posteriores no cambian la imagen.
Rama publicada `phase-1-nucleo`; sin merge ni Fase 2. Todas las pruebas físicas
adicionales pendientes se omiten por instrucción del dueño; fase lista para cierre
con revisión del arquitecto previa al merge pendiente.
