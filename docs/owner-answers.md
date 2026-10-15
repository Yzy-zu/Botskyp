# Botsky — Cuestionario de afinación

> Cuestionario contestado.

## A. Cómo quieres trabajar con los agentes

### A1. ¿Cuántos agentes quieres trabajando al mismo tiempo?

- [ ] 1
- [ ] 2
- [ ] 3
- [ ] 4 o más
- [x] No sé / que el arquitecto decida

### A2. Antes de programar una fase, ¿quieres que el agente haga un plan?

- [ ] Sí, siempre
- [x] Solo para cambios grandes
- [ ] No, que programe directamente

### A3. ¿Puede trabajar durante horas sin preguntarte cosas?

- [x] Sí, que avance todo lo posible
- [ ] Sí, pero que pare ante decisiones importantes
- [ ] Prefiero que pregunte seguido

### A4. ¿Puede hacer commits/push a GitHub por sí solo?

- [x] Sí, commit + push
- [ ] Commit sí, push no
- [ ] No, yo hago ambos
- [ ] No sé

### A5. ¿Puede trabajar también en tu computadora o solo en el VPS?

- [ ] VPS solamente
- [x] VPS + mi computadora
- [ ] Mi computadora solamente
- [ ] Depende de la tarea

**Respuesta / detalle:** puede trabajar en donde quiera!


### A6. ¿Puede conectarse por SSH al VPS?

- [x] Sí
- [ ] No
- [ ] Sí, pero con usuario limitado
- [ ] No sé

### A7. ¿Dónde deberían trabajar principalmente los agentes?

- [ ] Directamente en el VPS
- [ ] Local → GitHub → VPS
- [ ] GitHub/Codespace → VPS
- [x] Que el arquitecto elija

### A8. Al terminar cada fase, ¿qué debe ocurrir?

- [ ] Quiero aprobarla antes de continuar
- [x] Que continúe automáticamente si las pruebas pasan
- [ ] Solo detenerse ante cambios importantes

### A9. ¿Cómo quieres los reportes de progreso?

- [ ] Muy cortos
- [x] Resumen moderado
- [ ] Detallados
- [ ] Solo avisarme cuando termine o haya un problema

### A10. ¿Quieres un agente separado que revise el código?

- [ ] Sí
- [ ] No
- [x] Solo en cambios importantes
- [ ] No sé / recomendado

### A11. ¿Hasta dónde confías en el agente programador?

- [x] Puede modificar libremente el proyecto
- [ ] Puede modificar, pero no borrar/cambiar cosas críticas sin permiso
- [ ] Quiero aprobar cambios importantes
- [ ] Muy limitado

### A12. Idioma de código/documentación

- [x] Código inglés + documentación español
- [ ] Todo inglés
- [ ] Todo español
- [ ] Me da igual

### A13. Si una decisión técnica aumenta costos

- [ ] Debe preguntarme siempre
- [ ] Puede gastar pequeñas cantidades sin preguntar
- [ ] Que optimice por costo y decida
- [ ] Otro

**Respuesta / detalle:** nunca gastare, pero tenemos acceso a cositas

## B. Tu VPS y servidor

### B1. Proveedor del VPS

- [x] Oracle Cloud
- [ ] AWS
- [ ] Google Cloud
- [ ] DigitalOcean
- [ ] Hetzner
- [ ] Otro
- [ ] No sé

### B2. RAM del VPS

- [ ] 1 GB
- [ ] 2 GB
- [ ] 4 GB
- [x] 8 GB
- [ ] 16 GB o más
- [ ] No sé

### B3. CPU / vCPU del VPS

- [ ] 1 vCPU
- [ ] 2 vCPU
- [x] 4 vCPU
- [ ] Más de 4
- [ ] No sé

### B4. Espacio en disco

- [ ] Menos de 50 GB
- [x] 50–100 GB
- [ ] 100–200 GB
- [ ] Más de 200 GB
- [ ] No sé

### B5. Sistema operativo

