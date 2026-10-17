# R3 — Policy Engine y ejecución backend

Autorización: R1/R2 aprobadas; base R2
`28d0a7e2f8aefe6a9a3a4e91a3acd03dd7265757`, exclusivamente en
`feat/v1.1-natural-router`. Sin deploy, merge, R4/R5 ni conexión de Gemini a
herramientas v2. Ningún módulo/grupo real se activa.

Plan del cambio crítico:
1. Reconstruir identidad desde inbox/turno autenticado y actorFor histórico.
2. Separar evaluación de efectos y devolver decisiones tipadas.
3. Resolver referencias opacas y revalidar recursos/propiedad en BD.
4. Reutilizar PermissionKey, schemas y handlers/servicios históricos.
5. Reclamar ledger y serializar identidades antes de cualquier handler.
6. Persistir confirmación aparte de sessions; consumirla en segundo turno.
7. Mantener efectos y resultado en la misma transacción; conservar colas existentes.
8. Validar con BD efímera, mocks externos y checks focalizados.
9. Documentar fronteras, commit/push a la rama autorizada y detenerse.

## Evaluación frente a ejecución

`evaluateToolV2` carga contexto backend y llama a `evaluateToolPolicy`.
Solo realiza SELECT: no invoca run, no abre sesiones, no crea wallets,
reservas, trabajos ni confirmaciones. Las pruebas usan transacciones PostgreSQL
READ ONLY para comprobarlo, también para Nuclear.

`executeToolV2` es la única entrada de ejecución v2. Posee un registry legacy
privado y no acepta decisiones preautorizadas ni handlers del caller. Reevalúa
siempre; solo sus ramas autorizadas pueden invocar run o los servicios históricos
de Nuclear. Los nuevos módulos no están importados desde router, Gemini, sesiones
ni worker. El router visible sigue siendo exactamente v1 en los tres modos.
El executor rechaza efectos si ROUTER_MODE no es v1_1; esto no activa el router
reservado. Solo las pruebas lo invocan explícitamente. No existe loop Gemini v2.

El contexto tiene turno, mensaje, chat/actor backend, IDs, rol, origen, ID nullable
del proveedor, executionKey, logicalActionId, padre nullable, SafeRefs, reloj y
confirmedArgsHash nullable. actorFor resuelve alias y rol desde el sender del
inbox, ignorando el actor/chat/rol del objeto entregado por el caller. Los IDs
internos del linaje los crea backend; nunca vienen de args del modelo.

Los schemas estrictos R2 rechazan campos extras, incluyendo actorId/chatId,
authorId/role/JID/PermissionKey/hash/executionKey/logicalActionId/path. También
se rechazan campos extras anidados. memory.remember admite body o fact, exactamente
uno, y los convierte al body histórico; la petición explícita sigue siendo requisito.

## Orden real de gates

1. System: emergency; excepción histórica control.reactivate. Mantenimiento permite owner.
2. Chat: habilitado, scope grupo/privado, privateEligible histórico.
3. Module: moduleEnabled y flags globales Minecraft/Drive; DENIED_MODULE_DISABLED.
4. Identidad/membresía: alias resuelto, sin LID pendiente, pertenencia fresca salvo owner.
5. Permiso: permitted(actor,chat,metadata.permission), sin roles ni permisos paralelos.
6. SafeRefs: schema estricto, snapshot scoped y recurso vivo en BD.
7. Ownership: autor de notas o notes.manage_shared; tarea propia o school.manage;
   recordatorios/memorias y recursos personales solo del usuario backend.
8. Business: adaptador explícito disponible, schema legacy, SemanticTime backend,
   validaciones de memoria, fechas/recurrencia, encuesta activa/opción y juego.
9. Economic: saldo/precios y estados backend para apuestas, packs y aportaciones; sin crear wallet ni debitar.
10. Cooldown/admisión: daily, airdrop, Minecraft, Nuclear/operaciones y cola de jobs Drive/bulk.
11. Confirmation: decisión needs_confirmation según metadata, sin writes en evaluación.
12. Ejecución: barreras de replay/identidad, confirmación persistida, handler, normalización,
   resultado durable. La evaluación precede al replay; una decisión nueva no sustituye
   el resultado histórico de una ejecución ya identificada.

