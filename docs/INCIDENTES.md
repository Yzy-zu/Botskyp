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