- [x] Ubuntu Server
- [ ] Debian
- [ ] Arch/derivado
- [ ] Otro Linux
- [ ] No sé

### B6. ¿Docker está instalado y funcionando?

- [x] Sí
- [ ] No
- [ ] No sé

### B7. ¿Qué servicios ya corren ahí?

- [x] Evolution API
- [ ] PostgreSQL
- [ ] Redis
- [ ] Caddy / proxy
- [ ] Otros
- [ ] No sé

### B8. Estado de Evolution API

- [x] Ya funciona
- [ ] Instalado pero con problemas
- [ ] Aún no instalado
- [ ] No sé

### B9. Postgres y Redis

- [ ] Ambos funcionan
- [ ] Solo PostgreSQL
- [ ] Solo Redis
- [ ] Ninguno / aún no
- [x] No sé

### B10. ¿Cómo accedes al VPS?

- [x] SSH con clave
- [ ] SSH con contraseña
- [ ] Panel web
- [ ] Otro
- [ ] No sé

### B11. ¿Tienes dominio para Botsky?

- [x] Sí
- [ ] No
- [ ] Todavía no
- [ ] No sé si hace falta

**Respuesta / detalle:** no se si haga falta, pero si tengo dominio propio

### B12. Firewall

- [x] Configurado
- [ ] No configurado
- [ ] No sé

### B13. Backups actuales

- [x] Sí, automáticos
- [ ] Sí, manuales
- [ ] No
- [ ] No sé

### B14. ¿Dónde guardar backups?

- [x] En el mismo VPS
- [ ] Otro servidor/nube
- [ ] Mi computadora
- [ ] No sé / recomendado

**Respuesta / detalle:** en donde sea, como drive, github, vps, etc

### B15. ¿Minecraft corre en este VPS?

- [ ] Sí
- [x] No
- [ ] Planeo instalarlo
- [ ] No sé

### B16. ¿Hay servidor/grupo de pruebas separado?

- [ ] Sí
- [ ] No
- [x] Lo crearé después

**Respuesta / detalle:** podriamos hacer un vps de pruebas... tengo varios vps

### B17. Costo y país/región del VPS

- [x] Gratis / free tier
- [ ] Menos de 10 USD/mes
- [ ] 10–20 USD/mes
- [ ] Más de 20 USD/mes
- [ ] No sé

## C. WhatsApp y Evolution

### C1. ¿Botsky tendrá un número dedicado?

- [x] Sí
- [ ] No, usaré uno existente
- [ ] Todavía no sé

**Respuesta / detalle:** si tendra numero dedicado, no me importa perderlo, es desechable

### C2. Tipo de línea

- [x] Prepago
- [ ] Pospago
- [ ] eSIM
- [ ] No sé

### C3. Tipo de cuenta de WhatsApp

- [x] WhatsApp normal
- [ ] WhatsApp Business
- [ ] No sé

### C4. ¿El número ya está vinculado a Evolution API?

- [x] Sí
- [ ] No
- [ ] Todavía no

### C5. ¿Estará en grupos y será administrador?

- [x] En grupos y admin
- [ ] En grupos, no admin
- [ ] Solo privado
- [ ] Depende del grupo

### C6. ¿Tienes grupo de pruebas?

- [ ] Sí
- [x] No, lo crearé
- [ ] No

### C7. ¿Tendrás acceso al teléfono físico del número?

- [x] Sí
- [ ] No
- [ ] A veces

### C8. Si WhatsApp se desconecta, ¿quieres aviso?

- [x] Sí, inmediatamente
- [ ] Sí, pero sin urgencia
- [ ] No

## D. Tu comunidad

### D1. ¿Cuántos grupos usarán el bot?

- [ ] 1
- [x] 2
- [ ] 3
- [ ] 4 o más
- [ ] No sé

### D2. ¿Para qué son los grupos?

- [x] Amigos
- [x] Escuela
- [ ] Minecraft
- [ ] Familia
- [ ] Otro

### D3. ¿Hay menores de 18 años?