Los checks de elegibilidad de lectura no sustituyen atomicidad: schemas, permisos
y servicios históricos vuelven a validar dentro de su transacción, locks y colas.
No se ha creado una segunda economía, motor de juegos ni worker.

## Referencias y propiedad

SafeRefs de R1 no admite UUID/JID crudo como fallback. SELF identifica al actor
solo en el campo memberRef. Todas las refs se limitan al chat y las personales al
usuario; después se consulta recurso vivo con filtro de chat/owner. Existen
resolvers para member/artifact/note/reminder/memory/poll/task/subject/drive/
destination/op. No se publican loaders completos de contexto: eso pertenece a
integraciones posteriores. A_LAST se resuelve por consulta backend scoped con
backing vigente; un adaptador de archivo incompleto sigue cerrado.

Los resolvers comprueban membresía fresca, borrado lógico, expiración y backing
real para archivos, propietario en recordatorios/memorias/Drive/operaciones y
destinationAllowed para destinos. Las refs escolares pueden resolver un nombre
solo con snapshot confiable, con ambigüedad explícita. No se consulta por nombre
sin scope. Una encuesta cerrada no admite voto, pero sí resultados. polls.close
conserva polls.manage.

## Confirmaciones y linaje

Migración 012 aditiva: tool_confirmations_v2 independiente de sessions. Expone
createPendingConfirmation/consumePendingConfirmation; esta última bloquea el
registro en la transacción del executor y no equivale por sí sola a autorización.
No instala Session v2 ni cambia interpretación de «sí» en el router legacy.

Turno A evalúa y persiste needs_confirmation, resolvedArgs, hash, actor/chat/tool,
logicalActionId, execution padre y expiración histórica. No corre handler.
Turno B necesita origen session y un mensaje autenticado «sí» diferente. Busca el
registro por actor/chat, reevalúa gates completos con args backend, compara rol y
PermissionKey y recalcula el hash canónico de tool + resolvedArgs + ámbito.
Las versiones relevantes de recursos, emergency/maintenance y el conjunto de memorias se vinculan al hash;
un cambio entre preview y confirmación impide ejecutar. No se reinterpreta una
fecha relativa en el nuevo turno: se conserva su instante backend original y se
valida que continúe siendo futuro.

La hija tiene turno B, parent_execution_id=A y logical_action_id compartido.
La fila A nunca se modifica. Una denegación de política en B queda como hija con
el hash de la acción original y puede invalidar el pending. Una confirmación
inválida/no coincidente se registra sin atribuirle un padre falso. Una confirmación
consumida devuelve el resultado durable de su hija y jamás repite su efecto.
El cambio de rol invalida aunque conservara algún permiso equivalente.

## Ledger, replay y fronteras de garantías

La transacción de admisión v2 usa advisory lock global; es una decisión conservadora
sin concurrencia de efectos v2 durante esta etapa. No coordina todos los workers
legacy; estos conservan sus propios locks. Reclama una fila uncertain con código
EXECUTION_IN_PROGRESS antes del handler, ya que R1 no define status new/running.
La reclamación no es visible hasta commit y no se interpreta como éxito externo.

Se comprueban execution_key, (turn,provider_call_id), mensaje/tool/args_hash y
request_hash de la propuesta por turno/tool/actor/chat. Esta última clave aditiva
permite recuperar el resultado después de que un efecto cambió el estado y la
reevaluación ya no resuelve una ref o encuentra cooldown. Los IDs del proveedor
son literales y scoped por turno, no globales. Una colisión de providerCallId
reproduce el resultado original incluso si el proveedor cambia tool/args.
Una continuación confirmada exitosa/queued/uncertain es única por acción lógica;
el consumo de pending cubre además las terminadas con error.

Efectos DB, auditoría, jobs/outbox y resultado del ledger comparten commit. Fallar
antes del commit revierte esos efectos; perder la respuesta después del commit
recupera el resultado persistido. Se prueba además matando un proceso hijo real
tras INSERT sin commit y tras commit sin emitir respuesta, siempre contra BD
efímera. Un savepoint revierte mutaciones parciales del
handler al fallar y persiste error estructurado. Los errores no se reejecutan por
replay; hace falta una nueva acción deliberada.

