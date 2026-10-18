# Registro de Incidentes — Botsky

Historial operativo de fallos, causas, impacto y soluciones aplicadas en producción.

---

## Plantilla de Incidente

```markdown
### [INC-YYYYMMDD-XX] Título corto del incidente

- **Fecha/Hora:** YYYY-MM-DD HH:MM (Hora CDMX)
- **Fase activa:** Fase N
- **Síntomas:** Qué falló o qué comportamiento anómalo se observó.
- **Impacto:** Usuarios afectados, mensajes no entregados, servicios caídos.
- **Causa raíz:** Diagnóstico técnico verificado antes de aplicar parches.
- **Solución / Mitigación:** Pasos ejecutados (rollback, fix de código, reinicio controlado).
- **Lecciones aprendidas:** Qué ajuste o test previene recurrencia.
```

---

## Incidentes Registrados

### [INC-20261016-01] Colisión de alias DNS durante despliegue inicial simulado

- **Fecha/Hora:** 15/10/2026, aproximadamente 18:48 CDMX (16/10 UTC).
- **Fase activa:** Fase 0, sin tráfico de WhatsApp hacia la app.
- **Síntomas:** La migración falló por autenticación aunque la contraseña coincidía con el contenedor dedicado.
- **Impacto:** El primer despliegue quedó detenido automáticamente; no hubo cambios de datos ni reinicio de Evolution.
- **Causa raíz:** Ambos Postgres tenían alias Docker `postgres`. La app, conectada a ambas redes, podía resolver el servidor de Evolution y su autenticación rechazaba al usuario Botsky.
- **Solución:** Alias exclusivo `botsky-db` en la red privada, URL local corregida y validación adicional para el modo Evolution. El rollback conservó BD y respaldo.
- **Prevención:** Validación de host/base/usuario en configuración real y prueba desde el contenedor de la app.

### [INC-20261016-02] Ruta inicial del capturador no alcanzable desde Evolution

- **Fase activa:** Fase 0, captura inicial.
- **Síntomas/Causa:** El listener respondía en el host pero la conexión desde el contenedor hacia la pasarela del host fallaba.
- **Impacto:** No se habían capturado mensajes; se mantuvo la sesión WhatsApp abierta.
- **Solución:** Capturador diagnóstico en la red Docker existente; `GET /health` verificado desde Evolution con HTTP 200 antes de usarlo. Solo se cambió la URL del webhook.
- **Prevención:** Comprobar accesibilidad desde el emisor antes de pedir mensajes físicos.

### [INC-20261016-03] Recuperación de mensajes enviados durante captura inaccesible

- **Fase:** 0; instancia WhatsApp permaneció conectada.
- **Diagnóstico:** El dueño había enviado los mensajes a las 00:38–00:39 UTC,
  mientras la URL temporal antigua no era accesible desde Evolution. El historial
  REST confirmó siete mensajes de grupo y los logs mostraron reintentos aún activos.
- **Recuperación:** Se publicó temporalmente el puerto del capturador únicamente
  sobre `172.18.0.1:3001`. Para permitir los reintentos se añadió una regla INPUT
  exacta, solo desde `172.18.0.4` (Evolution) hacia esa IP/puerto, con comentario
  `botsky-f0-capture-recovery` y limpieza automática a cinco minutos. Fue comprobada
  con HTTP 200, y retirada manualmente al terminar; se detuvo el timer de limpieza.
  No se modificó la configuración de Evolution adicionalmente ni se reinició.
- **Resultado:** Cinco webhooks originales recuperados (audio, imagen, documento,
  reacción y privado). Los textos anteriores de grupo/cita/mención se conservaron
  como respuesta REST real del historial, identificada separadamente, sin inventar
  envelopes de webhook. La publicación temporal del puerto se retira del Compose.
- **Prevención:** Verificar capturas efectivamente escritas antes de dar por cerrada
  la etapa, además de comprobar conectividad desde el emisor.

### [INC-20261016-04] Semántica de parada manual en simulacro de reinicio

- **Contexto:** Prueba controlada de tres entregas outbox en Botsky Lab; Evolution intacto.
- **Observación:** `docker kill --signal=KILL botsky-app` dejó el contenedor detenido:
  Docker trata la acción de su CLI como parada manual y no aplica `unless-stopped`.
- **Recuperación:** Se inició explícitamente la app. Las dos filas pendientes se
  entregaron desde la BD. No se reencoló ninguna fila ni se repitió la ya enviada.
