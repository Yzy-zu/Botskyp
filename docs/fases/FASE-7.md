# Fase 7 — Mensajes, difusión, Nuclear y Drive

Rama `phase-7-mensajeria-difusion-nuclear-drive`, base
`ffc30aa3e210363a8d565defd28901d0639a80f8`. Fases 0–6 cerradas/fusionadas por
instrucción directa del dueño. Solo Fase 7; sin merge ni Fase 8. Un constructor.

**Estado: aprobada arquitectónicamente y lista para cierre técnico** (DEC-054,
17-10-2026). Sin correcciones de código, migraciones, scripts ni configuración.

Plan previo (cambio crítico, aprobado arquitectónicamente según DEC-054):
1. Migración aditiva para destinos resueltos, operaciones/objetivos y consultas Drive.
2. Envíos y difusión owner-only con destinos locales explícitos, preview y confirmación ligada.
3. Nuclear owner-only en grupos: 5–10 mensajes, 8 por defecto, mínimo 1,5 s, cooldown.
4. Jobs persistentes cortos, una outbox por objetivo, cancelación y reanudación sin ráfagas atrasadas.
5. Revalidar permisos/módulos/destinos antes de cada envío; pausa ante fallo o incertidumbre.
6. Reconciliar evidencia positiva; nunca repetir éxitos ni efectos externos ambiguos.
7. Drive separado de rclone readonly: OAuth local, carpetas permitidas y enlaces restringidos.
8. Descargas/subidas asíncronas con ámbito, hash/tamaño, retención y auditoría.
9. Tests de permisos, concurrencia, tasa, SIGKILL y regresión completa, sin Nuclear real.
10. Deploy oficial con backup/health, evidencia y guía Lab; detenerse para revisión.

## Alcance documental

§3 Fase 7, §5.8–5.11, §6.2/6.4, §9.8 y §9.10. Incluye envíos a contactos/chats,
difusión confirmada, Nuclear y búsqueda/información/descarga/subida de archivos
Drive autorizados. No incluye un programador genérico nuevo, encuestas, lore,
moderación avanzada ni reacciones. Escuela/lluvia mantienen sus programaciones
CDMX existentes; no se añade catch-up masivo. Respaldos externos y biblioteca
conservan sus credenciales/arquitectura independientes.

## Migración y arquitectura

`009_messaging_drive.sql`, aditiva: `messaging_destinations`, `bulk_ops`,
`bulk_targets`, `drive_entries` y `drive_operations`; índice único de solicitudes
Drive en `jobs`. No cambia 001–008, no elimina datos. Reutiliza jobs, sesiones,
outbox, audit_log y media_attachments existentes. Sin dependencias nuevas.

El inbox solo crea borradores/jobs y responde. Un único dispatcher bulk en worker
consulta PostgreSQL cada 250 ms, independiente de esperas de multimedia/rclone/Drive.
Las operaciones masivas son jobs persistentes con tareas breves: solo encolan el
siguiente objetivo cuando el anterior tiene resultado. El outbox de app cruza la
frontera de red; no hay timers por objetivo ni fanout de cientos de promesas.
Los trabajos Drive/media comparten cola y límites, se procesan de uno en uno y
respetan orden de antigüedad entre ambos tipos. Biblioteca/rclone permanece intacta.

## Mensajería y permisos

| Comando | Acción / permiso |
|---|---|
| `bot destinos` | Lista referencias `dN` de destinos permitidos, solo owner |
| `bot enviar d1 \| Texto` | Borrador de un envío, solo owner |
| `bot difundir d1,d2 \| Texto` | Borrador de campaña explícita, solo owner |
| `bot nuclear [5–10] \| Texto` | Borrador de ráfaga al grupo actual, solo owner |
| `sí` / `no` | Confirmación ligada o cierre de interacción; dos minutos |
| `bot operaciones` / `bot operacion <id>` | Estado/resultados del actor y chat de origen |
| `bot operacion cancelar <id>` | Retira pendientes; no revoca un envío ya en curso |
| `bot reintentar fallidos <id>` | Solo fallidos definitivos, nunca inciertos ni confirmados |
| `bot operacion continuar <id>` | Retoma pendientes después de reconciliar una pausa |

