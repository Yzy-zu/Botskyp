# Fase 8 — Encuestas mínimas y pulido de producción

Rama `phase-8-encuestas-pulido-produccion`, base `1bbaa5e`.
**Estado: implementada y desplegada; auditoría arquitectónica FINAL pendiente.**
Sin merge ni declaración de Botsky v1 terminado. Los dos bloqueantes de la auditoría
se corrigen en la sección «Correcciones acotadas de auditoría» de este documento.
Alcance contrastado con DEC-054: preserva aprobaciones Fases 0–7; DEC-055 registra
la nueva instrucción y las exclusiones que sustituyen el bloque opcional antiguo.

Plan previo de cambio crítico:
1. Migración 010 aditiva: polls/options/votes, idempotencia e índices de cleanup.
2. Encuestas textuales deterministas, permisos backend, ámbito por chat y tick.
3. Auditar cada barrera Lab y usar chats.enabled; todos los módulos OFF en grupos nuevos.
4. Sincronizar grupos habilitados y revalidar entregas/efectos con permisos vigentes.
5. Persistir caída/recuperación Evolution y aviso único transaccional por outbox.
6. Backup verificado, SHA-256, rotación de siete y restore en base temporal aislada.
7. Cleanup periódico acotado de datos efímeros, sin tocar auditoría/economía.
8. Scanner sin exposición de secretos y revisión de permisos/tools/recursos.
9. Regresión global, suites reales, deploy oficial y health; solo Lab habilitado.
10. Evidencia/documentación, commit en rama y detenerse para auditoría final.

## Implementación y límites

Migración **010_polls_and_polish.sql** aditiva; no cambia 001–009 ni borra tablas.
Tablas polls/poll_options/poll_votes y poll_vote_events para idempotencia de cambios.
Índices para vencimiento de encuestas, retención, referencias de inbox por chat/actor
y consultas frecuentes de FIFO/separación del outbox. Sin dependencias nuevas.

| Comando | Permisos y comportamiento |
|---|---|
| `bot encuesta Pregunta \| Opción 1 \| Opción 2` | Owner/admin del grupo; 24 horas por defecto |
| `bot encuesta 30m Pregunta \| Opción 1 \| Opción 2` | Duración 1–10080 minutos; 2–10 opciones |
| `bot votar <id> <opción>` | Miembro vigente; un voto efectivo, modificable |
| `bot encuesta <id>` | Resultados únicamente de este grupo |
| `bot cerrar encuesta <id>` | Owner/admin; cierre manual idempotente |
| `bot habilita este chat` | Owner desde el propio grupo; módulos OFF en un grupo nuevo |
| `bot deshabilita este chat` | Owner; silencio en el grupo una vez deshabilitado |
| `bot activa <módulo> aquí` | Owner; activación individual persistente en el chat actual |

`bot habilita aquí` sigue como alias compatible. Encuestas sin votos nativos,
reacciones, sesiones de votación ni uso de Gemini. Resultados exactos canónicos.
Un máximo de diez encuestas abiertas limita admisión; cierre por tick de 5 s.
El vencimiento siempre cierra, aun con módulo apagado, pero solo anuncia resultados
si el grupo/módulo y controles siguen permitiéndolo. No se publican votantes.

## Auditoría de referencias Lab

| Ubicación | Clasificación / decisión |
|---|---|
| inbox, Evolution.send | Barrera temporal retirada; autorización persistente antes de procesar/reclamar/envíar |
| schoolDestination, reminders, games, media/library/messaging access, packs delivery, Minecraft tick, drive.configure | Barreras temporales retiradas; mantienen checks de módulo, origen/destino, identidad y rol |
| moderation obligations / EvolutionGroups | Producción comprueba chats.enabled por BD; actor/identidad protegida y condiciones de ruleta permanecen. Adaptador sin BD falla cerrado fuera de Lab para fixtures aisladas |
| messaging discovery | Descubre todos los grupos habilitados; solo ofrece los que tienen módulo messaging activo |
| main / syncEnabledGroups | Lab se crea al arrancar si falta; snapshots no habilitan chats. Refresca todos los grupos habilitados |
| moduleEnabled / creación de chat | Referencia legítima: defaults de laboratorio. Nuevos grupos guardan todos los módulos OFF |
| Evolution.participants parámetro predeterminado | Referencia legítima compatible; runtime siempre pasa el grupo seleccionado en BD |
| config, Compose, local_config, evolution-admin, capture | Identidad/configuración y capturador de diagnóstico restringido a Lab; permanecen |
| syncLabMembers | Alias de compatibilidad de fixtures; runtime utiliza syncEnabledGroups |