- [x] No
- [ ] Sí
- [ ] No sé

### D4. Además de ti como owner, ¿habrá otros operators?

- [x] No, solo yo
- [ ] Sí
- [ ] Todavía no sé

### D5. ¿Cuántos administradores hay aproximadamente?

- [ ] Solo yo
- [x] 2–3
- [ ] 4 o más
- [ ] Depende del grupo
- [ ] No sé

### D6. En privado, ¿quién puede hablar con el bot?

- [ ] Solo yo
- [x] Solo personas que yo apruebe
- [ ] Todos los miembros de los grupos

### D7. ¿Quieres opción para salirse de XP, juegos o lore?

- [ ] Sí, quiero opción de salirse
- [x] No hace falta

### D8. ¿Todos están en la zona horaria de Ciudad de México?

- [x] Sí
- [ ] No
- [ ] No sé

### D9. ¿Tus amigos ya saben del bot y aceptan XP, lore y bromas?

- [x] Sí
- [ ] Algunos sí
- [ ] Todavía no les he dicho
- [ ] No

### D10. ¿Aceptas contexto corto de mensajes dirigidos al bot y borrado a 7 días?

- [x] Sí
- [ ] No, quiero otra cosa

### D11. ¿Qué tantas groserías puede decir?

- [ ] Ninguna
- [ ] Ligeras, de vez en cuando
- [x] Las que use el grupo

**Respuesta / detalle:** todas las que sean, no tendra restricciones

### D12. ¿Hay temas o personas con los que NUNCA debe bromear?

- [x] No
- [ ] Sí

### D13. ¿Hay reglas del grupo ya escritas?

- [x] No
- [ ] Sí
- [ ] Todavía no

## E. Personalidad y voz

### E1. Nombre oficial y apodos

- [x] Botsky · bot · botsito
- [ ] Solo Botsky
- [ ] Otros

### E2. Personalidad en 3 palabras

- [ ] Sarcástico · buena onda · flojo
- [ ] Sarcástico · irreverente · divertido
- [ ] Amigable · inteligente · relajado
- [ ] Otra

**Respuesta / detalle:** grosero, burlon. directo, sarcastico, humillador

### E3. Frases típicas del grupo

- [ ] Las agregaré en detalle
- [ ] No hace falta por ahora

**Respuesta / detalle:** hola papus
buen dia perrillos
ya hicieron la tareita?
como van prros
ya vienen geys?


### E4. Muletillas

- [x] Jerga del grupo
- [ ] Pocas
- [ ] Ninguna fija
- [ ] Otras

### E5. Emojis

- [ ] Muchos
- [x] Pocos
- [ ] Ninguno

### E6. Longitud normal de respuestas

- [ ] Cortas, al grano
- [ ] Más explicadas
- [x] Depende del tema

### E7. Si lo insultan/trollean

- [ ] Responder con humor
- [ ] Ignorar
- [ ] Contestar seco una vez y ya
- [ ] Otro

**Respuesta / detalle:** responde directamente y humilla

### E8. Si alguien está equivocado

- [x] Llevarle la contraria
- [ ] Corregir con tacto
- [ ] Ser más complaciente
- [ ] Depende

### E9. ¿Lore propio?

- [ ] Sí, que la IA lo invente
- [ ] Sí, yo lo defino
- [x] No

### E10. Voz para notas de voz

- [ ] Hombre
- [ ] Mujer
- [x] Me da igual

### E11. Ejemplos de respuestas deseadas/no deseadas

- [ ] Los escribiré en detalle
- [ ] Que el arquitecto proponga ejemplos

**Respuesta / detalle:** deseadas: aqui esta perrillo lo q pediste
no, no se de q hablas gay

no deseadas: hola chavales, ostia, che boludo

## F. IA y costos

### F1. Proveedor de IA

- [ ] Claude
- [ ] OpenAI
- [x] Google Gemini
- [ ] El más barato que funcione bien
- [ ] Modelo local
- [ ] No sé / recomendado

### F2. ¿Ya tienes cuenta/API?

