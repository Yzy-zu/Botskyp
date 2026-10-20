# Go live — 20-10-2026

Autorización del dueño: cinco grupos y usuarios Legacy, HEAD feature actual,
sin merge y Observer=false. TASKS pospuesto expresamente durante la sesión:
«por ahora las tareas no, alrato solucionamos eso pero dejalo para ponerlo».

Legacy comprobado en `/home/petrov/botsky-legacy/src`:
- `core/dispatcher.js:getAllAllowed`: unión de las cinco listas para acceso.
- `core/auth.js:isAuthorizedAdmin`: números ADMIN; grupos no conceden ese rol.
- `isAuthorizedTaskUploader` y `commands/tareas.js`: ADMIN/TASKS pueden registrar y
  consultar tareas desde privado; ADMIN configura horario/destino. Se retoman luego
  5214431851495 y 4431851495 sin modificar ni unir sus identidades.

Actual: cinco chats enabled/is_group; módulos normales ON, escuela OFF por decisión
posterior del dueño; tres números NORMAL con private_ok_manual; owner existente.
Los otros números mantienen solo sus roles WhatsApp reales, sin owner global.
Sin variables ALLOWED_* nuevas ni cambios al runtime de permisos.

Operación: backup verificado → scripts/deploy.sh →
`docker exec -i botsky-app node --input-type=module < scripts/go-live-legacy.mjs`.
El script es repetible y no borra chats. Acceso privado exterior sigue bloqueado.

Evolution 2.3.7/botsky abierta; webhook habilitado a botsky-app:3000/webhook,
MESSAGES_UPSERT y GROUP_PARTICIPANTS_UPDATE presentes. Cuatro grupos con bot en roster;
120363427750154700@g.us devuelve 404 y falta en fetchAllGroups: BOT_NOT_MEMBER.
Queda enabled esperando que agreguen al bot; los otros cuatro pueden funcionar.

Ruta existente: webhook → normalizeMessage → receive/chats.enabled → processNext
(activation/privateEligible) → ContextV2 → LLM → Policy → handler → outbox/Evolution.
No nightly ni mensajes automáticos a grupos reales. Destino escolar pendiente.

Una corrida ampliada inicial detectó dos assertions ajenas al alcance: texto antiguo
«no está configurada» frente a «Gemini no está disponible» y regex `dealer.*10`
que atraviesa campos posteriores y coincide con SafeRefs aleatorias. No se modifica
runtime por ellas. Se ejecuta después la selección específica de activación/permisos.

Checks finales previos a deploy: typecheck/lint PASS; 63 pruebas específicas de
permisos/privados/membresía y 20 de activación PASS (83 total). Runtime sin cambios.
Verificación real posterior: script aplicado; 5/5 enabled, 4/5 con roster confirmado;
3/3 NORMAL elegibles por privado y LIDs verificados. Smoke solo Lab: xp.balance/ok
con call_origin=llm y outbox sent confirmado por Evolution. Ningún ping a grupos reales.
