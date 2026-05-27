const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Inline source files: vitest necesita transformar a ESM los módulos del
    // proyecto para que vi.mock() intercepte los require() de adentro.
    // Sin esto, los CJS modules se cargan por Node y los mocks no se aplican.
  },
});