Permisos nuevos: `bulk.broadcast`, `bulk.nuclear`, `drive.use`. Miembros/admins no
adquieren permiso global de difusión. Ninguna tool de estos módulos es invocable
por Gemini. Argumentos Zod strict; destino es una referencia local, no un JID.
Identidad, origen, destinatario, permisos y roles siempre desde backend.

Destinos: solo Lab o privados ya autorizados por membresía vigente/aprobación
manual; se excluye al bot y se comprueba de nuevo antes del envío. Una lista de
destinos vieja no concede permisos. Se conserva la barrera global de Fases 0–6:
ningún grupo fuera de Lab recibe ni activa Fase 7. Módulos nuevos `messaging` y
`drive`, con activación explícita fuera de Lab pendiente de otra autorización.

La preview conserva contenido, destinos, cantidad, sufijo/variantes, ritmo y
menciones. Su hash, actor/chat, operación, versión y vencimiento se comprueban al
confirmar; sesión y job/objetivos se consumen/crean transaccionalmente. Unique por
actor/chat/mensaje/tipo y por objetivo/outbox evita replays y dobles ejecuciones.

## Nuclear y límites

Nunca llama expulsiones ni moderación. Mensajes de texto, **5–10**, defecto **8**,
con sufijo exacto `[n/total]` anunciado; mínimo **1,5 s** desde el envío anterior
confirmado. Por carga/red/acuse puede tardar más, nunca acelera para recuperar una
caída. Menciones iniciales **0**; el contrato `mentioned` existe, pero su fiabilidad
física no está comprobada. No se usa `mentionsEveryOne`. Bot, owner, admins e
identidades protegidas no reciben menciones de esta implementación.

La aprobación arquitectónica confirma que **Nuclear sin menciones cumple §9.10**,
porque las menciones están condicionadas a soporte fiable de Evolution. La ráfaga
obligatoria sigue siendo de **5–10 mensajes**, con todos los límites implementados.

| Límite | Valor |
|---|---:|
| Nuclear activo/pausado | 1 por grupo |
| Cooldown Nuclear / máximo global | 10 min por grupo / 2 por hora |
| Campaña / texto | 20 destinatarios / 1.000 caracteres |
| Ritmo campaña | mínimo 2 s + jitter de hasta 0,5 s |
| Operaciones pendientes / confirmadas | 2 globales / 5 por hora |
| Volumen previsto | 100 mensajes por 24 horas, ventana móvil |
| Jobs activos por actor / global | 2 / 20, compartidos con media/Drive |
| Reintentos manuales por objetivo | 2, conservando `Retry-After` |
| Intervalo general outbox por chat | 1 s, además del ritmo de operación |

Cancelación y reclamación se serializan con lock de operación. Si ya salió a la
red, el mensaje conserva `sending/uncertain` y su evidencia; no se promete
revocarlo. Reinicio recupera solo pendientes y reconcilia el intento interrumpido.
Fallo o incertidumbre pausa el resto. Se puede continuar solo cuando no queden
inciertos/en curso; fallidos requieren orden explícita. Avisos de progreso cada
cinco confirmados y resultado por objetivo, sin convertir en éxito la aceptación.

Evolution 2.3.7 instalado y fuente versionada verificados: sendText, respuesta
key/status, historial `MessageUpdate`, contrato de menciones. Para Fase 7, 2xx con
`PENDING` queda incierto con ID. Acuses admitidos: SERVER_ACK/DELIVERY_ACK/READ/PLAYED;
«confirmado por proveedor» no equivale a lectura humana. 429 pausa y conserva
Retry-After, 4xx definitivos fallan, 5xx/408/red/timeout son inciertos. Historial
vacío no prueba ausencia; no se repite a ciegas. Outbox anterior conserva su contrato.

## Archivos y Drive

