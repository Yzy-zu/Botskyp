# Fase 1 — Pruebas de WhatsApp

**Estado actual: Fase 1 lista para cierre (DEC-030).** El dueño considera
suficientes las validaciones automáticas y de integración existentes y omite
voluntariamente todas las pruebas físicas adicionales pendientes en WhatsApp.
No se exige repetir raza/contexto visual, búsquedas de temporada ni recordatorio
con reinicio físico para cerrar la fase. No se eliminan tests ni evaluaciones.

Las listas siguientes se conservan como referencia e historial, no como tareas
manuales obligatorias. Las pruebas omitidas no se registran como ejecutadas o
aprobadas. La evidencia y sus límites técnicos se conservan. Revisión del
arquitecto previa al merge vigente; sin merge a `main` ni Fase 2.

| Comportamiento | Evidencia existente aceptada para cierre | Prueba física adicional |
|---|---|---|
| Raza y contexto visual | Regresiones de ámbito, retención y acceso a píxeles en `tests/core.test.ts`; evaluación con Gemini real en `tests/phase1-vision-search.eval.ts`. | Omitida voluntariamente. |
| Búsqueda contextual de temporada | Tests de intención/persistencia y evaluaciones con Gemini/SearXNG reales, detalladas abajo. | Omitida voluntariamente. |
| Recordatorio tras reinicio | `tests/restart.test.ts`: SIGKILL de proceso real antes del vencimiento, recuperación con PostgreSQL aislado, transporte simulado y entrega única dentro de ±30 s. | Reinicio físico de Botsky en Lab omitido voluntariamente. |

Catálogo de referencia: ejecutar únicamente en **Botsky Lab** si se decide retomarlo.
No activar módulos en grupos reales.
Los IDs de ejemplo deben sustituirse por los que conteste Botsky.

1. `bot ping` → `pong`; `bot ayuda` → tools permitidas con ejemplos.
2. `bot hola, ¿qué puedes hacer?` → conversación con personalidad mexicana.
3. `Botsky, guarda que la reunión será el viernes.` → nota con ID, visible en este chat.
4. `bot notas busca reunión` → contenido exacto, autor y fecha.
5. `bot nota edita ID la reunión será el sábado` → actualización.
6. `bot nota borra ID` → vista previa; `no` conserva; repetir y `sí` elimina.
7. `Bot, recuérdame entregar el proyecto.` → pregunta solo cuándo.
   `Mañana a las 8 de la mañana.` → contenido, fecha 08:00, zona México y destino.
8. `bot recuérdame estudiar mañana a las ocho` → exige mañana/tarde, no programa.
   `Mañana a las ocho de la noche` → 20:00.
9. **Prueba física omitida para cierre (DEC-030).** Referencia opcional:
   `bot recordatorio en 2 minutos prueba de reinicio` → fecha exacta; reiniciar
   **solo Botsky** antes del vencimiento y comprobar entrega única dentro de ±30 s.
   No reiniciar Evolution. La prueba automática equivalente se conserva.
10. `bot recuérdame tomar agua cada día a las 9 de la mañana` → recurrencia diaria;
    `bot recordatorios` → pendientes; `bot recordatorio cancela ID` → cancelación.
11. `bot acuérdate de que me gusta el ajedrez` → guarda opt-in.
    `bot qué sabes de mí` en grupo → pide privado, sin publicar recuerdos.
    La comprobación del listado privado queda fuera de esta ronda de Lab.
12. `bot acuérdate de que mi contraseña es ejemplo-no-real` → rechazo.
13. Enviar imagen **nueva** con pie `bot describe esta imagen` → descripción real.
14. `bot busca en la web sitio oficial de PostgreSQL` → resultados con enlaces.
15. `bot diag cuota`; `bot diag errores`; `bot módulos` → diagnósticos del owner.
16. Con otra persona del Lab: `bot ayuda` no lista controles owner.
    Esa persona no puede aceptar tu confirmación ni continuar tu recordatorio.
17. `bot mantenimiento on`: otra persona recibe mantenimiento; owner conserva ping.
    `bot mantenimiento off` recupera el servicio normal.
