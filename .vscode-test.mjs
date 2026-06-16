import { defineConfig } from '@vscode/test-cli';

// Tests are compiled with `tsc -p tsconfig.test.json` into out/ before running.
export default defineConfig({
  files: 'out/test/**/*.test.js',
  mocha: {
    ui: 'bdd',
    timeout: 20000
  }
});
