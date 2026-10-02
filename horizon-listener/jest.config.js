module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.ts'],
  // @stellar/stellar-sdk and @noble/* ship ESM. We must NOT ignore them in
  // transformIgnorePatterns, and we must route their .js files through
  // babel-jest (which uses the root babel.config.js) so Jest can execute them
  // in a CommonJS test environment. TypeScript source files (.ts) are still
  // handled by ts-jest via the preset.
  transformIgnorePatterns: ['node_modules/(?!(@stellar|@noble)/)'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {}],
    '^.+\\.js$': ['babel-jest', {}],
  },
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  // Point the shared logger package at its TypeScript source so ts-jest can
  // compile it directly without requiring a separate build step.
  moduleNameMapper: {
    '^@compliance-adapters/backoff$': '<rootDir>/../backoff/src/index.ts',
    '^@compliance-adapters/metrics$': '<rootDir>/../metrics/src/index.ts',
    '^@compliance-adapters/tracing$': '<rootDir>/../tracing/src/index.ts',
    '^@compliance-adapters/logger$': '<rootDir>/../logger/src/index.ts',
    '^@compliance-adapters/tracing-types$': '<rootDir>/../tracing-types/src/index.ts',
  },
  collectCoverageFrom: ['src/**/*.ts'],
  coverageReporters: ['text', 'lcov', 'json-summary'],
};