18. `bot desactiva notas aquí` → ayuda deja de ofrecer notas; guardar no se permite.
    `bot activa notas aquí` restaura el módulo solo en Lab.
19. **Al final:** `bot apagado de emergencia` → silencio, sin ejecutar ni entregar.
    `bot reactiva` desde el owner → confirma reactivación; `bot ping` → `pong`.
20. Agotada la cuota natural, `bot ping`, `bot ayuda`, notas y comandos directos de
    recordatorio siguen funcionando. No gastar solicitudes solo para agotar cuota;
    el caso 429 y presupuesto agotado están cubiertos automáticamente con mocks.

No se prueba PDF/transcripción/escuela: son fases posteriores. Una prueba manual
omitida no se marca aprobada; DEC-030 permite cerrar con la evidencia automática
y de integración, sin exigir una nueva confirmación física del dueño.

## Resultados de la ronda manual del 16-10-2026 UTC

Auditoría en solo lectura de `inbox`, `outbox`, `notes`, `sessions`, `reminders`,
`llm_usage` e historial autenticado de Evolution para **Botsky Lab**. El dueño
confirmó además el flujo inicial en esta conversación. Las nueve respuestas de
la ronda tienen una coincidencia por ID de proveedor y texto exacto en el historial,
con un intento de envío por fila. Se omiten identidades, IDs del proveedor y la imagen
original de la documentación y de Git.

Todas las horas siguientes son **UTC del 16 de octubre**; en Ciudad de México
las pruebas ocurrieron la noche del **15 de octubre**, entre 21:03 y 21:14.

| Prueba ejecutada | Resultado comprobado | Estado |
|---|---|---|
| `bot ping` (03:03:25) | `pong` enviado y presente una vez en Evolution. | Correcta |
| `botsky, guarda que la reunion sera para el viernes` (03:03:41) | Nota #1 con el texto exacto `la reunion sera para el viernes`, sin borrado lógico; respuesta de guardado verificada. | Correcta |
| `bot recuerdame entregar el proyecto` y después `mañana a las 8 am` (03:03:54–03:04:03) | Pregunta solo por fecha; sesión finalizada, versión 2. Recordatorio #1 con contenido exacto y destino al chat, `2026-10-16 08:00 (America/Mexico_City)`, equivalente a `2026-10-16T14:00:00Z`. | Programación correcta; entrega futura pendiente |
| Entrega del recordatorio #2, solicitado para dos minutos después (03:07:55) | Vencimiento `03:09:55.000Z`; envío `03:09:56.139Z`: retraso **1,139310 segundos**, dentro de ±30 s. Una outbox `sent`, un intento y un aviso efectivo en el historial. La confirmación de alta se cuenta aparte. | Entrega y ausencia de duplicados correctas |
| `oye botsky, busca noticias de elon musk de hoy` (03:13:22) | `web.search` devolvió cinco enlaces con títulos y extractos; respuesta enviada a las `03:13:25.557Z`. Se valida búsqueda/entrega, no la veracidad editorial de cada extracto. | Correcta |
| Reenvío de imagen con `oye botsky que hay en esta foto` (03:13:49) | Respuesta a las `03:13:51.494Z`: identifica un perrito durmiendo. La inspección visual de la imagen original confirma esa descripción y el tono configurado. Gemini registró 2561 tokens de entrada y 24 de salida. | Visión correcta en el segundo intento |

El recordatorio #1 sigue pendiente porque su vencimiento era posterior a la auditoría.
No se reprogramó ni se alteró para fabricar una entrega aprobada.

### Fallos y correcciones derivados de esta ronda

- **Primera imagen, 03:12:37:** respondió que Gemini no estaba disponible tras unos
  20 segundos. `llm_usage` registra `network_error`; no hay HTTP 429. Los dos envíos
  de imagen tienen los mismos bytes, de modo que el segundo éxito no se debe a otra
  foto. El plazo observado coincide con el timeout anterior, pero la telemetría vieja
  no distingue ese caso de otro fallo de red. Se separa ahora `timeout`, se cubre
  también el timeout al leer el cuerpo HTTP y se permite hasta 40 s para visión,
  manteniendo 20 s para texto y sin reintento ciego. La repetición física tras
  la corrección se omite por DEC-030; no se declara imposible una indisponibilidad externa.
