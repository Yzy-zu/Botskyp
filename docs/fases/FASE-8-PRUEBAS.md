# Fase 8 — Pruebas, evidencia y pendientes

Rama `phase-8-encuestas-pulido-produccion`; base `1bbaa5e`.
Estado: verificaciones automáticas y despliegue completados; pendiente auditoría
arquitectónica FINAL. Los dos bloqueantes posteriores se documentan al final;
el diagnóstico histórico inicial de DEC-057 queda sustituido por esa evidencia.
**Sin merge a main ni declaración de Botsky v1 terminado.**

## Cobertura específica

- `polls.test.ts`: creación sin IA, opciones/duración, voto único/cambio/doble voto,
  replay antiguo después de cambiar, concurrencia, resultados, cierre manual,
  expiración concurrente, flags/módulo/chat apagados, aislamiento, membresía,
  owner/admin, privados, rechazo de argumentos/backend identity y model calling.
- `multigroup.test.ts`: habilitación owner-only, módulos OFF, activación individual,
  aislamiento de notas/votos/resultados, deshabilitación, cancelación de entregas,
  inbox aceptado antes de revocar, Lab operativo, sync de todos los habilitados,
  fallo parcial del proveedor, autoaprobación privada/revocación, grupo privado
  falso, identidades duplicadas, destinos y recordatorios del segundo grupo.
- `connection-cleanup.test.ts`: desconexión/excepción, fecha inicial, reconexión,
  concurrencia, una outbox por caída, rollback del aviso/flag, reinicios con pools
  nuevos y **SIGKILL de procesos reales** durante caída y después de recuperar;
  cleanup antiguo/reciente, fuentes de jobs activos, datos persistentes preservados,
  lote máximo y ejecución idempotente/horaria.
- `production-security.test.ts` y `backup-security.py`: schemas strict, ausencia de
  actor/chat/roles como argumentos, modelCallable/permisos sensibles, defaults de
  todos los módulos, scanner de archivos versionados, rotación siete, checksum,
  corrupción, symlinks/rutas, fallo del nuevo backup y rclone opcional.

Pruebas en base `botsky_test_*` aislada, sin envíos reales. Vitest se ejecuta
secuencialmente para no compartir el puntero privado de base entre suites.
Se conservan los 639 casos previos; se adaptan las expectativas de la barrera
histórica Lab a módulos OFF/autorización persistente y se añade evidencia del roster
capturado para replay de LID. Ningún cambio reduce controles de identidad o cobertura.

## Verificaciones iniciales (no sustituyen la aceptación final)

La pasada inicial de las 639 regresiones obtuvo 635 verdes y cuatro fallos de
adaptación: dos grupos habilitados con módulos OFF esperaban silencio en lugar de
«No»; un LID sin membresía recibía silencio antes de completar la negativa segura;
el replay de fixture LID no había sembrado su evidencia de roster autenticado.
Se corrigieron la respuesta segura y los setups/expectativas; no se conceden
permisos por nombre o identificador parcial. Se exige repetir la suite completa.

Typecheck/lint/build iniciales correctos. Respaldo productivo local verificado y
restore aislado de nueve migraciones realizados antes de aplicar 010; restauró
21 filas de outbox y una nota en contenedor PostgreSQL temporal sin red, eliminado
al terminar. Esa comprobación no fue una restauración sobre producción. La
validación final se repetirá con la migración 010 desplegada.

Scanner actual: cero hallazgos. Auditoría histórica: **12 blobs con JIDs personales
heredados**, sin claves/tokens detectados por las reglas. En esa primera revisión,
`--history` falló explícitamente. Era el diagnóstico previo a eliminar las tres
refs locales antiguas según la instrucción posterior; véase la corrección al final.

## Prueba física mínima de encuestas en Lab (pendiente)