- [x] Sí
- [ ] No

### F3. Máximo mensual solo en IA

- [ ] 5 USD
- [ ] 10 USD
- [ ] 20 USD
- [ ] Más

**Respuesta / detalle:** uso free

### F4. Prioridad

- [ ] Máxima inteligencia
- [x] Equilibrio
- [ ] Precio bajo

### F5. ¿Búsqueda web?

- [x] Sí
- [ ] No
- [ ] Solo cuando haga falta
- [ ] No sé / recomendado

### F6. ¿Visión de imágenes?

- [x] Sí
- [ ] No
- [ ] Solo cuando se lo pidan

### F7. Transcripción de voz

- [x] Servicio externo
- [ ] En mi servidor
- [ ] No sé / recomendado

### F8. Calidad de voz

- [ ] Muy natural aunque cueste
- [x] Sencilla/barata
- [ ] Equilibrio
- [ ] No sé / recomendado

### F9. Memoria personal entre conversaciones

- [ ] No, solo contexto corto
- [x] Sí, opcional

### F10. ¿Está bien enviar mensajes a proveedor externo de IA?

- [x] Sí
- [ ] Prefiero avisar al grupo
- [ ] No, solo local

## G. Módulos y prioridad

### G1. Notas — Fase 1

- [x] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [ ] N · No lo quiero

### G2. Recordatorios — Fase 1

- [x] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [ ] N · No lo quiero

### G3. Encuestas — Fase 1

- [ ] A · Desde el principio
- [ ] B · Después
- [x] C · Si sobra tiempo
- [ ] N · No lo quiero

### G4. Escuela — Fase 4

- [x] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [ ] N · No lo quiero

### G5. Multimedia — Fase 3

- [x] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [ ] N · No lo quiero

### G6. Documentos/PDF — Fase 3

- [x] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [ ] N · No lo quiero

### G7. Voz/transcripción — Fase 3

- [x] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [ ] N · No lo quiero

### G8. Drive — Fase 5

- [x] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [ ] N · No lo quiero

### G9. XP/niveles — Fase 2

- [x] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [ ] N · No lo quiero

### G10. Hora Feliz — Fase 2

- [x] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [ ] N · No lo quiero

### G11. Blackjack/ruleta — Fase 2

- [x] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [ ] N · No lo quiero

### G12. Cooperacha — Fase 2

- [x] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [ ] N · No lo quiero

### G13. Packs/biblioteca — Fase 3

- [x] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [ ] N · No lo quiero

### G14. Airdrops — Fase 2

- [x] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [ ] N · No lo quiero

### G15. Lluvia de contenido — Fase 3

- [x] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [ ] N · No lo quiero

### G16. Lore/afinidad/doxeo ficticio — Fase 4

- [ ] A · Desde el principio
- [ ] B · Después
- [x] C · Si sobra tiempo
- [ ] N · No lo quiero

### G17. Proactividad — Fase 4

- [ ] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [x] N · No lo quiero

### G18. Moderación — Fase 4

- [ ] A · Desde el principio
- [ ] B · Después
- [x] C · Si sobra tiempo
- [ ] N · No lo quiero

### G19. Mensajes a contactos/chats — Fase 4

- [x] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [ ] N · No lo quiero

### G20. Campañas de difusión — Fase 4

- [x] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [ ] N · No lo quiero

### G21. Operación nuclear — Fase 4

- [x] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [ ] N · No lo quiero

### G22. Minecraft Bedrock — Fase 5

- [x] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [ ] N · No lo quiero

### G23. Televisión — Fase 5

- [ ] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [x] N · No lo quiero

### G24. Terminal — Fase 5

- [ ] A · Desde el principio
- [ ] B · Después
- [ ] C · Si sobra tiempo
- [x] N · No lo quiero

### G25. Reacciones — Fase 3+

- [ ] A · Desde el principio
- [ ] B · Después
- [x] C · Si sobra tiempo
- [ ] N · No lo quiero

## H. Reglas, privacidad y seguridad