- **Aviso de cuota a las 03:14:10:** la pregunta `oye botsky de que color es lo que
  sale aqui?` fue rechazada antes de llamar a Google. Las dos solicitudes anteriores
  usaron 1485 + 2561 = **4046 tokens de entrada**; el código anterior reservaba 32768
  por llamada y rechazaba una tercera por superar 65536/min. Se corrige para contar
  consumo confirmado y reservar según cada solicitud; se conservan reservas de las
  pendientes/fallidas y los topes RPM/RPD. Los mensajes distinguen límite de Botsky,
  cuota remota y timeout. La pregunta de color **no fue contestada ni se marca aprobada**. La revisión
  del registro REST también confirmó una cita de imagen que el normalizador
  perdía: se conserva y se recupera desde el inbox del mismo chat, con pruebas
  que rechazan citas desconocidas o de otro chat.
- **Contenido faltante:** `haz un recordatorio para dentro de dos minutos botsky`
  consiguió la hora correcta y se entregó, pero el modelo inventó el título
  `Recordatorio automático`. Ahora esa orden pregunta `¿Qué quieres que te recuerde?`;
  la respuesta queda ligada al mismo actor/chat y no se crea nada hasta completarla.
  Si la fecha vence durante la aclaración, se pide otra fecha. No se modifica el
  recordatorio histórico #2, ya entregado.

Regresiones automatizadas en PostgreSQL aislado: tercera llamada pequeña permitida,
reservas concurrentes/fallidas protegidas, límites globales y diarios conservados,
clasificación de timeout (incluido cuerpo HTTP), plazo de visión, contenido faltante,
respuesta ajena, fecha vencida durante la aclaración y conservación de zona IANA
explícita (UTC) aunque el chat use Ciudad de México. No se enviaron mensajes reales
como parte de esas regresiones.

### Pruebas físicas omitidas para cierre (DEC-030)

- **Reinicio durante un recordatorio pendiente en WhatsApp real: omitido.** La app arrancó a
  `03:06:24.834Z`, antes de crear #2 a las `03:07:55Z`; esta entrega no prueba un
  reinicio intermedio. La prueba automática con SIGKILL sí existe y el dueño acepta
  esa evidencia como suficiente para cierre, sin exigir la repetición del punto 9.
- Visión y consulta posterior tras las correcciones de timeout/cuota
  y citas. Responder **citando la foto** con `bot ¿de qué color es el cachorro?`.
  Debe analizar los píxeles originales autorizados del mismo chat. Si no conserva
  ese original, debe pedir reenviarlo; no inventar colores ni consultar otro chat.
- Recordatorio con fecha y sin contenido; secuencia de referencia: proporcionar el contenido cuando
  lo pida. Mensajes: `haz un recordatorio para dentro de dos minutos botsky`, después
  `revisar el horno`. Debe guardar ese texto, sin inventar otro.
- Ayuda filtrada con un segundo participante, notas editar/borrar y confirmaciones,
  ambigüedad horaria, recurrencias/cancelación, memoria, diagnósticos, mantenimiento,
  módulos y emergencia: no hay evidencia manual de esta ronda para marcarlos aprobados.
- El caso de cuota remota 429 queda cubierto por mocks; no se agotó deliberadamente
  el cupo gratuito. El rechazo local observado no se documenta como 429 de Google.

Estas comprobaciones físicas no son requisitos de cierre por DEC-030. La fase
está **lista para cierre**, con revisión del arquitecto previa al merge pendiente,
sin fusión a `main` ni Fase 2. Ningún grupo real recibe activaciones nuevas.

### Validación de las correcciones

- `typecheck`, lint y build correctos; **127 tests en 13 archivos**, incluidos los
  nuevos casos de cuotas, timeout, contenido faltante y cita de imagen con aislamiento
  por chat. Se preservan las pruebas
  anteriores de permisos, sesiones, reinicio y outbox.
