# Botsky 2: paridad y mejora

Botsky 2 es el sucesor de Legacy: conservar capacidades útiles y mejorar su UX
sobre Context → Exposure → Gemini → Policy → Handler → ToolResult → Presenter.
Legacy sirve como referencia de comportamiento; no se copia su dispatcher ni código.
El Registry describe capacidades reales; Gemini interpreta solicitudes y no inventa
accesos faltantes. Las restricciones de proveedor no se evaden.

| Prioridad | Capacidad | Estado al implementar WS-PARITY-1 |
| --- | --- | --- |
| P0 | Minecraft natural | Aliases/slang/typos acotados; consultas y acciones existentes conservan permisos |
| P0 | Capability Truth | Contexto conceptual y un retry máximo para consultas disponibles; métrica sanitizada |
| P0 | Recordatorios/sesiones | Reloj explícito, fusión de fecha/hora, cancelación pendiente o recién creado, escape de intención |
| P0 | Contexto de imágenes | A_LAST operativo conservado; semántica/visión antigua condicionada a referencia relevante |
| P0 | Búsqueda web explícita | Tool real antes del humor; recuperación acotada si responde sin buscar |
| P1 | XP/daily | Descripciones y señales coloquiales; economía intacta |
| P1 | Notas | Ruta existente; fixture de la petición real |
| P1 | Confirmaciones | Invocación «si botsky» reconocida; reevaluación y límites conservados |
| P1 | Estado multimedia | Seguimiento del job propio relevante; historial solo cuando se pide |
| P1 | Fotos → PDF / unir PDF | Colección SessionV2 conectada a artifacts y media.process/jobs existentes |
| P1 | DOCX → PDF | Processor existente; timeout LibreOffice pendiente para WS-MULTIMEDIA |
| P1 | Búsqueda/selección multimedia | media.search sigue cerrado: falta bridge seguro a selección SessionV2 y entrega |
| P2 | Adjuntos múltiples por evento | Falta identidad individual de backing/artifact por adjunto; hoy un adjunto por mensaje |
| P2 | Descargas y fuentes nuevas | Evaluar en WS-MULTIMEDIA; no yt-dlp en este workstream |
| P2 | Búsqueda adulta | Fuera de este trabajo; requiere diseño de fuentes/entrega antes de habilitar |
| P2 | Voces/personajes, affinity/lore, cooperacha visual | Fuera de este trabajo; no se implementan |

WS-PARITY-1 cierra conexiones y UX de capacidades existentes. No equivale a
paridad completa de Legacy ni una R6. Evidencias, checks y límites de Canary en
[WS-PARITY-1](../v1.1/WS-PARITY-1.md). Lab continúa v1.1 y otros chats v1; sin merge.

## Siguiente: WS-MULTIMEDIA

1. Diagnosticar el timeout real de LibreOffice y verificar DOCX→PDF con entrega.
2. Abrir media.search con selección scoped/expirable, procedencia/licencia y jobs existentes.
3. Mejorar seguimiento de entrega/reenvío seguro sin repetir trabajos inciertos.
4. Definir backing/artifact individual para múltiples adjuntos en un evento y comparación explícita.
5. Evaluar fuentes de descarga/búsqueda autorizadas; no prometer proveedores indisponibles.
6. Validar colecciones con archivos reales y retención/recuperación del worker.

Drive upload y previews escolares siguen cerrados por contratos propios; no se
resuelven incidentalmente como parte de multimedia.