Privados conservan autoaprobación por pertenencia vigente a cualquier grupo
habilitado y aprobación manual separada; no se habilitan con el comando grupal.
Membresías por snapshot completo autenticado, sin inferir LID; se rechazan duplicados
canónicos y evidencias contradictorias. Una persona no toma roles de otro grupo.

Desactivar no borra datos. Una petición ya iniciada puede terminar; su evidencia
sending/uncertain se reconcilia. La autorización se comprueba al liberar cada trabajo,
destino y entrega. Los refunds/vencimientos debidos preservan la economía aunque
no se permita publicar nuevos mensajes en ese grupo.

## Respaldo y recuperación

`scripts/backup.sh`: lock compartido cron/deploy, dump custom en .partial, lectura
completa mediante pg_restore a /dev/null, rename, SHA-256/fsync/verificación y solo
entonces rotación de siete copias válidas, ordenadas por mtime/nombre. Nombres y
checksums no eligen rutas libres; sin symlinks. Copias inválidas se conservan para
inspección y no cuentan como válidas. No se borra la nueva antes de verificarla.

Rclone de backups es opcional e independiente de biblioteca/Drive. Solo se intenta
si existe binario host y `.local/backup/rclone.conf` más `remote.json`, ambos 600,
con remoto ya configurado; `remote.json` tiene únicamente `destination` con remoto
nombrado y ruta restringida. No se configura OAuth ni se activa facturación. Si
falta configuración o falla la copia, el backup local sigue siendo válido y se
informa del límite. No se afirma respaldo externo realizado.

`scripts/restore-test.sh backups/botsky-<nombre>.dump` verifica checksum y restaura
en contenedor nuevo de la imagen PostgreSQL propia, sin red, sin montajes, datos
en tmpfs, base botsky_restore_test y límites 256 MiB/0,20 CPU/64 PIDs. No usa
--clean/--create ni accede al volumen productivo. Se elimina al salir, incluso ante
fallo. Errores completos solo en diagnóstico local privado para no filtrar COPY.

## Operación, retención y seguridad

Estado Evolution mediante `/health` (healthcheck Docker cada 5 s): caída confirmada
por respuesta no-open o excepción del proveedor, fecha/UUID persistidos; reconexión
solo tras ese estado genera un aviso al primer owner canónico. Aviso y limpieza
del flag atómicos; outbox usa la reconciliación conservadora existente. No garantiza
lectura humana del aviso ni duplica un intento de entrega incierto.

Cleanup en tickCore, como máximo una vez por hora y 500 filas por tabla/ciclo:
inbox done/seen_events huérfanos/llm_usage tras **30 días**; contexto tras siete.
No elimina fuentes de jobs activos ni filas referenciadas de dedupe. Ninguna tabla
de economía, auditoría, escuela, notas, recordatorios, usuarios, sesiones, pedidos,
obligaciones, jobs u outbox se purga por esta función.

`npm run audit:secrets` revisa el árbol versionado, secretos locales por coincidencia,
patrones de keys/tokens/passwords, llaves privadas, JIDs y números personales; no
imprime coincidencias. `python3 scripts/security-scan.py --history` añade historia
alcanzable y devuelve error ante hallazgos. El diagnóstico inicial de DEC-016/057
encontró **12 blobs históricos con JIDs personales**, retenidos por tres refs locales
antiguas. La corrección autorizada elimina únicamente esas refs y sus objetos
inalcanzables; el escaneo actual e histórico queda en **cero hallazgos**. No se
reescriben commits activos. Un scanner heurístico tampoco sustituye la revisión humana.

Se mantienen tools de infraestructura/operaciones masivas owner-only, no ofrecidas
al modelo cuando corresponda. Encuestas, controles, economía/moderación y Drive
son deterministas; lecturas Minecraft estado/jugadores conservan modelCallable
según contrato previo. Schemas strict y actor/chat/roles desde backend. Los tests
comprueban estos invariantes y todos los defaults por módulo.

