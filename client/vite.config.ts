import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Demo recordings are written under client/demo while Vite runs; never watch them.
    watch: { ignored: ['**/demo/**', '**/test-results/**'] },
    proxy: {
      '/api': 'http://localhost:5174',
    },
  },
  // Force re-prebundling of deps on every dev start. Without this, Vite
  // caches the pre-bundled `@cht-ui/shared` package — so a fresh `git pull`
  // that brings new shared/* exports leaves the running UI with a stale
  // bundle (silent emit-of-undefined, "the dropdown picks but the preview
  // doesn't change"-style symptoms). ~1–2s extra dev startup is a fair
  // trade for "git pull → restart dev → it just works."
  optimizeDeps: {
    force: true,
  },
});
