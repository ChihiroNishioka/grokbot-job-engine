import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', '.runs/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['src/dashboard/public/**/*.js'], languageOptions: { globals: { document: 'readonly', location: 'readonly', fetch: 'readonly', Headers: 'readonly', crypto: 'readonly' } } },
  { files: ['**/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly' } } },
);