| Comando | Alcance |
|---|---|
| `bot drive configurar on/off` | Owner/admin del chat; no configura OAuth |
| `bot drive buscar <texto>` | Consulta asíncrona en raíz del chat, hasta 20 resultados |
| `bot drive info <id>` | Metadatos de la propia consulta vigente |
| `bot drive descargar <id>` | Selección por referencia propia, válida cinco minutos |
| `bot drive subir` | Adjunto propio actual/citado/reciente; nunca el de otra persona |
| `bot drive trabajos` | Estado propio y de la entrega, incluidos review/fallos |
| `bot drive cancelar <job>` | Solo antes de comenzar a procesarlo |

Drive operativo usa OAuth propio, separado de rclone readonly de biblioteca.
Credenciales 600 en `.local/drive/config.json`, directorio privado montado read-only
**solo en worker**, sin secretos en app/Git/logs. `DRIVE_ENABLED=false` inicial,
más settings.drive y módulo por chat. Sin configuración se rechaza honestamente;
la biblioteca local no depende de ello.

Raíz allowlisted por chat, propiedad de la cuenta OAuth y ACL solo owner. Solo
archivos binarios directos; se excluyen shortcuts, carpetas como resultados,
documentos nativos y Shared Drives. Sin browsing global ni IDs remotos libres.
La selección fija carpeta, tipo, tamaño y checksum; cambios/movimientos obligan
a buscar de nuevo. Se verifican bytes, firma y checksums antes de entregar.

Descarga directa hasta 8 MB, entregada como documento en el chat de origen.
Archivos mayores hasta 32 MB solo pueden producir enlace si **ya** tienen ACL
restringida verificable al dueño/correo preconfigurado del actor; no se amplían
permisos de un archivo existente para conseguirlo. El enlace va por privado al
actor, nunca al grupo. Sin correo o ámbito seguro: fallo sin enlace público.

Subida de adjunto propio admitido, hasta 8 MB: ID Google preasignado y persistido
antes de crear, nombre generado, archivo nuevo, verificación SHA-256 y tamaño,
lector solo para el correo local del actor (caducidad siete días). Sin avisos por
correo de Google. No sobrescribe, mueve o borra archivos previos. Escritura
interrumpida/ambigua queda `review` conservando ID/hash, sin retry automático.
Si el resultado ya se guardó, una pérdida de respuesta del commit no lo degrada.

Referencias/bytes de origen conservan ámbito y siete días en media_attachments,
con el cupo compartido de 256 MB; no entran en library_blobs persistentes. No se
ejecuta limpieza destructiva remota: el archivo privado subido puede permanecer
en la cuenta del dueño; su retención remota requiere política operativa revisada.
La verificación ACL debe ser reciente (30 s) al liberar el enlace. Un retraso
superior falla sin enviar; una búsqueda/descarga nueva permite verificar otra vez.
No se verifica lectura humana ni que el destinatario haya abierto Drive.

Los fallos Drive y sus timeouts no detienen webhook, tick, bulk ni outbox. Timeout
por petición 15 s y presupuesto por cliente 90 s; sin redirect, reintento ciego o
errores crudos con credenciales. La ausencia de Drive no amplía límites multimedia.

## Configuración externa pendiente — sin secretos por chat

Para mensajería no hay credenciales nuevas. No se activa fuera de Lab y no se
ejecuta Nuclear físico durante esta implementación. Antes de una prueba real se
debe avisar al dueño el texto exacto y los cinco a diez mensajes a enviar.

Drive es opcional y sigue deshabilitado. Según DEC-054, OAuth y una política de
retención remota revisada son necesarias únicamente antes de activar Drive; no
bloquean el cierre técnico. Si el dueño desea probarlo, debe resolver ambos
requisitos antes de habilitarlo y seguir estos pasos:

1. Crear un proyecto gratuito de Google y habilitar **Google Drive API**, sin
   activar facturación. Configurar consentimiento OAuth y una credencial OAuth
   propia compatible con el flujo elegido; añadir al dueño como usuario de prueba.
2. Autorizar fuera del chat el scope `https://www.googleapis.com/auth/drive` con
   acceso offline. Se puede usar OAuth Playground con «Use your own OAuth
   credentials» y redirect URI exacto `https://developers.google.com/oauthplayground`;
   configurar ese URI en un cliente de tipo Web. Intercambiar el código por tokens
   y conservar client ID, client secret y refresh token **solo en el editor local**.
   Un proyecto OAuth en modo Testing puede caducar refresh tokens; revisar ese
   estado en la consola antes de uso continuado. No pegar tokens aquí.