- **Resultado verificado:** Tres entregas `sent`, un intento por fila, una coincidencia
  por cita en historial real. El primer driver agotó su espera de autoarranque; el
  resultado final se verificó después de completar el reinicio explícito.
- **Decisión:** Mantener `unless-stopped`; el apagado de emergencia debe permanecer
  detenido. Se documenta el driver como SIGKILL + inicio, sin atribuirle autoarranque.

### [INC-20261016-05] Reserva fija de tokens rechaza una consulta de las pruebas manuales

- **Fecha/Hora:** 15/10/2026 21:14:10 CDMX (16/10 03:14:10 UTC), Fase 1.
- **Síntoma:** Tras búsqueda y visión correctas, una pregunta de color recibió cuota
  agotada. No existe solicitud nueva en `llm_usage` ni respuesta 429 del proveedor.
- **Causa verificada:** Cada llamada reservaba 32768 tokens; con dos en un minuto,
  la tercera superaba el tope local de 65536 aunque las dos entradas conocidas sumaban
  4046 tokens. Se confundía además este rechazo local con cuota de Google.
- **Corrección:** Migración aditiva para reserva por solicitud, contabilización de
  `promptTokenCount` confirmado, reservas conservadas cuando el consumo se desconoce,
  y mensajes distintos para límite local, cuota remota y timeout. Se mantienen los
  topes de cinco llamadas/minuto, veinte/día y ocho por usuario/minuto.
- **Otros hallazgos de la ronda:** La primera imagen terminó con `network_error`
  a unos veinte segundos; la misma foto funcionó al reenviarse. El timeout es una
  explicación compatible con el plazo, no una causa externa demostrada por los datos
  anteriores. Se incorpora clasificación precisa y plazo de visión de 40 s sin
  reintento automático. Un recordatorio sin contenido había recibido un título
  inventado; ahora se solicita el contenido antes de crearlo. La pregunta de color
  citaba una foto: además de corregir cuota, se conserva su referencia y solo se
  recuperan imágenes recibidas en el mismo chat. No se permite tomar imágenes de
  otro chat por un ID citado o propuesto por el modelo.
- **Validación:** Regresiones con PostgreSQL y HTTP simulados; los éxitos y límites
  de la evidencia física se detallan en `docs/fases/FASE-1-PRUEBAS.md`. No se modifican
  recordatorios existentes ni se reenvían mensajes del historial para probar.


### [INC-20261016-06] Búsqueda posterior a una imagen pierde tema e intención

- **Fecha/Hora:** 15/10/2026 21:36 CDMX (16/10 03:36 UTC), solo Botsky Lab.
- **Síntoma:** Después de identificar un personaje en una foto, preguntar por la
  nueva temporada devolvió series ajenas. Corregir «de la de la foto» devolvió
  productos/disfraces del personaje en vez de información del estreno.
- **Causa:** El atajo buscaba literalmente una consulta sin sujeto e incluía
  «botsky». La ruta LLM posterior tenía historial, pero no una indicación explícita
  de conservar la intención de la búsqueda anterior al resolver el referente.
- **Corrección:** DEC-026: separar consultas completas de contextuales, limpiar
  solo la invocación de búsqueda, incluir intención anterior y limitar esa
  interpretación a la tool web permitida. Pedir tema cuando falta antecedente.
- **Validación:** Regresiones de consultas exactas, contexto por actor/chat y edad,
  módulo deshabilitado, rechazo de escrituras propuestas y resultados canónicos.
  Integración real de Gemini en base aislada sin envíos a WhatsApp; detalles y
  límites en `docs/fases/FASE-1-PRUEBAS.md`. Las dos búsquedas históricas fallidas
  no se convierten en éxitos ni se reenvían. Repetición física pendiente.

### [INC-20261016-07] Pregunta sobre raza recibe burla sin respuesta útil

- **Fecha/Hora:** 16/10/2026 09:58:26 UTC, solo Botsky Lab.
- **Síntoma:** Tras recibir un meme de un perro, `que raza será bot?` obtiene una
  negativa burlona sin identificación tentativa ni explicación de incertidumbre.
- **Diagnóstico:** Gemini devolvió texto normalmente (`ok`, 1553/27 tokens), con
  entrega única confirmada por ID/texto en Evolution. No fue un fallo de cuota,
  timeout o transporte. La imagen revisada muestra un perro tipo pug con dientes
  humanos editados. El prompt permite tono agresivo; la causa exacta de la decisión
  semántica del modelo no se puede demostrar con esta telemetría. No se atribuye
  el fallo a una indisponibilidad técnica de visión.