1. Owner/admin: `bot encuesta 1m ¿Qué comemos? | Tacos | Pizza` → ID y dos opciones.
2. Miembro: `bot votar <id> 1`; repetir y luego `bot votar <id> 2` → un voto efectivo.
3. `bot encuesta <id>` → Tacos 0, Pizza 1. No se muestran identidades de votantes.
4. Esperar vencimiento → un solo resultado de cierre. Votar después → rechazo.
5. Crear otra encuesta y `bot cerrar encuesta <id>` como admin → cierre manual.
6. Intentar crear/cerrar como member → «No»; admin de otro grupo no hereda el rol.

## Activación gradual después de la auditoría (pendiente, solo owner)

1. Deploy con **solo Botsky Lab habilitado**.
2. Verificar `/health` HTTP 200, PostgreSQL y Evolution conectados.
3. Habilitar Amigos desde ese grupo: `bot habilita este chat`.
4. `bot módulos`: todos OFF; `bot ping` responde sin activar funciones.
5. Activar uno por uno los módulos ya probados, empezando por encuestas/notas;
   comprobar que no aparecen datos de Lab. Nunca activar todos masivamente.
6. `bot deshabilita este chat`: sin nuevos efectos/entregas al grupo; Lab sigue operativo.
7. Repetir después con Escuela y sus configuraciones/roles propios.

No se habilitaron Amigos/Escuela para estas pruebas ni se forzó una desconexión
real de Evolution. Aviso privado real de recuperación pendiente de una caída
observada o ventana coordinada; la evidencia automática no equivale a WhatsApp.
Las pruebas/configuración pendientes de multimedia, biblioteca, difusión/Nuclear y
Drive mantienen las condiciones ya aprobadas en sus fases. No se requieren nuevos
QR ni credenciales para la validación automática de Fase 8.

## Aceptación automática previa a las correcciones de auditoría

Código funcional final `72fa05c` (commits documentales posteriores no cambian fuente).

| Comprobación | Resultado |
|---|---|
| Typecheck / lint / build | Correctos |
| Suite Vitest completa | **702/702**, 38 archivos, **584,28 s** |
| Regresiones conservadas / nuevas Fase 8 | **639 / 63** |
| Multimedia focalizada (media-jobs, media-security, media-process) | **82/82**, 3 archivos, **27,57 s** |
| Wrapper Minecraft | **14/14**, **0,043 s** |
| Backup/scanner Python | **6/6**, también invocados por Vitest |
| Scanner del árbol versionado | **0 hallazgos** |
| Scanner histórico | **12 blobs heredados con JIDs**; salida no cero intencional, valores omitidos |
| Backup real truncado | Rechazado por pg_restore; siete copias locales con checksum válido |

Las pasadas completas intermedias se interrumpieron voluntariamente al encontrar
las etiquetas Lab heredadas y el caso de transición LID→canónico. Se corrigieron
antes del deploy y se repitió íntegra la suite sobre el código final; no se usan
resultados interrumpidos como evidencia de aceptación.

## Evidencia del despliegue previo a las correcciones de auditoría

| Comprobación | Resultado confirmado |
|---|---|
| Script oficial | Deploy sano desde **d24eded**, backup previo y cron local 09:17 host |
| Migraciones | **001–010**; checksum 010 coincide con SQL de la imagen |
| App / worker | Healthy, cero reinicios/OOM observados y sin warnings/errores nuevos |
| Health | **HTTP 200**, ok/database/evolution true, transport evolution |
| Grupos | **1 habilitado: Lab; 0 fuera de Lab** |
| Defaults / polls | Todos los módulos OFF en otro grupo; tablas nuevas **0/0/0/0** |
| Procesadores reales | **17/17**, **27,462 s**, imagen inmutable desplegada, sin red |
| Backup posterior | **botsky-20261017T013234-2771460.dump**, SHA-256 válido; siete copias verificadas |
| Restore temporal | **Éxito**, diez migraciones, outbox 21/notas 1; contenedor sin red eliminado |
| Conservación | Hashes de datos persistentes comparados iguales; chats solo añade nombre autenticado |
| Evolution API / PostgreSQL / Redis | Mismas imágenes y StartedAt anteriores |
| Configuración externa | Drive/library Drive apagados; sin OAuth/rclone backup configurado |
| Recursos finales | App **55,79 MiB**, worker **41,13 MiB**, PostgreSQL **163,9 MiB**; RAM disponible **3801 MiB** |
| Git actual / historia | Árbol **0 hallazgos**; historia **12 blobs con JIDs heredados**, sin valores impresos |

