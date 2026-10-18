# Auditoría focalizada Zero-NLU v1.1 — 18-10-2026

Inspección de RegExp/test/exec/match, includes/startsWith y Sets en la ruta natural,
contexto, sesiones, artifacts, Policy, contratos y memoria. El informe principal
registra los gates SEMANTIC-NLU retirados. Este inventario clasifica los usos
restantes por ubicación; ninguno interpreta la intención de CURRENT_USER_TURN.

| Ubicación | Clasificación | Motivo |
|---|---|---|
| `src/core/router-v2.ts:64` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/router-v2.ts:68` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/router-v2.ts:74` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/context-v2.ts:33` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/context-v2.ts:61` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/context-v2.ts:78` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/context-v2.ts:81` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/context-v2.ts:84` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/context-v2.ts:88` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/context-v2.ts:90` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/context-v2.ts:97` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/context-v2.ts:109` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/context-v2.ts:122` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/context-v2.ts:137` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/context-v2.ts:151` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/tool-exposure.ts:45` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/tool-exposure.ts:50` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/tool-exposure.ts:108` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/tool-exposure.ts:124` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/tool-exposure.ts:128` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/tool-exposure.ts:134` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/tool-exposure.ts:142` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/tool-exposure.ts:162` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/tool-exposure.ts:187` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/tool-exposure.ts:189` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/capability-truth-v2.ts:22` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/capability-manifest-v2.ts:22` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/capability-manifest-v2.ts:50` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/capability-manifest-v2.ts:51` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/reminder-slots-v2.ts:28` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/reminder-slots-v2.ts:38` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/tool-loop-v2.ts:36` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/tool-loop-v2.ts:45` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/tool-loop-v2.ts:46` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/tool-loop-v2.ts:128` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/tool-loop-v2.ts:137` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/tool-loop-v2.ts:147` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/tool-loop-v2.ts:150` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/tool-loop-v2.ts:169` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/tool-loop-v2.ts:181` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/prepare-artifacts-v2.ts:16` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/prepare-artifacts-v2.ts:27` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/artifact-resolution-v2.ts:10` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/artifact-resolution-v2.ts:11` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/artifact-resolution-v2.ts:16` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/artifact-registration-v2.ts:28` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/media-collection-v2.ts:38` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/media-collection-v2.ts:49` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/media-collection-v2.ts:59` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/media-collection-v2.ts:68` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/composer-v2.ts:12` | POLICY/SAFETY | Sanitización, aislamiento o claims de salida; no selecciona intención desde input humano. |
| `src/core/composer-v2.ts:25` | POLICY/SAFETY | Sanitización, aislamiento o claims de salida; no selecciona intención desde input humano. |
| `src/core/composer-v2.ts:27` | POLICY/SAFETY | Sanitización, aislamiento o claims de salida; no selecciona intención desde input humano. |
| `src/core/composer-v2.ts:28` | POLICY/SAFETY | Sanitización, aislamiento o claims de salida; no selecciona intención desde input humano. |
| `src/core/composer-v2.ts:33` | POLICY/SAFETY | Sanitización, aislamiento o claims de salida; no selecciona intención desde input humano. |
| `src/core/composer-v2.ts:38` | POLICY/SAFETY | Sanitización, aislamiento o claims de salida; no selecciona intención desde input humano. |
| `src/core/composer-v2.ts:39` | POLICY/SAFETY | Sanitización, aislamiento o claims de salida; no selecciona intención desde input humano. |
| `src/core/composer-v2.ts:40` | POLICY/SAFETY | Sanitización, aislamiento o claims de salida; no selecciona intención desde input humano. |
| `src/core/composer-v2.ts:48` | POLICY/SAFETY | Sanitización, aislamiento o claims de salida; no selecciona intención desde input humano. |
| `src/core/composer-v2.ts:54` | POLICY/SAFETY | Sanitización, aislamiento o claims de salida; no selecciona intención desde input humano. |
| `src/core/composer-v2.ts:61` | POLICY/SAFETY | Sanitización, aislamiento o claims de salida; no selecciona intención desde input humano. |
| `src/core/composer-v2.ts:76` | POLICY/SAFETY | Sanitización, aislamiento o claims de salida; no selecciona intención desde input humano. |
| `src/core/composer-v2.ts:83` | POLICY/SAFETY | Sanitización, aislamiento o claims de salida; no selecciona intención desde input humano. |
| `src/core/composer-v2.ts:106` | POLICY/SAFETY | Sanitización, aislamiento o claims de salida; no selecciona intención desde input humano. |
| `src/core/composer-v2.ts:109` | POLICY/SAFETY | Sanitización, aislamiento o claims de salida; no selecciona intención desde input humano. |
| `src/core/composer-v2.ts:112` | POLICY/SAFETY | Sanitización, aislamiento o claims de salida; no selecciona intención desde input humano. |
| `src/core/output-sanitizer-v2.ts:20` | POLICY/SAFETY | Sanitización, aislamiento o claims de salida; no selecciona intención desde input humano. |
| `src/core/safe-refs.ts:20` | POLICY/SAFETY | Sanitización, aislamiento o claims de salida; no selecciona intención desde input humano. |
| `src/core/safe-refs.ts:57` | POLICY/SAFETY | Sanitización, aislamiento o claims de salida; no selecciona intención desde input humano. |
| `src/core/model-args.ts:15` | TECHNICAL | Enums, formatos, referencias, MIME o estado estructurado; no interpreta CURRENT_USER_TURN. |
| `src/core/policy-v2/arguments.ts:48` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/eligibility.ts:11` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/eligibility.ts:21` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/eligibility.ts:31` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/eligibility.ts:41` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/eligibility.ts:73` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/eligibility.ts:76` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/eligibility.ts:86` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/evaluate.ts:58` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/evaluate.ts:59` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/evaluate.ts:60` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/evaluate.ts:61` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/evaluate.ts:62` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/evaluate.ts:63` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/evaluate.ts:66` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/evaluate.ts:96` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/executor.ts:114` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/executor.ts:129` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/executor.ts:133` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/executor.ts:144` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/executor.ts:173` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/normalize.ts:14` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/normalize.ts:41` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/normalize.ts:50` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/normalize.ts:71` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/normalize.ts:76` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/normalize.ts:87` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/normalize.ts:88` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/normalize.ts:95` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/references.ts:26` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/references.ts:52` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/references.ts:54` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/references.ts:55` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/source-admission.ts:6` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/core/policy-v2/source-admission.ts:9` | POLICY/SAFETY | Permisos, scope, restricciones de ejecución y validaciones estructuradas; no interpreta slang. |
| `src/modules/memory/index.ts:6` | POLICY/SAFETY | Explicitud semántica solo en v1; privacidad y validación técnica conservadas en v1.1. |
| `src/modules/memory/index.ts:9` | POLICY/SAFETY | Explicitud semántica solo en v1; privacidad y validación técnica conservadas en v1.1. |

Total: **107 ubicaciones**; SEMANTIC-NLU en estas superficies v1.1: **0**.
