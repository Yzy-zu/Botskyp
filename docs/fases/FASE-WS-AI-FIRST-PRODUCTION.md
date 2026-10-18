# WS-AI-FIRST-PRODUCTION

Implementación y auditoría: [informe](../v1.1/WS-AI-FIRST-PRODUCTION.md).
Baseline c25acac; sin merge. No proveedores/features nuevos.
Backup verificado antes de cambios productivos:
`botsky-20261018T162418-1538426.dump`.
Rollback privado preparado en `.local/ai-first-rollback/` con configuración e
imágenes anteriores fijadas. La migración 015 conserva los datos y es compatible
con el runtime anterior. No restaurar una base productiva para revertir código.

Cierre 17:00 UTC: aba5cfe desplegado por el script oficial; backup del despliegue
`botsky-20261018T165820-1584174.dump`, migración 015 y health app/worker/DB/Evolution
verificados. Global v1_1 en Lab y selector de privado elegible; segundo grupo real
inexistente. Tabla 96 públicas/96 callables/2 internas/0 backends registrados
faltantes/0 adapters faltantes. Sin merge, sin nuevos chats ni smoke masivo.

Automático: typecheck/lint/build/secrets PASS; integración 440/440; revalidación final
de exposición/contexto/sesiones 53/53; última tanda catálogo/Manifest/exposición y
Gemini real 43/43. Las tandas se solapan y no se suman como pruebas únicas.
Manual pendiente en el documento de pruebas. No se afirma entrega WhatsApp.
