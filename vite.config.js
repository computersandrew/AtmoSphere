import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages under /<repo>/
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1000 },
});
