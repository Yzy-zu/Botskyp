# Botsky E2E Black-Box Webhook QA Harness

Harness automatizado de pruebas E2E black-box para Botsky. Diseñado para auditar la comprensión NLU con Gemini real, exposición FULL del catálogo de 99 tools públicas, evaluación de Policy V2, gestión de sesiones y entrega de outbox a través de la ruta HTTP real de producción:

```
POST /webhook
  ↳ normalize (Evolution v2.3.7)
  ↳ inbox
  ↳ ContextV2
  ↳ Gemini Real (NLU)
  ↳ FULL Catalog (99 tools públicas)
  ↳ Policy V2
  ↳ Sessions V2
  ↳ Handlers & Jobs
  ↳ Worker
  ↳ Outbox
```

---

## 1. Comandos de Ejecución

```bash
# Ejecutar un caso específico
npm run qa:e2e -- --case SMOKE-001

# Ejecutar una suite específica (por defecto 'smoke')
npm run qa:e2e -- --suite smoke

# Ejecutar en modo SAFE o LIVE_SAFE
npm run qa:e2e -- --mode SAFE
npm run qa:e2e -- --mode LIVE_SAFE

# Reanudar ejecución omitiendo casos previamente pasados (checkpoint/resume)
npm run qa:e2e -- --suite smoke --resume

# Simular sin enviar HTTP (dry-run de payloads)
npm run qa:e2e -- --suite smoke --dry-run
```

---

## 2. Configuración de Identidad QA

Por estricta política de seguridad, el runner **nunca** enviará mensajes ni afectará chats de producción no autorizados.

| Variable | Descripción | Valor Predeterminado |
|---|---|---|
| `QA_CHAT_ID` | JID del grupo autorizado de prueba (Botsky Lab) | `120363431233265050@g.us` (`LAB_CHAT_ID`) |
| `QA_ACTOR_ID` | JID del remitente autorizado para pruebas | `5214435810175@s.whatsapp.net` (`OWNER_JIDS[0]`) |
| `WEBHOOK_TARGET` | URL del endpoint de webhook de Botsky | `http://127.0.0.1:3000/webhook` |
| `WEBHOOK_SECRET` | Secreto del webhook (`x-webhook-secret`) | Leído automáticamente de `.env` |

---

## 3. Modos Operativos

### Modo `SAFE` (Por Defecto)
- Gemini real evalúa lenguaje natural.
- Catálogo completo de 99 tools visible.
- Contexto, Policy y Sessions reales activos.
- **Acciones Destructivas:** Se verifica que Gemini seleccione la tool y que Policy V2 genere `needs_confirmation` o `denied`. **No** se emite la confirmación física destructiva (sin kick real, sin Nuclear real, sin borrados masivos).

### Modo `LIVE_SAFE`
- Permite la ejecución de efectos reales inocuos:
  - `web.search` (búsqueda web con SearxNG);
  - `video.search` (búsqueda externa en Dailymotion/Adulto);
  - `video.download` (descargas cortas permitidas de prueba);
  - `media.process` (creación de QR, sticker, transcripción, speak TTS);
  - Consultas Minecraft (`minecraft.status`, `minecraft.players`).

---

## 4. Fixtures Multimedia y ArtifactState

Los fixtures controlados residen en `qa/e2e/fixtures/`:
- `sample.jpg`: Imagen JPEG mínima válida (`image/jpeg`).
- `sample.png`: Imagen PNG mínima válida (`image/png`).
- `sample.pdf`: Documento PDF mínimo válido (`application/pdf`).
- `sample.ogg`: Audio Ogg Opus mínimo válido (`audio/ogg`).
- `multi/img1.jpg`, `multi/img2.jpg`: Dos imágenes para pruebas de múltiples adjuntos y colecciones PDF.

El harness precarga los bytes en `media_attachments` cache antes del envío del webhook (`is_original = true`). Esto permite a Botsky registrar el artefacto en `chat_artifacts` y ejercitar el pipeline real de procesamiento multimedia y SafeRefs sin necesidad de mockear rutas internas.

---

## 5. Correlación de Resultados y Salidas

Después del `POST /webhook`, el `result-collector.ts` consulta PostgreSQL para correlacionar:
- `inbox`: estado de recepción y resolución de `turn_id`.
- `tool_executions`: herramientas invocadas, `risk_level`, `status` y `result_json`.
- `sessions_v2`: estado de sesiones activas (`confirm`, `clarify`, `media_collect`).
- `jobs`: tareas asíncronas encoladas para el worker.
- `outbox`: respuesta final entregada al usuario.
- `llm_usage`: tokens consumidos por Gemini.

### Archivos de Reporte Generados
- `qa/e2e/reports/qa-results.jsonl`: Registro estructurado JSONL por caso (permite checkpoint y reanudación).
- `qa/e2e/reports/qa-report.md`: Resumen legible en Markdown con tabla de resultados, herramientas ejecutadas y latencia.

### Clasificación de Errores
- **`PASS`**: Comportamiento esperado verificado.
- **`FAIL`**: Error interno de Botsky o discrepancia en aserciones de caso.
- **`RATE_LIMIT`**: Error 429 o mensaje de límite de cuota IA alcanzado.
- **`INFRA_PROVIDER_FAILURE`**: Error 503/504, timeout o falla de conectividad externa del modelo/proveedor.