3. Crear una carpeta nueva propia de My Drive, con contenido autorizado, **sin
   compartir la carpeta**. No usar Shared Drive ni shortcuts. Copiar su ID en el
   archivo local de configuración, ligado al JID real de Lab tomado de `.env`.
4. Completar `.local/drive/config.json` con las claves estrictas `clientId`,
   `clientSecret`, `refreshToken`, `ownerEmail`, `folders` y `recipients`.
   `folders` es un objeto JID-chat → ID-carpeta y `recipients` es JID-persona → correo
   verificado. No se crean asociaciones de correo a partir de mensajes o Gemini.
   Incluir al dueño si probará enlaces. Directorio 700/archivo 600, UID/GID 1000.
   El directorio ya está preparado. Para editarlo usar
   `sudoedit .local/drive/config.json`; después
   `sudo chown 1000:1000 .local/drive/config.json` y
   `sudo chmod 600 .local/drive/config.json`. No imprimir el archivo ni subirlo.
5. Poner `DRIVE_ENABLED=true` en `.env` local, ejecutar el script oficial de deploy
   desde la rama aprobada y en Lab `bot drive configurar on`. No modificar las
   credenciales, scopes, raíces ni flags readonly de la biblioteca de Fase 6.
6. Seguir FASE-7-PRUEBAS.md. Para apagar: `bot drive configurar off` y, si procede,
   `DRIVE_ENABLED=false` con despliegue oficial. No borra contenido remoto.

No se requieren OAuth ni contenido real para ejecutar los tests aislados. Las
comprobaciones físicas de Google y WhatsApp siguen pendientes y no se declaran
realizadas. Los respaldos externos/rotación heredados permanecen pendientes.

Referencias verificadas: [Evolution 2.3.7, schema](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/validate/message.schema.ts),
[servicio y acuses](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts),
[uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads),
[IDs preasignados](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds),
[permisos](https://developers.google.com/workspace/drive/api/guides/manage-sharing),
[descargas](https://developers.google.com/workspace/drive/api/guides/manage-downloads),
[OAuth offline](https://developers.google.com/identity/protocols/oauth2/web-server#offline).

## Despliegue y estado del constructor — 16-10-2026

Código **88a8281**, desplegado únicamente por `scripts/deploy.sh`, con respaldo
previo verificado `backups/botsky-20261016T234214-2620889.dump`. App y worker healthy;
`/health` HTTP 200, base/Evolution conectados. Migraciones 001–009 presentes y
checksum 009 verificado contra el SQL de la imagen desplegada.

**639/639 tests** (548 regresiones + 91 nuevos), multimedia **82/82**, procesadores
reales **17/17** sobre la imagen desplegada y wrapper Minecraft **14/14**.
Typecheck/lint/build correctos. Datos previos comprobados idénticos; Evolution
API/PostgreSQL/Redis conservan imágenes y tiempos de arranque. Sin warnings/errores
nuevos en los logs inspeccionados de app/worker. Evidencia detallada en
FASE-7-PRUEBAS.md; commits documentales posteriores no cambian estas imágenes.

Cinco tablas nuevas vacías, cero jobs de Fase 7, cero grupos habilitados fuera de
Lab. Drive operativo y biblioteca/Drive siguen deshabilitados; credenciales OAuth
nuevas ausentes. No hubo Nuclear, difusión, subidas, cambios ACL ni mensajes físicos
reales de esta fase. **Implementada, desplegada, aprobada arquitectónicamente y
lista para cierre técnico** (DEC-054). Las pruebas físicas de difusión y Nuclear
permanecen pendientes, no bloquean el cierre técnico y son requeridas solo antes
de activar fuera de Botsky Lab. No se eliminan tests ni cobertura.

La aprobación del 17-10-2026 autoriza únicamente registro documental, repetición de
verificaciones y commit/push en esta rama, sin nuevo despliegue. Evidencia de esta
repetición en FASE-7-PRUEBAS.md. **Sin merge a main ni inicio de Fase 8; el
constructor se detiene al terminar.**
