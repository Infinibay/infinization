/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", {}],
  },
  moduleNameMapper: {
    '^@core/(.*)$': '<rootDir>/src/core/$1',
    '^@db/(.*)$': '<rootDir>/src/db/$1',
    '^@display/(.*)$': '<rootDir>/src/display/$1',
    '^@network/(.*)$': '<rootDir>/src/network/$1',
    '^@storage/(.*)$': '<rootDir>/src/storage/$1',
    '^@sync/(.*)$': '<rootDir>/src/sync/$1',
    '^@types/(.*)$': '<rootDir>/src/types/$1',
    '^@unattended/(.*)$': '<rootDir>/src/unattended/$1',
    '^@utils/(.*)$': '<rootDir>/src/utils/$1',
  },
  rootDir: '',
  testMatch: [
    '**/tests/**/*.test.ts',
    '**/tests/**/*.spec.ts'
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  testTimeout: 10000,
  clearMocks: true,
  restoreMocks: true,
  verbose: true
};