- **Corrección posterior autorizada por el dueño:** DEC-027 incorpora utilidad e
  incertidumbre antes de la burla y recupera la última imagen propia del mismo
  chat durante diez minutos para la pregunta de raza sin cita. Gemini real respondió
  con identificación tentativa, rasgos y límite de imagen editada, seguido del
  tono configurado. Regresiones de ámbito/retención en verde. Detalles en
  `docs/fases/FASE-1-PRUEBAS.md`; repetición física omitida posteriormente por el
  dueño y evidencia automática/integración aceptada para cierre (DEC-030).
  Fase 1 lista para cierre, con revisión del arquitecto previa al merge vigente.

### [INC-20261016-08] Un resultado web filtrado elimina también la intención anterior

- **Detección:** Evaluación con Gemini/SearXNG reales en base aislada, 16/10/2026
  10:13 UTC. Primera búsqueda pertinente; la corrección siguiente pidió tema sin
  consultar SearXNG, aunque el historial conservaba la identificación de la serie.
- **Causa:** Una ruta larga en las fuentes activa el detector conservador de posibles
  secretos. `rememberContext` descartaba ambas partes del turno y no solo el
  resultado: el siguiente mensaje no recibía la petición de estreno anterior.
  Las pruebas previas insertaban esa petición directamente y ocultaban el fallo.
- **Corrección:** DEC-028: guardar la petición segura por separado y conservar
  intacto el filtro de respuestas y de peticiones sensibles. Agrupar turnos de
  igual rol al construir el payload; ninguna respuesta ficticia ni filtro relajado.
- **Validación:** 153 tests en verde, incluyendo persistencia del contexto tras URL
  larga y exclusión de secretos. Integración posterior con Gemini/SearXNG reales:
  ambas consultas conservan Re:Zero y fecha de estreno, dos búsquedas efectivas y
  cero outbox. Repetición física omitida por el dueño y evidencia aceptada para
  cierre (DEC-030). No se modifican datos históricos ni Evolution. Fase 1 lista
  para cierre, con revisión del arquitecto previa al merge vigente.

## INC-20261016-08 — Validación aislada de PDF de LibreOffice en Fase 5

- **Impacto:** solo prueba automática en contenedor aislado sin red; producción intacta.
- **Síntoma:** documento DOCX mínimo se convertía pero la validación rechazaba su PDF.
- **Causa:** LibreOffice agrega `/OpenAction` como destino pasivo de página/zoom; el
  filtro inicial rechazaba ese campo sin distinguirlo de una acción ejecutable.
- **Solución:** admitir exclusivamente array cerrado de destino pasivo; conservar
  rechazo de diccionarios de acción, JavaScript, Launch, AA y archivos embebidos.
- **Evidencia:** caso real DOCX→PDF→TXT y prueba de PDF con JavaScript; resultados
  finales se registran en FASE-5-PRUEBAS.md. Sin cambios a Evolution ni datos reales.

## INC-20261016-09 — Primera integración de audio Gemini no disponible

- **Impacto:** evaluador explícito en base aislada; cero mensajes WhatsApp y sin
  caída de producción. QR/Piper del worker ya habían pasado.
- **Síntoma:** el adaptador devolvió `LlmUnavailable(provider)` en la rama HTTP
  no exitosa; no se capturó código/cuerpo. No permite atribuirlo a cuota, formato
  o un HTTP específico. Se conserva ese límite de evidencia.
- **Diagnóstico:** una segunda ejecución equivalente, con observación de respuesta
  HTTP fallida si ocurría, aceptó el mismo flujo de audio y transcribió 34 caracteres.
- **Resultado:** integración de audio confirmada en la segunda ejecución; causa
  inicial no determinada. Sin parche funcional, cambio de clave/modelo/formato,
  facturación ni bucle de reintentos. Disponibilidad externa observada, no garantizada.
- **Evidencia:** logs privados `phase5-real-integration.log` y
  `phase5-audio-diagnostic.log`; producción siguió healthy y `/health` HTTP 200.

### [INC-20261017-R5] Respuesta correcta descartada y referencias sin contexto en smoke

- **Fase:** R5, prueba local con Gemini real; producción sin cambios.
- **Síntomas:** «15% de 280» devolvió fallback aunque Gemini respondió 42; «eso»
  tras hablar de tacos obtuvo una respuesta sin saber de qué comida se hablaba.
- **Causa:** JSON con fence Markdown no admitido por Composer; R4 omitía todo el
  diálogo guardado y solo enviaba eventos fijos de acciones.