El ledger no envuelve handlers v1: no se promete dedupe entre invocaciones
manuales del mismo mensaje en ambos motores; la integración futura debe elegir
una sola ruta de efectos. Los modos actuales nunca ejecutan ambas rutas.

No hay exactly-once universal. Los workers mantienen garantías actuales:
Minecraft sending/review, outbox uncertain y Drive review no se convierten a ok
por inferencia ni se reenvían automáticamente. queued solo prueba encolado.
R3 no incorpora reconciliador de ledger de jobs: sus recibos queued permanecen
como constancia histórica del encolado, aunque el dominio avance después.
No se soporta un nuevo handler con escrituras remotas dentro de esta transacción:
requiere primero contrato de cola/idempotencia/reconciliación propio.

## Adaptadores y resultados

La traducción convierte SafeRefs a args backend y SemanticTime a dueAt/zona;
valida de nuevo el schema legacy antes de run. Se conservan handlers, transacciones,
locks, sesiones de juego, outbox, auditoría y workers existentes.

R3 dispone de 89 adaptadores explícitos del catálogo de 98. Los contratos simples
usan validación/traducción y run histórico con resultado provisional seguro;
mensajería/difusión/Nuclear usan draft/confirm históricos después de confirmar.
No hay habilitación automática de nuevas tools: cada nombre debe registrarse en
el allowlist de adapters, además del catálogo y sus gates.

Nueve puentes permanecen cerrados con DENIED_ADAPTER_UNAVAILABLE:
bulk.confirm, school.schedule_commit/propose/import, school.destination,
media.process/search/collect y drive.upload. Requieren completar específicamente
preview/sesión/selección de artefactos sin ignorar SafeRefs ni fabricar hashes.
Las dos tools internas no obtienen privilegios mediante un objeto vacío del modelo.
R3 proporciona resolución scoped de sus referencias y pruebas adversariales, pero
no afirma ejecución adaptada de esos nueve contratos. No hay fallback inseguro.

La elegibilidad económica cubre saldo/precio backend de packs, apuesta de
blackjack/ruleta, incorporación a lobby, doble y aportación ajustada a lo que
falta en cooperacha. El handler conserva débito/reserva real, inventario y locks.
Drive conserva driveAllowed y los límites históricos de jobs; la cola se prueba
sin iniciar worker ni acceder a Drive. Lluvia mantiene su servicio y regulación
de periodicidad histórico. Moderación exige coincidencia con una mención real del
envelope, además de la ref/membresía; no se fabrica una mención desde el modelo.

Resultados con códigos por tool y datos backend: memoria remember/list, notas
create/list/delete, recordatorios create/list, saldo/daily, votos/resultados,
blackjack/status, media.status, Minecraft status/restart y Nuclear (todas las escrituras Minecraft conservan queued/uncertain). Las listas
limitan datos personales de identidad; no se copia reply legacy a datos LLM.
Minecraft status conserva únicamente constancia de observación satisfactoria
(adapter legacy_status), pendiente exponer el estado del protocolo sin cambiar
el resultado v1. Memoria remember y notas delete conservan facts vacíos de legacy;
el status/code prueba ejecución, no inventa campos que el handler no devuelve.
Media.status enumera estados de jobs, sin inferir entrega. Las otras tools habilitadas
usan LEGACY_ADAPTER_OK provisional sin síntesis ni texto libre legado. No hay
Response Composer v2.

Mensajería/difusión/Nuclear usan draft(...,openLegacyConfirmation=false) y confirm históricos únicamente
en turno B. Ese parámetro backend conserva true por default, por lo que v1 sigue
abriendo exactamente su sesión anterior. El draft y la admisión/cola se ejecutan
en la misma transacción; si falla, se revierte el draft. Se revalida autorización de destinos antes de encolar.
El preview Nuclear de A fija
contenido exacto, grupo y 5–10 mensajes (default 8), con cooldown 10 minutos,
máximo 2/h y límites globales/cola históricos. No se envía nada en las pruebas.