### H1. Si falla o no entiende

- [ ] Respuesta corta con humor
- [x] Explicar brevemente el error
- [ ] Decir que intente otra vez
- [ ] Otra

### H2. Si le piden algo que no puede/debe hacer

- [ ] Negarse y explicar
- [ ] Negarse y ofrecer alternativa
- [x] Solo decir que no
- [ ] Depende

### H3. Reglas de cosas que nunca debe hacer

- [x] Usar reglas de seguridad recomendadas
- [ ] Las definiré en detalle

**Respuesta / detalle:** no debe tener restricciones

### H4. Datos que nunca debe guardar

- [x] Contraseñas/tokens/datos sensibles
- [ ] No guardar datos personales salvo imprescindible
- [ ] Lo definiré

### H5. ¿Quién ve logs de errores?

- [x] Solo yo
- [ ] También operators

### H6. ¿Comando de apagado de emergencia?

- [x] Sí
- [ ] No

### H7. ¿Modo mantenimiento?

- [x] Sí
- [ ] No

### H8. Retención: originales 30 días / generados 7 días

- [ ] Sí
- [x] Menos tiempo
- [ ] Más tiempo
- [ ] Otra configuración

## I. Desarrollo y despliegue

### I1. Pruebas antes de grupos reales

- [x] Grupo de pruebas
- [ ] Directamente en reales
- [ ] Ambos según función

### I2. Usuario sin privilegios para Botsky

- [ ] Sí
- [x] No
- [ ] No sé / recomendado

### I3. Secretos

- [ ] Gestor de secretos
- [x] .env protegido
- [ ] No sé / recomendado

### I4. Código fuente

- [x] GitHub privado
- [ ] Otro repositorio
- [ ] Solo VPS por ahora

### I5. Despliegue

- [x] Agente por SSH
- [ ] Manual
- [ ] Script de despliegue
- [ ] No sé / recomendado

### I6. Documentación

- [x] Sí
- [ ] No
- [ ] Solo básica

### I7. Reglas de oro de agentes

- [ ] Seguridad + backups + pruebas
- [ ] Las definiré
- [x] Que arquitecto proponga

### I8. Agentes

- [x] Arquitecto/revisor + builder
- [ ] Uno hace todo
- [ ] No sé / recomendado

### I9. Permiso antes de costos

- [x] Sí, cualquier costo
- [ ] Sí, sobre cierto monto
- [ ] No

### I10. Instalar programas/cambiar VPS

- [x] Avisar y proceder
- [ ] Pedir aprobación
- [ ] Depende del riesgo

### I11. Avisos de errores

- [x] WhatsApp
- [ ] Email
- [ ] Solo cuando pregunte
- [ ] WhatsApp + email
- [ ] Otro

## J. Definición de éxito

### J1. 5 funciones más importantes

- [x] IA/conversación
- [x] Recordatorios
- [ ] XP/niveles
- [x] Juegos
- [ ] Multimedia
- [x] Escuela
- [x] Minecraft
- [ ] Moderación
- [ ] Lore/bromas
- [ ] Automatización/VPS
- [ ] Otra

### J2. Fecha objetivo

- [ ] Lo antes posible
- [x] En semanas
- [ ] En meses
- [ ] Sin fecha fija
- [ ] Otra

### J3. ¿Cuándo dirías “ya sirve”?

- [ ] IA + WhatsApp estable
- [ ] IA + funciones básicas + estabilidad
- [x] Mayoría de módulos
- [ ] Solo versión completa
- [ ] Otra

### J4. ¿Qué sería un fracaso?

- [x] Inestabilidad/desconexiones
- [ ] Costo alto
- [x] IA responde mal
- [ ] Difícil de mantener
- [ ] Que el grupo no lo use
- [ ] Otro

**Respuesta / detalle:** que no sirvan las herramientas

### J5. ¿Falta alguna función importante?

- [x] No
- [ ] Sí

### J6. ¿Hay alguna función que ya no quieras?

- [x] No
- [ ] Sí