- **Solución:** quitar únicamente el fence completo antes de validar JSON y enviar
  diálogo reciente acotado/scoped como datos de referencia. Regresiones específicas
  y repetición real documentadas en `v1.1/R5-GEMINI-REAL.md`. Sin rollback ni deploy.

- **Otros hallazgos del mismo smoke:** body/fact duplicados en memoria; búsqueda
  de todas las notas filtrada por «notas»; edición parcial de recordatorio rechazada
  por contenido omitido/21 pm; síntesis web en prosa descartada; QR expresado como
  intención sin llamada; edición oculta por slots ocupados por poll/archivo anterior;
  falso positivo de «guardado» en una explicación negativa y aumento automático
  de apuesta de 1 a 20 XP. Correcciones, regresiones y repeticiones en el informe.
- **Fallo del montaje de prueba:** docker cp falló por rootfs readonly del worker.
  Se usó stdin/stdout y su /tmp ya existente para ejecutar el mismo procesador;
  sin alterar el contenedor ni scripts productivos. QR/lectura/sticker completados.


### [INC-20261017-CANARY] DOCX y fricciones de UX en primer Lab real

- **Entorno:** sólo Lab v1.1, código e09863f; smoke humano cerrado por el dueño.
- **DOCX conocido (B):** `media.process` encoló `office_pdf`, worker terminó
  `process_timeout`. Mensaje final honesto a los 74,173 s; no PDF entregado, ni
  segunda ejecución. No se reinvestigó LibreOffice ni se afirma una causa más
  específica que el timeout observado; workstream aplazado por instrucción.
- **Otros B/C:** alias Minecraft sin exposición, estado media genérico, tono,
  búsqueda sustituida por broma, 8pm interpretado ambiguo y cancelación de
  recordatorio no disponible. Recordatorio creado una vez sigue pending hoy
  20:00 CDMX; informado al dueño. Evidencia completa en CANARY-LAB.md y transcript
  privado. Ningún parche funcional durante el smoke ni caída de app/worker.
- **Resguardo operativo:** ante previews Nuclear enviados por el dueño fuera
  del smoke, flag existente messaging=false sólo Lab; confirmación invalidada y
  sesión cancelada bajo lock. Cero operaciones Nuclear y cero escrituras
  Minecraft. No se cambió permisos ni se ejecutó la acción masiva.
- **Cierre:** sin A observados; no rollback activado. Canary se mantiene sólo Lab,
  main intacto y rollback v1 disponible. Dueño cierra con pendientes documentados;
  sin ampliación de pruebas ni arreglo de puentes.

## 18-10-2026 — WS-PARITY-1: continuaciones observadas en Canary

Solo Lab, después del primer deploy 5b1fa2f. Sin crash ni efecto remoto
privilegiado; los archivos originales permanecen retenidos.

- Reply de sticker al resultado textual de OCR: REF_NOT_FOUND. El selector
  reconocía entregas binarias, pero no el enlace outbox → job → input retenido.
  Se añade únicamente esa procedencia exacta, propia, del mismo chat, enviada
  y con backing vivo; no se permite fallback a otro archivo.
- «Ya son todas» no cerraba la colección. Gemini repetía media.collect y
  reemplazaba la sesión con otra vacía. Se amplía la gramática de cierre completo
  y repetir la misma colección conserva refs y vencimiento; otra operación pide
  terminar/cancelar primero. No se borraron bytes ni se generó un PDF ficticio.
- «Guarda un recuerdo para las ocho peeme» se dirigió a memoria y fue denegado.
  Registry distingue aviso futuro y memoria; el reloj reconoce la variante
  dictada y el programa pide fecha aunque el modelo proponga una fecha absoluta
  no expresada. La prueba Gemini aislada posterior pidió día, conservó mañana
  a las 20:00 y canceló el recordatorio.

Regresiones y límites del nuevo deploy se registran en v1.1/WS-PARITY-1.md.

Segunda ventana, código 79336fb desde 01:02:32 UTC: «para oí, para las 8 piem» y «QUE PARA OOIII» no completaron la fecha; se normaliza el reloj dictado y el fragmento para-fecha solo dentro del slot pendiente. «Kon esas hazlo» volvió a llamar collect/start, aunque conservó las dos imágenes: faltaba una acción finish en el contrato del modelo. Se agrega en v1.1 y se reutiliza el cierre existente, sin otro sistema de jobs. Gemini real aislado ya interpretó el cierre natural y dejó una única conversión en cola; entrega real se verificará después del tercer despliegue.
