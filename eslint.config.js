import js from '@eslint/js';
import ts from 'typescript-eslint';
const nodeGlobals = {process:'readonly',Buffer:'readonly',fetch:'readonly',AbortSignal:'readonly'};
export default ts.config(
  { ignores: ['dist/**', 'node_modules/**', '.local/**'] },
  js.configs.recommended, ...ts.configs.recommended,
  {files:['scripts/*.mjs'],languageOptions:{globals:nodeGlobals}},
  { files: ['**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'error', '@typescript-eslint/no-empty-object-type': 'error' } },
);
