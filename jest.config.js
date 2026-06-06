module.exports = {
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  moduleNameMapper: {
    '^obsidian$': 'obsidian-test-mocks/obsidian',
    '^@huggingface/transformers$': '<rootDir>/tests/transformers-mock.js',
  },
  setupFiles: ['obsidian-test-mocks/jest-setup'],
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.js'],
  coverageDirectory: '.nyc_output',
  coverageReporters: ['json', 'text'],
};