## Activación gradual posterior a auditoría

1. Deploy con **solo Botsky Lab habilitado**.
2. Verificar `/health`, PostgreSQL/Evolution y logs sanitizados.
3. El owner habilita Amigos desde ese grupo con `bot habilita este chat`.
4. Confirmar `bot módulos`: todos los módulos OFF; ping/control disponibles.
5. Probar en Lab y activar módulos **individualmente** con `bot activa <módulo> aquí`.
6. Repetir después con Escuela, verificando ámbitos, roles y configuración propios.
7. **Nunca activar masivamente todos los módulos sin validación previa.**

Encuestas, multigrupo y aviso físico de reconexión requieren validación WhatsApp
posterior. No se desconecta Evolution para probar ni se habilitan Amigos/Escuela
por parte del constructor. Pruebas físicas previas de otras fases mantienen sus
condiciones de activación, incluidas difusión/Nuclear, multimedia y biblioteca;
OAuth/política remota son necesarios solo si se desea activar Drive.

## Exclusiones exactas de Botsky v1

Afinidad; doxeo ficticio; moderación avanzada/completa basada en strikes/reglas;
reacciones/message_links; lore/crónicas automáticas; lore_chronicle. Se conserva
infraestructura previa, sin implementar esos módulos (DEC-055). Las exclusiones
históricas de producto —proactividad, televisión, terminal libre y YouTube— siguen
vigentes; tampoco se incorporan a esta fase.

Los nombres de grupos en destinos provienen del `subject` del snapshot autenticado
ya capturado/verificado de Evolution; se guardan en settings.group_title. Discovery
no ofrece grupos nuevos sin nombre sincronizado. Nuclear usa «Grupo actual», sin
la antigua etiqueta fija Lab. El nombre es solo presentación; nunca concede
permisos ni sustituye el ID backend ligado al hash de confirmación.

Encuestas requieren identidad canónica. Un LID sin evidencia queda temporalmente
sin acceso al módulo; una vez resuelto por el backend comparte voter_id con su
identidad canónica, evitando doble voto durante la transición. No se adivinan
asociaciones ni se conceden privilegios desde nombres o texto.

## Recursos y consultas (inspección previa al deploy)

VPS observado: 1 vCPU, 5900 MiB RAM, ~3558 MiB disponibles durante pruebas;
106 GiB libres en disco. App ~62 MiB/12 PIDs, worker ~44 MiB/12 PIDs. Base propia
~10,7 MB y siete copias verificadas, ~704 KiB en esta captura. No se modificaron
límites Docker: app 256 MiB/0,25 CPU; worker 768 MiB/0,50 CPU/64 PIDs;
PostgreSQL 384 MiB/0,20 CPU. Las cargas de prueba comparten el servidor PostgreSQL
propio con la base aislada y pueden alcanzar su límite de CPU; Evolution es separado.

EXPLAIN ANALYZE de selección pendiente: inbox 0,504 ms con inbox_queued; recordatorios
0,047 ms con reminders_due; outbox 0,097 ms y jobs 0,073 ms con scans secuenciales
por su escaso volumen actual. pg_stat_user_indexes acredita uso real de inbox_queued,
outbox_pending, reminders_due, sessions_foreground y games_due, entre otros.
No se fuerza al planner a usar índices ni se hace tuning invasivo sin problema medido.

Se conservan los bucles existentes: inbox/outbox 100 ms en espera, dispatcher bulk
250 ms, tick/obligaciones/Minecraft 5 s y refresco de membresías 60 s. Encuestas usan
el tick; cleanup usa cadencia persistida horaria. La auditoría estática no encuentra
un timer por encuesta, voto, destino o job; los plazos siguen en PostgreSQL.
Medios temporales 256 MB, biblioteca 128 MB y logs Docker rotados conservan sus
límites existentes. La historia durable de auditoría/economía/entregas se mantiene
por diseño; su crecimiento no se oculta borrando evidencia.

## Despliegue y entrega del constructor — 17-10-2026

