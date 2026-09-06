import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // Generated output, never hand-edited. The ANTLR parsers and the codegen
    // fixtures were excluded under tslint too.
    ignores: [
      '**/lib/**',
      '**/node_modules/**',
      '**/*Lexer.ts',
      '**/*Parser.ts',
      '**/*ParserListener.ts',
      '**/*ParserVisitor.ts',
      '**/*.queries.ts',
      '**/*.types.ts',
      'packages/example/src/sql/index.ts',
      'docs-new/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Formatting is prettier's job, run separately by the lint script.
  prettier,
  {
    rules: {
      // This codebase threads untyped query results through on purpose; the
      // generated types are what give callers safety.
      '@typescript-eslint/no-explicit-any': 'off',
      // Matches tslint's no-unused-variable, but ignores the leading-underscore
      // convention for deliberately unused bindings.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
