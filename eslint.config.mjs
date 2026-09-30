import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    // `langium generate` rewrites the generated trees on every build, so a finding there can only
    // be fixed by changing the generator. `packages/langium-lox` is the TypeFox submodule, vendored
    // to demonstrate that Lanzer drives a third-party language with zero edits — house rules that
    // asked for edits to it would contradict the thing it is here to prove. Linting either reports
    // work nobody in this repo is able to do.
    ignores: [
      '**/generated/**',
      '**/out/**',
      '**/lib/**',
      '**/dist/**',
      '**/node_modules/**',
      'packages/langium-lox/**'
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/consistent-type-assertions': ['error', {
        assertionStyle: 'never'
      }]
    }
  }
];
