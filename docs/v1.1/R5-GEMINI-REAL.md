# R5 — Gemini real y uso cotidiano

Base: `387f3dd47e82f201f78df262ee90d8eb5c16a615`, rama `feat/v1.1-natural-router`.
Autorización del dueño: smoke real y correcciones pequeñas, sin merge ni deploy.

Smoke completado tras retomar la pausa del dueño. Sin deploy ni merge; la nota de pausa
queda como historial en [R5-RETOMAR.md](R5-RETOMAR.md).

Plan del cambio crítico:
1. Usar REST/Gemini y herramientas existentes con BD temporal y transporte mock.
2. Revisar prompts/guards de R1–R5; conservar seguridad técnica, sin censura propia.
3. Configurar únicamente filtros ajustables oficiales y registrar bloqueos reales.
4. Probar 20–30 conversaciones coloquiales con efectos inocuos en la BD de prueba.
5. Corregir fallos observados de formato/contexto; regresiones pequeñas y checks.
6. Documentar conversaciones, resultados, consumo y pendientes de WhatsApp; detenerse.

## Revisión de contenido y proveedor

La revisión de `persona.md`, Context Builder, exposición de tools, Policy R3,
Composer, sanitizer y adapter R1–R5 no encontró clasificador NSFW, vocabulario
prohibido ni regla general para rechazar vulgaridad, humor negro o temas adultos.
El dominio `moderation` existente son warns explícitos y consecuencias de ruleta;
no clasifica ni vigila el contenido de las conversaciones. `sensitiveMemory`
limita persistencia de credenciales/datos personales; no rechaza una conversación
por ser adulta. Se conservan schemas, permisos, confirmaciones de efectos
sensibles, cuotas, idempotencia y límites de llamadas.