Evidencia reproducible privada en `.local/phase8-*` (fuera de Git): tests-final,
multimedia, real-processors, minecraft-wrapper, deploy, health, postdeploy,
final-restore, secrets/secrets-history, before/after, query-plans y resource-stats.
Las credenciales/dumps/snapshots privados no se versionan ni se imprimen.

**Pendientes físicos reales:** secuencia de encuesta/voto/cambio/cierre en Lab;
activación gradual real de Amigos y después Escuela por el owner, tras auditoría;
recepción privada del aviso de recuperación ante una caída real observada. No se
fuerza una desconexión para probarlo. Los pendientes heredados se mantienen solo
para los módulos que el dueño decida activar, conforme a sus aprobaciones previas.

El bloqueo histórico de esa entrega se resolvió mediante la eliminación autorizada
de las tres refs locales antiguas, sin reescribir main ni Fase 8. Los resultados
vigentes de la corrección se registran a continuación. Sin merge a main ni
declaración de Botsky v1 terminado; pendiente la última revisión arquitectónica.

## Correcciones acotadas de auditoría — 17-10-2026

`tests/backup-security.py`: **8/8**. Incluye dos regresiones nuevas: readiness exige
una consulta TCP real exitosa antes de restaurar, todos los clientes PostgreSQL
usan `-h 127.0.0.1` y la base aislada; el scanner histórico detecta también valores
privados locales opacos sin mostrarlos. Las seis pruebas previas se conservan.
`bash -n scripts/restore-test.sh`: correcto.

Las únicas refs eliminadas son las tres `refs/local-backups/...pre-...sanitize...`
enumeradas en `FASE-8.md`. Snapshot privado de todas las refs antes/después confirma
que ninguna otra cambió durante la limpieza. Reflogs expirados y GC completado;
sin reescritura de commits activos ni modificaciones de refs remotas en esa operación.

Backup nuevo **botsky-20261017T021417-2836754.dump**, checksum verificado por los
scripts. Restore corregido: **primera ejecución exitosa**, **migrations = 10**,
outbox 21, notas 1. TCP explícito para espera, restore y comprobaciones posteriores.
Contenedor PostgreSQL temporal sin red, volumen tmpfs y eliminación confirmada;
producción no recibió comandos de restore. Log: `.local/phase8-restore.log`.

Revalidación sobre las dos correcciones y sus pruebas:

| Comprobación | Resultado vigente |
|---|---|
| `python3 scripts/security-scan.py --history` | **0 archivos actuales / 0 blobs históricos con hallazgos**; 431 blobs examinados antes del commit |
| `npm run audit:secrets` | **0 hallazgos** |
| Refs antiguas | **3/3 eliminadas**; todas las demás refs sin cambios durante la limpieza; objetos antiguos eliminados tras GC |
| Typecheck / lint / build | **Correctos** |
| Suite Vitest completa | **702/702**, **38 archivos**, **569,48 s** |
| Backup/scanner Python | **8/8**, incluidas las dos regresiones nuevas; también ejecutados dentro de Vitest |
| Multimedia focalizada | **82/82**, **3 archivos**, **27,77 s** |
| Procesadores reales | **17/17**, **22,057 s**, worker desplegado en contenedor aislado sin red |
| Wrapper Minecraft | **14/14**, **0,034 s** |
| `/health` | **HTTP 200**, ok/database/evolution true, transport evolution |

No se redespliegan app/worker por cambios limitados a scripts del host y pruebas.
La funcionalidad desplegada conserva las imágenes registradas arriba. Evidencia
privada de esta repetición en `.local/phase8-audit-*.log` (history, secrets,
typecheck, lint, build, tests, multimedia, processors, minecraft y health), snapshot
`phase8-audit-refs-before.json` y log del GC. Se detiene el constructor para la
última revisión arquitectónica, sin merge ni declaración de Botsky v1 terminado.