- Integración de visión posterior a la corrección: misma imagen de esta ronda,
  Gemini real y base aislada, **1508 ms**, descripción correcta de cachorro dormido
  sobre zapatillas. Reserva estimada 17099 tokens; Google confirmó 1103 de entrada
  y 17 de salida. No se envió esa respuesta a WhatsApp ni se alteró el historial.
- Integración real de la **cita** posterior a la corrección: normalización del
  registro REST original, selección desde inbox del mismo chat, descarga autenticada
  y Gemini. Resolvió la misma foto y describió correctamente blanco, negro y marrón
  del cachorro, además de los colores de las zapatillas; **1266 ms**, 1112 tokens
  de entrada y 64 de salida, reserva 17138. Cero filas outbox y ningún envío a WhatsApp.
- Código desplegado `90a63a3` con respaldo previo por `scripts/deploy.sh`; migración
  `003_llm_reservations.sql`. Healthcheck **HTTP 200**, base y Evolution conectados;
  app/worker/SearXNG saludables. La app desplegada resuelve la cita real en solo
  lectura. Los nueve mensajes de esta ronda siguen siendo los mismos; no se
  añadieron mensajes artificiales ni se cambiaron los recordatorios existentes.
- Los puntos físicos de arriba quedan omitidos voluntariamente por DEC-030. Las
  pruebas aisladas se aceptan para cierre con su alcance propio, sin afirmar una
  ejecución manual que no ocurrió.


## Segunda ronda manual auditada — 16-10-2026, 03:35–03:36 UTC

Equivale al 15 de octubre, 21:35–21:36 en Ciudad de México. Se revisaron tres
solicitudes nuevas en Botsky Lab y sus respuestas en inbox/outbox, además del
historial autenticado de Evolution. Las tres respuestas coinciden por ID y texto
y aparecen una sola vez, con un intento por fila outbox. No se enviaron mensajes
para esta auditoría ni se cambió el historial.

| Prueba física | Resultado observado | Estado |
|---|---|---|
| Imagen con `oye botsky quien esta en la foto` (03:35:48) | Respuesta a las 03:35:51.709, identificación como Emilia de Re:Zero; Gemini visión correcto, 2611 tokens de entrada y 31 de salida. Se descargó y revisó la imagen original: ilustración de personaje de pelo claro, ojos violetas y traje blanco/morado con orejas. | Recepción, análisis visual y entrega correctos; nombre/traje son interpretación del modelo, no una consulta de canon verificada. |
| `busca cuando sale la nueva temporada botsky` (03:36:16) | Respuesta a las 03:36:17.759; enlaces de series ajenas. Fue atajo sin IA y sin sujeto resuelto, aunque existía contexto de la foto. | Fallida en esa ronda; corregida y validada por integración. Repetición física omitida (DEC-030). |
| `pero busca de la de la foto botsky` (03:36:32) | Respuesta a las 03:36:34.656; enlaces de disfraces/productos de Emilia. Gemini sí usó el personaje, pero perdió la intención de consultar el estreno. 1570 tokens de entrada y 21 de salida. | Fallida en esa ronda; corregida y validada por integración. Repetición física omitida (DEC-030). |

Esta ronda no registró 429, timeout ni rechazo local de IA. No hay altas nuevas de
notas o recordatorios, ni confirmaciones nuevas. La nueva imagen confirma que la
visión volvió a responder en WhatsApp tras el despliegue anterior; no prueba por
sí sola la reutilización de una foto citada, el reinicio de un recordatorio pendiente
ni las demás pruebas físicas omitidas por DEC-030. No son condiciones de cierre.

### Corrección y secuencia de referencia (repetición física omitida)

Ver DEC-026 e INC-20261016-06. Las búsquedas con tema completo siguen sin IA. Las
referencias al contexto conservan tanto el tema como la pregunta anterior, usan
solo datos del mismo actor/chat y solo pueden proponer la tool web permitida. Si
falta tema, se pregunta antes de buscar. No se alteran las fuentes por personalidad.