Se explicitan `safetySettings` con `OFF` para los cuatro filtros ajustables de
GenerateContent: acoso, odio, contenido sexual y contenido peligroso. La guía
oficial indica que `OFF` es también el default de Gemini 2.5 y posteriores; por
eso esto explicita la configuración, no demuestra que antes Botsky censurara.
`BLOCK_NONE` permite contenido con cualquier probabilidad; `OFF` apaga ese filtro.
Las protecciones inherentes (por ejemplo protección de menores) y las negativas
propias del modelo siguen siendo límites de Google; no hay bypass ni retry para
sortear un bloqueo. La configuración se verificó con REST real, no solo con un mock.
Fuentes oficiales consultadas el 17-10-2026:
[guía GenerateContent](https://ai.google.dev/gemini-api/docs/generate-content/safety-settings),
[referencia REST](https://ai.google.dev/api/generate-content#SafetySetting).

Se distinguen `llm_usage.status=provider_blocked_<motivo>` de `http_*`,
`network_error`, `timeout` y respuestas inválidas; los bloqueos conservan los
tokens que Google reporte. Un bloqueo termina sin retry, identificado como Gemini
al usuario. Las negativas expresadas en texto con `finishReason=STOP` se revisan
en la transcripción; no se añade un clasificador para adivinarlas. Las decisiones
R3 mantienen sus códigos existentes en ToolExecution/logs. Una función desconocida
se registra como `tool_not_found`, separada de una conocida fuera de exposición.
El sanitizer deja visible el nombre del proveedor para poder explicar sus límites.

## Entorno de la prueba

Gemini `gemini-3.5-flash-lite`, clave local ya configurada y free tier previamente
confirmado. Las solicitudes cruzan el REST existente contra Google. Se usa el
flujo real `receive → processNext → router → Policy → handler → outbox`, con usuarios
ficticios y una BD temporal propia. Los efectos se consultan en BD; la salida se
procesa con MockEvolution, por lo que no constituye entrega de WhatsApp real.
SearXNG es el servicio ya instalado. Minecraft usa la llave restringida existente,
solo consultas; una petición de reinicio se hace como member y debe denegarse.
Los procesadores de archivos son los existentes en el contenedor worker: solo se
usan directorios temporales de esta prueba, sin reemplazar el worker ni sus scripts.
No se crea infraestructura, no se modifica Evolution y no se activa facturación.

El primer intento de la tanda encontró el límite local de 5 solicitudes/minuto:
la reserva de cuota ocurre antes de la pausa del cliente HTTP. Se conserva como
hallazgo de recursos, no se cuenta como censura ni como conversación satisfactoria.
La repetición usa solo en su proceso `LLM_GLOBAL_RPM=30`, `LLM_USER_RPM=30`,
`LLM_DAILY_LIMIT=180`, `LLM_INPUT_TOKENS_PER_MINUTE=300000`, con pausa de 13,5 s
entre inicios de solicitudes reales. `.env` y cuotas productivas no se cambian.
Las pausas se restan al calcular latencia de funcionamiento; no son latencia de Gemini.

La tanda mostró también un problema de tono: el prompt «humillador» empujaba a
rematar incluso una cuenta sencilla con insultos largos. Se ajustó la persona
a cotorreo de compas, groserías cuando encajen y carrilla cuando la pidan. No es
un filtro de contenido: se permite la misma conversación, con menos insulto
forzado. La repetición con el prompt final respondió 42 con una broma breve, sin la humillación larga del primer pase.


## Conversaciones probadas

28 conversaciones representativas; 72 turnos contando correcciones y repeticiones
de los flujos principales. Los intentos preliminares de configuración se cuentan
aparte en el consumo. Las frases son del corpus real enviado a Gemini.

| # | Conversación / ejemplo | Resultado observado al cierre |
|---|---|---|
| 1 | «qué pedo, ando bien pinche cansado» | Respuesta coloquial, sin rechazo por groserías. |
| 2 | Carrilla por perder las llaves | Broma; el tono inicial exagerado motivó el ajuste de persona. |
| 3 | «q pdo we… q es una vpn» | Entendió los errores/slang y explicó. |
| 4 | «cuánto es el 15% de 280» | 42; corregido el descarte de JSON con Markdown. |
| 5 | Por qué se empaña el espejo | Explicación directa, sin tools. |
| 6 | Tacos de suadero → «eso con qué salsa» | Conservó suadero gracias al diálogo reciente. |
| 7 | Pizza/hamburguesa → «mejor el otro» | Identificó hamburguesa y sugirió ingredientes. |
| 8 | «cuánta feria de XP traigo» | xp.balance real; saldo leído de la BD de prueba. |
| 9 | Cobrar daily y volver a pedirlo | Premio real una vez; segundo intento denegado por cooldown R3. |
| 10 | Nota de 3 pizzas y chelas | Creó la nota compartida. |
| 11 | «mejor cámbialo» a 4 pizzas/refrescos | notes.edit con referencia real; contenido actualizado en BD. |
| 12 | «qué notas tenemos» | Listó ambas notas; corregido query=notas que devolvía vacío. |
| 13 | «acuérdate de que me caga la cebolla» | Memoria personal guardada; corregida duplicación body/fact. |
| 14 | «qué recuerdas de mí» por privado | Devolvió el recuerdo propio. |
| 15 | Mañana a las 8 → «de la noche» | Aclaró AM/PM y creó a las 20:00, sin otra llamada IA para el slot. |
| 16 | Mismo recordatorio a 21:00 y después 22:00 | Conservó día y contenido; confirmó fecha local sin ID interno. |
| 17 | Listar recordatorios | Consultó el estado persistido correcto. |
| 18 | Encuesta de tacos/pizza/hamburguesas | Creación como owner, con tres opciones. |
| 19 | Votar pizza → «me equivoqué, tacos» | Cambió el voto; quedó uno por tacos. |
| 20 | Cómo va la encuesta | Conteo real: tacos 1, otras opciones 0. |
| 21 | Blackjack de 1 XP, luego 20 y plantarse | Primer pase aumentó indebidamente a 20; corregido. Ahora explica mínimo sin ejecutar; con 20 explícitos juega y liquida la mano. |
| 22 | Ajolote: dos datos con fuentes | SearXNG real + síntesis Gemini estructurada. Tres llamadas en ese pase. |
| 23 | QR «la peda es el viernes» | PNG generado por el procesador existente; salida mock confirmada. Segundo QR del sábado también generado. |
| 24 | Leer ese QR → «eso qué decía» → sticker | Extrajo exactamente el texto, lo mantuvo en contexto y produjo WebP real. |
| 25 | Estado/jugadores/reinicio Minecraft | SSH real: online, 0/10 en ese instante. Reinicio de member denegado por R3; cero operaciones de escritura. |
| 26 | Doble sentido, BDSM consensuado, humor negro y nota vulgar | Respuestas/nota permitidas; ninguna censura de Botsky ni bloqueo de Gemini observado. |
| 27 | Buscar audio libre de lluvia | media.search denegada por puente pendiente R3, explicado sin fingir descarga. |
| 28 | Convertir Word sin archivo | REF_NOT_FOUND; pidió reenviar el archivo, sin PDF inventado. |

## Qué falló y qué cambió

- **Formato de respuesta:** fences y síntesis web en prosa terminaban en un
  fallback genérico. Se acepta el fence completo, se exige responseJsonSchema en
  síntesis y se preservan extractos/fuentes si el contrato falla.
- **Contexto:** el historial ordinario estaba guardado pero no se enviaba a R5.
  Se carga acotado y scoped como referencia; nunca como llamadas ejecutables.
- **Herramientas/argumentos:** se aclararon dominios y consultas de notas, y se
  expone una sola forma de memoria a Gemini. La edición parcial de recordatorio
  conserva datos backend omitidos; 21 pm se interpreta como 21:00. El mensaje
  actual recibe prioridad sobre archivo/poll anteriores al llenar los 20 schemas.
- **Intención sin función:** QR devolvía action_required repetidamente o pseudo
  calls en effects. La única corrección ya permitida usa functionCallingConfig.ANY,
  pasando siempre por Policy. Se describe qr_create explícitamente. Nunca se
  ejecuta un objeto effects como si fuera functionCall ni se añade otro retry.
- **Negativa artificial de Botsky:** «no hay un QR anterior guardado» activaba el
  detector de falsos éxitos por la palabra guardado. Se acotó esa comprobación a
  afirmaciones de éxito; regresión específica. Era un falso positivo técnico,
  no un filtro moral/NSFW.
- **Dinero y tono:** Gemini sustituyó 1 XP por el mínimo válido de 20 en el primer
  pase. La descripción exige respetar el importe y explicar el mínimo sin actuar;
  la repetición rechazó 1 y jugó solo con 20 expresos. No cambiaron ledger ni precios.
  Se redujo el insulto automático en persona; el sarcasmo todavía depende del modelo.
- **Montaje de multimedia:** docker cp falló por el rootfs readonly del contenedor.
  Se sustituyó solo en el script local por stdin/stdout y TemporaryDirectory en el
  /tmp existente del worker. Cuatro jobs posteriores terminaron y sus salidas se
  marcaron sent exclusivamente por MockEvolution. No se cambió el worker.

El primer pase de Minecraft no llegó al handler por una expansión denegada. La
repetición con MINECRAFT_ENABLED explícito en el proceso de prueba sí ejecutó SSH,
seleccionó status/players y negó restart. No se presenta el primer pase como éxito.

## Origen de negativas y límites

**Gemini/proveedores:** cero promptFeedback.blockReason y todos los finishReason
fueron STOP en las 80 llamadas de los flujos principales y sus repeticiones.
No se observó una negativa de contenido en los casos adultos probados. Esto describe
la muestra; las protecciones inherentes del proveedor siguen existiendo. El manejo
de bloqueos reales se verifica además mediante regresiones del adapter, sin
provocar contenido prohibido ni tratar de sortear las políticas externas.

**Botsky:** las negativas observadas procedieron de cuota local, contratos inválidos,
referencias sin archivo, cooldown del diario, permisos de Minecraft y puente media.search
no integrado. Los falsos negativos de formato/guardado y los bugs de argumentos se
corrigieron. No se encontró ni se agregó moderación general de contenido.

**Modelo:** hubo argumentos y formato incorrectos, un falso «no se puede editar»
cuando el schema había quedado fuera y un mensaje que recordó el texto solicitado
para QR aunque no había archivo generado. La cadena final sí generó/leyó bytes;
las respuestas libres todavía pueden confundir lo pedido con lo disponible. No se
promete eliminar toda alucinación mediante prompts. Los éxitos de herramientas se
presentan desde recibos backend; los archivos desde resultados reales del worker.

## Consumo y latencia

- **92 respuestas reales confirmadas** contando exploración inicial, tandas y
  repeticiones: aproximadamente **360724 tokens de entrada + 4115 de salida**,
  unos **364839 tokens totales**. No se cuentan dos reservas interrumpidas sin
  respuesta confirmada como consumo conocido. No se activó facturación.
- Desglose: 80 llamadas en el flujo principal/repeticiones (329352/3426 tokens),
  4 en baseline (9365/205), 7 en el primer intento con cuota local (19663/441)
  y 1 llamada anterior al error del script de baseline (2344/43).
- En las 80 llamadas principales: Gemini mediana **0,84 s**, p90 **1,15 s**, máximo
  **1,93 s**, midiendo fetch/respuesta. Turno completo sin pausas intencionales:
  mediana **2,60 s**, p90 **3,50 s**, máximo **8,31 s**. Incluye BD, workers cuando
  aplican y salida mock; no mide red ni entrega de WhatsApp.
- La búsqueda web repetida tardó unos **6,1 s** de trabajo útil con tres llamadas.
  Las pausas de 13,5 s del smoke se restaron; no deben interpretarse como latencia
  habitual. Algunas expansiones de capability fueron innecesarias y gastaron llamadas.
- Evidencia local ignorada por Git: r5-real*.json/log, r5-baseline*,
  r5-complete-state.json y r5-real-initial-state.json. Los estados acumulados de la
  misma BD no se sumaron dos veces. Prompts/respuestas de prueba no se añaden a Git.

## Antes de probar v1_1 desde WhatsApp

1. Esta rama sigue sin desplegar. Hará falta una prueba acotada en Botsky Lab con
   v1_1 y los módulos pertinentes, usando el mecanismo de despliegue existente;
   esta tarea no la activa ni publica.
2. Las cuotas productivas conservan sus defaults actuales: 5 RPM globales y 20
   llamadas/día. Este smoke necesitó límites distintos solo en su proceso. Para
   una sesión manual larga hay que elegir límites compatibles con el cupo gratuito.
3. Confirmar físicamente entrega de archivos/sticker y recordatorio por WhatsApp;
   aquí se confirmó solo backend + MockEvolution, con Minecraft/SearXNG/Gemini reales.
4. Los ocho puentes pendientes siguen cerrados. Buscar/seleccionar multimedia por
   texto no estará disponible por ese bridge; no se anuncia una descarga inexistente.
5. Se pueden iniciar pruebas de conversación y módulos integrados con esos límites
   conocidos. La calidad de Gemini aún varía: puede gastar una expansión innecesaria,
   responder con carrilla de más o confundir una referencia. No se añadió arquitectura
   preventiva para esos problemas ni se declara calidad perfecta.

Las dos bases aisladas de este smoke se retiraron al terminar. Se conserva el
respaldo privado `.local/r5-smoke-data.dump`, con catálogo de archivo validado en
`.local/r5-smoke-data.contents`, además del snapshot y las transcripciones. Ninguna
base productiva se modificó. La corrección de elección de apuesta es de prompt;
la fidelidad al importe solicitado queda también como punto de prueba manual.

## Validación automática y entrega

Implementación: `42bb456` en `feat/v1.1-natural-router`.

- typecheck, lint, build, diff check y revisión automática existente de secretos:
  correctos, cero hallazgos de secretos.
- La corrida completa recorrió 51 archivos: **1148/1150 casos pasaron**. Las dos
  fallas eran las comprobaciones nuevas de functionCallingConfig.ANY y prioridad
  de reminders.edit, añadidas después del inicio de la corrida: el proceso había
  compilado sus dependencias antes de esos ajustes y evaluó una mezcla de versiones.
- Sin cambiar código después del commit, se repitieron los seis archivos afectados
  contra el snapshot fijo: **190/190 casos, 6/6 archivos correctos**, incluidos ambos
  fallos anteriores. Cubren router natural, adapter REST, exposición/registro,
  contexto y tiempo semántico. No se suman los 190 a los 1148: hay solapamiento.
- Logs: `.local/r5-verified-full-tests.log`, `.local/r5-verified-frozen-tests.log`,
  `.local/r5-verified-{typecheck,lint,build}.log`. No se afirma que haya una segunda
  corrida completa de 1150 casos sobre el snapshot final; se cerraron los dos
  resultados obsoletos repitiendo íntegros los archivos afectados.

Sin deploy, merge a main, cambios a Evolution ni ocho bridges adicionales.
El cierre es del smoke y sus fixes, no una declaración de despliegue v1_1 en WhatsApp.
