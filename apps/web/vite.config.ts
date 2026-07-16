import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Alvo da API e porta sao configuraveis para o E2E subir a stack inteira em
 * portas proprias, sem colidir com o `npm run dev` que voce ja tem aberto — e,
 * mais importante, sem que o teste acabe conversando com o banco de dev.
 *
 * NAO sao `VITE_*` de proposito: esse prefixo expoe a variavel ao BUNDLE, e
 * isto e config do dev-server, que roda em Node. Um dia alguem leria
 * `import.meta.env.VITE_API_ALVO` no navegador achando que existe.
 */
const ALVO_API = process.env.API_ALVO ?? 'http://localhost:3333';
const PORTA = Number(process.env.WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    port: PORTA,
    // Falhar alto: se a porta estiver ocupada, o Vite pularia para a proxima e
    // o E2E testaria silenciosamente o servidor de dev — com o banco de dev.
    strictPort: true,
    proxy: {
      '/api': ALVO_API,
      '/socket.io': { target: ALVO_API, ws: true },
    },
  },
});