## Shadow y observabilidad

El observer R2 del router permanece intacto, sin consultas adicionales. Las entradas
explícitas de evaluación v2 se pueden usar en shadow y las pruebas verifican que
incluso executeToolV2 no escribe en ese modo. No hay confirmación, consumo,
ledger, handlers, XP, jobs, WhatsApp, bulk ni SSH adicionales.

Pino registra solo selectedTool, domain, policyDecision, denialCode,
requiredConfirmation, toolExposureCount y callOrigin. No se registran args,
memorias, contenido, JIDs, paths, tokens ni hashes de confirmación. Los errores
usan códigos constantes. No se añade plataforma de observabilidad.

## Evidencia

467 pruebas únicas en 18 archivos, sin ejecutar la suite completa de 700+:

| Grupo | Archivos | Pruebas finales |
|---|---:|---:|
| Policy/ejecutor/adapters R3 | policy-v2.test.ts | 105 |
| Fundamentos y constraints R1 | natural-foundations.test.ts | 25 |
| Regresiones focalizadas v1/R1/R2 | 16 archivos | 337 |
| Total único | 18 | 467 |

Las 130 de Policy+fundamentos se ejecutaron juntas en verde después de corregir
la unicidad compuesta. Las 337 regresiones restantes pasaron en la ejecución
ampliada. Tras fortalecer linaje de intentos rechazados se repitieron las 16
pruebas afectadas y otras dos comprobaciones del vínculo padre/tool/hash, también verdes; no se suman de nuevo al conteo único.
Los scripts typecheck, lint, build y audit:secrets están en verde.
La auditoría se repite con todos los nuevos archivos añadidos al índice Git.

La ejecución ampliada detectó y se corrigieron: precedencia de unicidad/FK
incompatible con R1 (índice efectivo ahora incluye actor/chat), outbox residual
en fixtures (se trunca explícitamente) y un falso positivo del test de logging
que confundía fast_path con una ruta. La adaptación temporal corrigió el offset
UTC para cumplir validateDue histórico; no se modificó ese validador.

| Matriz Nuclear | Resultado probado |
|---|---|
| member / group_admin | denied, DENIED_PERMISSION, cero operaciones |
| owner, turno A | needs_confirmation, cero bulk_ops/jobs/outbox |
| owner, segundo «sí» válido | queued, una operación, 8 targets por default, sin envíos |
| 4 / 11 mensajes | denied; 5 / 8 / 10 admitidos a confirmación |
| privado / cooldown / tercer Nuclear en hora | denied |
| confirmación duplicada / replay | mismo recibo, sin segunda mutación |

| Matriz Minecraft | Resultado probado |
|---|---|
| member / group_admin, status | allow; cliente mock para ejecución de lectura |
| member / group_admin, restart | denied, PermissionKey infra.minecraft |
| owner, restart A | needs_confirmation; cero operaciones |
| owner, confirmación válida B | queued; ninguna llamada SSH |
| módulo, membresía, rol, flags, cooldown, hash o expiración cambian | no ejecuta |

Además: paridad de las 98 PermissionKey, READ ONLY en evaluación/shadow,
SafeRefs adversariales, propiedad, saldo/precios backend, cola Drive sin worker,
memoria frente a nota, inyección de identidad, resultados representativos,
reintentos de webhook/proveedor/origen, incertidumbre y muerte real del proceso
antes/después de commit. Los tests de linaje verifican que también los intentos
denegados conservan su padre/acción cuando el pending corresponde al mismo
actor/chat/tool/turno nuevo; no se atribuyen padres falsos a handles ajenos.

No se ejecutaron deploy, merge, migraciones de producción, WhatsApp, Nuclear,
reinicios Minecraft, OAuth ni llamadas Gemini reales. Las pruebas manuales en
WhatsApp no forman parte de esta entrega aislada; no se requiere una acción del
dueño para terminar el push. La revisión crítica previa a merge sigue pendiente.


Implementación y pruebas: `dcfad1fbd2ceba411fa858de2fc4cf066fc78c3a`.
La documentación se entrega en un commit posterior de la misma rama.
