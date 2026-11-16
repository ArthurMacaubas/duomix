import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Se a porta 5173 estiver ocupada, o Vite usa a próxima livre; o navegador abre sozinho.
  server: { port: 5173, open: true },
});
