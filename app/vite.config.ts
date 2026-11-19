//dev server: /nexus goes to the private chain node in the same machine (nexus-dev). Mode "module" builds the desktop
//wallet module (module/build.mjs): relative paths and one classic script, since a module folder opens from file://
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'module' ? './' : '/',
  build:
    mode === 'module'
      ? {
          outDir: process.env.CONTRACTS_MODULE_OUT ?? '../module/dist',
          emptyOutDir: true,
          modulePreload: false,
          rollupOptions: { output: { format: 'iife', inlineDynamicImports: true } },
        }
      : {},
  server: {
    host: process.env.CONTRACTS_HOST ?? '127.0.0.1',
    port: Number(process.env.CONTRACTS_PORT ?? 5190),
    strictPort: true,
    fs: { allow: ['..', '../../wallet', '../../dex'] },
    proxy: {
      '/nexus': { target: `http://127.0.0.1:${process.env.NEXUS_PORT ?? 7080}`, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/nexus/, '') },
    },
  },
}));