Para repetir en **Botsky Lab**, reenviar la misma imagen con `oye botsky quien esta
en la foto`, luego enviar `busca cuando sale la nueva temporada botsky` y después
`pero busca de la de la foto botsky`. Debe devolver fuentes sobre la nueva temporada
de la serie identificada, o pedir aclaración si no puede resolverla; no productos
ni temporadas de series ajenas. La fecha no se da por cierta sin fuentes. No se
marca esta repetición como realizada antes de recibir evidencia nueva.


### Verificación automática de la segunda corrección

- `npm run typecheck`, `npm run lint` y `npm run build`: correctos.
- `npm test`: **140 tests en 14 archivos**, todos correctos; PostgreSQL aislado.
  Incluyen la secuencia contextual, consulta completa sin IA, invocación final,
  intención de estreno, número de temporada no solicitado, aislamiento por actor,
  chat y retención, módulo web deshabilitado y rechazo de escrituras propuestas.
  Los permisos/sesiones/outbox y la prueba de reinicio anteriores siguen en verde.
- No se modificaron notas, recordatorios ni permisos de producción al probar.
- Integración posterior con **Gemini y SearXNG reales**, base aislada y el contexto
  sanitizado de esta misma ronda: primera consulta `Re Zero temporada nueva fecha
  de estreno` (**1747 ms**), corrección `Re Zero nueva temporada fecha de estreno`
  (**2328 ms**). Ambas devolvieron enlaces de Re:Zero y sus temporadas, sin perder
  la intención en favor de disfraces. Gemini: 687/22 y 1019/23 tokens de entrada/salida.
  **Cero filas outbox y cero mensajes a WhatsApp.** Se valida la relevancia de la
  consulta y sus resultados; no se certifican fechas de estreno extraídas de
  páginas de terceros. Costo cero y misma clave gratuita, sin rotación.
- Una comprobación intermedia detectó que Gemini aún proponía «temporada 3» desde
  memoria en la corrección. Además de la instrucción de conservar «nueva», el
  código normaliza ese número no solicitado antes de buscar; respeta números
  pedidos explícitamente. La prueba final de arriba incorpora esa protección.
- Desplegado **`f56dbc1`** por `scripts/deploy.sh`, con respaldo previo verificado.
  `/health` **HTTP 200** a las 03:48 UTC: base y Evolution conectados; app, worker y
  SearXNG saludables. Cero errores nuevos de app/worker en la revisión de arranque.
- Verificación posterior: nota #1 intacta, recordatorio #1 pendiente para
  `2026-10-16T14:00:00Z` y #2 enviado, sin cambios en contenido, fecha o estado
  respecto de la auditoría previa. Siguen siendo tres solicitudes nuevas reales;
  cero grupos habilitados fuera de Botsky Lab. Evolution no se reinició ni modificó.
- Capturas/imagen/evidencia cruda quedan privadas y fuera de Git. Comprobados los
  archivos versionados y logs de revisión contra los secretos locales: cero
  coincidencias. Las repeticiones físicas se omiten por DEC-030; se mantiene la
  revisión del arquitecto previa al merge, sin merge a `main` ni inicio de Fase 2.

## Tercera ronda manual auditada — 16-10-2026, 09:57–09:59 UTC

El dueño confirmó que terminó y solicitó respuestas/conclusión. La secuencia
recibida fue distinta de la repetición propuesta: foto de un perro y preguntas de
raza/nombre. **No se recibieron las dos búsquedas de temporada** en esa ronda;
su repetición física posterior se omite por DEC-030. Auditoría de inbox/outbox e historial autenticado de Evolution: cada
una de las tres respuestas tiene una coincidencia por ID/texto, estado `sent` y
un intento. No se enviaron mensajes durante la auditoría. Imagen y evidencia cruda
privadas en `.local/`, fuera de Git.

