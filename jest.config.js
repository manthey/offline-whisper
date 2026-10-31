module.exports = {
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/tests/obsidian-mock.js',
    '^@huggingface/transformers$': '<rootDir>/tests/transformers-mock.js',
    // The generated embedded worker source only exists after a build; tests
    // run against an empty stub, which makes the host run the worker module
    // in-process through the same message protocol.
    'generated-worker-source\\.js$': '<rootDir>/tests/empty-worker-source.js',
  },
  setupFiles: ['obsidian-test-mocks/jest-setup'],
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.js'],
  coverageDirectory: '.nyc_output',
  coverageReporters: ['json', 'text'],
};