### J7. ¿Usarlo por fases o esperar versión completa?

- [ ] Por fases
- [ ] Esperar versión completa
- [x] Me da igual / arquitecto decide

## K. Checklist técnico

### K1. Acceso SSH al VPS

- [x] Lo tengo
- [ ] Pendiente
- [ ] No aplica

### K2. Datos CPU/RAM/disco/SO

- [x] Lo tengo
- [ ] Pendiente
- [ ] No aplica

### K3. Estado Docker/servicios

- [x] Lo tengo
- [ ] Pendiente
- [ ] No aplica

### K4. Datos Evolution/WhatsApp sin secretos

- [x] Lo tengo
- [ ] Pendiente
- [ ] No aplica

### K5. Repositorio/código actual

- [ ] Lo tengo
- [ ] Pendiente
- [ ] No aplica

**Respuesta / detalle:** lo crearemos

### K6. Dominio/DNS/acceso

- [x] Lo tengo
- [ ] Pendiente
- [ ] No aplica

### K7. Backups

- [x] Lo tengo
- [ ] Pendiente
- [ ] No aplica

---

# Decisiones posteriores al cuestionario

Estas decisiones fueron confirmadas por el dueño después del cuestionario y complementan sus respuestas originales. Si alguna respuesta anterior parece contradecirlas, estas decisiones posteriores son las vigentes; el resumen normativo definitivo está en `docs/PLAN_MAESTRO.md` §0.

## Agentes y herramientas

- Codex CLI y Antigravity están disponibles tanto desde la computadora del dueño como desde los VPS/SSH.
- El dueño dispone de ChatGPT Plus, Google AI Pro y GitHub Student Pack.
- El arquitecto decide la distribución de trabajo. No hay una asignación permanente de fases por herramienta.

## Economía y juegos

- El nivel se calcula sobre el **saldo actual**: `1 + floor(saldoXP / 20)`.
- Perder/gastar XP puede bajar el nivel.
- Hora Feliz: activación manual por owner/admin.
- Ruleta: al tercer warn, expulsión temporal; tiempo configurable, 15 minutos por defecto.
- Tras el castigo de ruleta, el bot intenta enviar por privado un enlace válido para volver al grupo.

## Operación `nuclear`

- `nuclear` no expulsa miembros.
- Es una ráfaga owner-only de mensajes/menciones para llamar la atención del grupo.
- Se eligió una ráfaga corta predefinida en lugar de una cantidad arbitraria sin límite.
- Sigue requiriendo vista previa, confirmación y ritmo controlado.

## Multimedia

- YouTube queda excluido.
- Se desean descargas/búsquedas en fuentes que funcionen sin cookies personales.
- Se admiten URL directas y búsqueda por texto.
- Los resultados solicitados en el grupo pueden entregarse en el grupo; los packs comprados siguen siendo privados.

## Escuela

- Cualquier miembro del grupo escolar puede registrar tareas.
- Borrar/editar contenido sensible y cambiar materias/horarios corresponde al owner y administradores.
- El horario inicial se proporcionará como foto/captura; Gemini Vision debe extraerlo, mostrar vista previa y guardar solo tras confirmación.
- El resumen escolar debe tener horario configurable desde WhatsApp.

## Privados

- Miembros actuales de los grupos habilitados se autoaprueban para conversar/recibir entregas por privado.
- Personas ajenas a esos grupos siguen bloqueadas salvo autorización.

## Minecraft

- Miembros pueden consultar estado del servidor y jugadores conectados.
- Acciones que cambian el servidor quedan restringidas al owner.

## Biblioteca, packs y cooperacha

- Biblioteca híbrida entre VPS y Google Drive.
- Categorías de packs derivadas de carpetas.
- Packs comprados con XP se entregan por privado.
- Cooperacha exitosa publica la recompensa en el grupo para todos.
- Lluvia de contenido con horario configurable desde WhatsApp.

## IA y negativas

- Si Gemini bloquea una respuesta, el bot no entra en bucles para forzarla: responde corto y termina.