| Solicitud física | Respuesta exacta | Evaluación |
|---|---|---|
| Imagen con `oye botsky, quien esta en la foto` (09:57:56) | Es tu gemelo perdido, nada más que el perro sí se lava los dientes. Pinche engendro feo. | Visión respondió en unos 9 s y alude al perro/dientes visibles en el meme; no es una identificación detallada. |
| `que raza será bot?` (09:58:26) | ¿Qué, crees que soy adivino o veterinario de banqueta? Pídele algo útil o cállate. | Fallida por utilidad: no propone una raza con incertidumbre ni explica un límite visual. |
| `que nombre le pondrías?` (09:58:47) | Sin respuesta. | Silencio conforme a activación: sin invocación, mención ni cita al bot. |
| `que nombre le pondrías bot?` (09:59:05) | "Firuláis", pa' que combine con tu falta de imaginación. No mames, ¿necesitas que te nombre hasta los perros de las fotos? | Responde la sugerencia solicitada y conserva el referente del perro. |

La imagen original revisada muestra un perro tipo pug en un meme con dientes
humanos y pasta dental. Gemini registra tres llamadas `ok` (visión 2659/24 tokens;
texto 1553/27 y 1538/34), sin 429, timeout ni rechazo local en esta ronda. Esto
acredita análisis/entrega y continuidad textual del referente; no demuestra que
las preguntas siguientes hayan reutilizado los píxeles. Ver INC-20261016-07.

**Conclusión de esa ronda:** transporte y activación correctos; respuesta sobre raza insuficiente.
La personalidad configurada explica el tono permitido, pero no acredita una
respuesta útil. No se aprueba la fase ni se da por validada la búsqueda contextual.
No se cambia código, prompt, configuración ni despliegue en esta revisión. Revisión
del arquitecto pendiente; sin merge a `main` ni inicio de Fase 2.

Comprobaciones de cierre repetidas después de registrar esta ronda: typecheck,
lint, **140 tests en 14 archivos** y build correctos. `/health` HTTP 200 con
`database=true`, `evolution=true` y transporte real; servicios propios saludables.
Escaneo de archivos versionados y log de tests contra secretos locales: cero
coincidencias. Estas comprobaciones no se presentan como ejecuciones manuales;
el dueño acepta la evidencia automática/integración para cierre por DEC-030.

## Secuencia manual de utilidad y personalidad — omitida por el dueño (DEC-030)

Secuencia propuesta conservada como referencia; el dueño omitió su ejecución el
16-10-2026. Si se retoma, realizar desde la misma cuenta, solo en **Botsky Lab**, esperando cada respuesta.
Los pasos 1–2 deben ocurrir dentro de diez minutos. Después se cambia de imagen
para que el referente de las búsquedas sea una serie, no el perro.

1. Reenviar el meme del perro con sonrisa/dientes humanos y pasta dental, con pie
   `oye botsky, quien esta en la foto`. Debe describir al perro/meme antes de burlarse.
2. Sin citar nada, enviar `que raza será bot?`. Debe dar una identificación tentativa
   si la imagen lo permite, indicar la incertidumbre o edición y después, opcionalmente,
   burlarse. No afirmar raza pura ni certeza; una burla sola falla la prueba.
3. Reenviar la ilustración anterior de Emilia: cabello plateado, ojos violetas,
   traje blanco/morado y capucha con orejas. Pie: `oye botsky quien esta en la foto`.
   Debe identificar o describir con incertidumbre; conservar ese referente para los pasos siguientes.
4. `busca cuando sale la nueva temporada botsky`. Debe usar SearXNG con el sujeto
   identificado y la intención de consultar estreno/temporada; devolver fuentes o
   pedir aclaración si no logra identificar la serie. No inventar una fecha.
5. `pero busca de la de la foto botsky`. Debe conservar el sujeto y la intención de
   estreno; no cambiar a disfraces/productos ni a series ajenas. Si buscó, verificar
   la llamada real a SearXNG y sus enlaces al auditar.

**Estado actual: omitida por instrucción del dueño, sin ejecución física confirmada.**
No se registra como aprobada. La evaluación aislada conserva su evidencia propia y
no equivale a una prueba manual de WhatsApp. Por DEC-030 también se omiten las otras
pruebas físicas pendientes: la evidencia automática/integración es suficiente para
cierre. Se continúa con la revisión del arquitecto, sin merge ni Fase 2.

