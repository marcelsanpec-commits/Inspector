import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind to all interfaces so you can open the inspector view on a real
    // phone over your local network - the camera and dictation are the two
    // things a desktop browser cannot honestly test.
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