Desplegada desde **d24eded**, exclusivamente por scripts/deploy.sh, con backup
previo verificado y migración 010 aplicada/checksum comprobado contra la imagen.
App `sha256:240e9bbea21ec8e2b50fcbfbf7064de1f52901f2c6a3c750af34dbfb0475b6be`;
worker `sha256:71effbd3a27485e4f4093dae07ee09999caee62a5bb93d4f9df5b371c85bef9f`.
Ambos healthy; health HTTP 200, database/evolution true. Evolution API/PostgreSQL/
Redis conservan imágenes y tiempos de arranque. Cero warnings/errores en los logs
inspeccionados de app/worker. Las correcciones posteriores descritas abajo afectan
scripts del host y sus pruebas; no requieren cambiar estas imágenes.

**702/702 Vitest**, multimedia **82/82**, procesadores reales **17/17** sobre worker
desplegado sin red y wrapper Minecraft **14/14**; typecheck/lint/build correctos.
Backup posterior `backups/botsky-20261017T013234-2771460.dump`, checksum verificado;
restore temporal sin red exitoso con diez migraciones, 21 filas outbox y una nota.
Contenedor de restore eliminado; producción nunca recibió una restauración. Siete
backups locales verificados; copia externa no configurada/no declarada.

Solo Botsky Lab habilitado; ningún grupo fuera de Lab ni prueba física realizada.
Tablas polls/options/votes/events vacías y defaults de grupos nuevos comprobados
OFF también desde la imagen real. Drive operativo y library Drive siguen false.
Snapshots antes/después conservan usuarios, notas, recordatorios, wallets/ledger,
auditoría, escuela, pedidos, cooperachas y obligaciones. Solo cambia chats por
metadata de nombre autenticado del grupo; no se heredan activaciones.

Captura final: app 55,79 MiB/12 PIDs, worker 41,13 MiB/12 PIDs, PostgreSQL
163,9 MiB; host **3801 MiB disponibles**, BD **11.032.243 bytes**. Límites Docker
sin cambios; sin OOM/restarts observados. No se hicieron optimizaciones invasivas.

El diagnóstico histórico anterior queda sustituido por la comprobación de las
correcciones siguientes. Sin merge ni declaración de v1 terminado; pendiente la
última revisión arquitectónica.

## Correcciones acotadas de auditoría — 17-10-2026

Solo se corrigen los dos bloqueantes solicitados; sin nuevas funcionalidades ni
redespliegue de app/worker:

1. `restore-test.sh` espera a que `SELECT 1` funcione realmente sobre
   `botsky_restore_test` mediante `psql -h 127.0.0.1`. Tanto `pg_restore` como las
   consultas posteriores usan ese mismo host TCP explícito. El servidor temporal
   por socket del entrypoint ya no satisface la espera. La regresión simula una
   primera consulta TCP fallida y exige una segunda consulta exitosa antes del
   restore; rechaza clientes sin TCP o con otra base y comprueba la eliminación
   del contenedor.
2. `history_findings(secrets)` aplica `findings(content, secrets)` también a cada
   blob histórico. Una regresión comprueba un valor privado opaco que no coincide
   con patrones generales y exige detectarlo sin imprimirlo.

Se eliminaron con `git update-ref -d`, comprobando previamente sus hashes, solo:

- `refs/local-backups/main-pre-main-sanitize-20261016T021743Z`
- `refs/local-backups/phase-0-esqueleto-pre-main-sanitize-20261016T021743Z`
- `refs/local-backups/phase-0-pre-sanitize-20261016T020154Z`

Después se ejecutaron `git reflog expire --expire=now --all` y `git gc --prune=now`.
La comparación de todas las refs antes/después confirmó que las restantes
conservaron exactamente sus hashes: main, Fase 8, refs remotas y PR incluidas.
Sin reescritura de commits activos ni force-push.

Dump nuevo `backups/botsky-20261017T021417-2836754.dump`, generado por `backup.sh`
y verificado con checksum. La **primera ejecución** del restore corregido terminó
correctamente: **migrations = 10**, outbox 21 y notas 1. Evidencia privada actualizada
en `.local/phase8-restore.log`. Contenedor temporal sin red y datos en tmpfs eliminado
al salir; no se restauró sobre producción. Resultados globales de esta corrección
en `FASE-8-PRUEBAS.md`.