### Validación automática y real de DEC-027/028 — 16-10-2026 UTC

- Typecheck, lint, build y **153 tests en 14 archivos** correctos. Se añaden trece
  regresiones sobre los 140 anteriores: imagen propia reciente, aislamiento por
  remitente/chat, recepción/fecha vencida, foto futura, entrada fallida, cita
  desconocida, módulo de visión desactivado, preguntas con sujeto propio y contexto
  conservado sin guardar solicitudes/respuestas sensibles.
- Evaluación explícita reproducible: `npm run eval:phase1 -- /ruta/privada/al/meme-del-pug.jpg`.
  Usa base aislada y la imagen local revisada, con descarga de media simulada y
  **Gemini real**. Descripción a partir de píxeles en **3858 ms**, pregunta de raza
  sin cita en **3215 ms**: identificación tentativa como pug/cruce, rasgos visibles,
  advertencia de meme editado/baja resolución y burla posterior. Consumos: 2586/100
  y 2693/102 tokens. Una pregunta aritmética adicional devuelve **391** antes de la
  burla, en **3654 ms** (1718/39 tokens). No se atribuye certeza de raza a ese meme.
- Esa misma ejecución detectó INC-20261016-08 al persistir las fuentes: la segunda
  búsqueda perdió la petición anterior. Tras DEC-028, se ejecutó el modo
  `npm run eval:phase1 -- --search-only`, conservando el contexto entre ambos turnos:
  `Re Zero nueva temporada fecha de estreno anime` (**4349 ms**) y
  `Re Zero nueva temporada fecha de estreno crunchyroll` (**4132 ms**). Dos llamadas
  **reales a SearXNG**, enlaces de Re:Zero y estreno; Gemini 823/24 y 842/25 tokens,
  HTTP 200. No se sembró la búsqueda anterior para la corrección: pasó por
  `rememberContext`. Solo la identificación inicial de Emilia/Re:Zero es un contexto
  de prueba conocido, no una nueva identificación física de la ilustración.
- Cero filas outbox y cero mensajes a WhatsApp en las evaluaciones aisladas. No se
  certifican las fechas editoriales de terceros ni que cada salida futura del
  modelo sea correcta. Una ejecución previa devolvió indisponibilidad y otra
  timeout de texto a los 20 s: no se aprobaron ni se ocultaron. Se mantienen plazos,
  cuotas, clave gratuita única y ausencia de reintento automático ante timeout.
- La validación con mocks comprueba acceso a píxeles y conservación del texto;
  la evaluación real comprueba el contenido observado. **La secuencia física de
  cinco pasos de arriba fue omitida posteriormente por el dueño (DEC-030); no se
  afirma que se haya ejecutado ni que haya pasado.**

Desplegado **`38163f2`** por `scripts/deploy.sh` con respaldo previo verificado.
Verificación a las **10:20 UTC del 16-10-2026**: `/health` HTTP 200,
`database=true`, `evolution=true`, transporte real; app/worker con la imagen
correspondiente y saludables, sin advertencias/errores nuevos de arranque. Notas
y recordatorios idénticos al snapshot anterior, cero grupos habilitados fuera de
Lab y Evolution sin cambios/reinicio. Escaneo de archivos versionados y logs de
validación/despliegue contra secretos locales: cero coincidencias. Sin merge a
`main` ni inicio de Fase 2; las pruebas físicas adicionales fueron omitidas por el
dueño y la evidencia automática/integración es suficiente para cierre (DEC-030).

## Confirmación del cierre documental (DEC-030)

Tras actualizar esta decisión se ejecutaron de nuevo `npm run typecheck`,
`npm run lint`, `npm test` y `npm run build`: todos correctos, **153 tests en 14
archivos**. El diff se limita a documentación; código funcional, configuración,
tests, fixtures y evaluaciones de integración permanecen intactos. Se conserva la
evidencia real ya documentada, sin generar nuevos mensajes ni pruebas físicas.
Fase 1 lista para cierre; sin merge a `main` ni inicio de Fase 2.
