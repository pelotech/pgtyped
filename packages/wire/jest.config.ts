import type { Config } from 'jest';

const config: Config = {
  snapshotFormat: {
    escapeString: true,
    printBasicPrototype: true,
  },
  roots: ['src'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  // Inlined from ts-jest's default-esm preset, which only sets this and a
  // transform we already declare above. Naming it directly avoids depending
  // on ts-jest's preset path resolving from each package's rootDir.
  extensionsToTreatAsEsm: ['.ts', '.tsx', '.mts'],
  testRegex: '\\.test\\.tsx?$',
};

export default config;
