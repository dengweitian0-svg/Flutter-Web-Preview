import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist/**', '.cache/**', 'artifacts/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } },
);
