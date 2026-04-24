import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' so the production build emits relative asset URLs.
// Required for Electron, which loads index.html via file:// — absolute
// `/assets/...` URLs would resolve to the filesystem root.
export default defineConfig({
  plugins: [react()],
  base: './',
});
