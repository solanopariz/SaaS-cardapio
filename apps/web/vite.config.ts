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

/**
 * `WEB_HOST=0.0.0.0` publica o dev-server na rede local.
 *
 * Existe para uma coisa so: por um celular DE VERDADE no fluxo. O QR aponta para
 * `APP_PUBLIC_URL` (ver scripts/gerar-qr.ts), e um celular nao alcanca o
 * `localhost` do seu notebook. O proxy daqui e quem fala com a API, entao basta
 * esta porta ser alcancavel.
 *
 * Default `localhost` DE PROPOSITO: 0.0.0.0 no wi-fi de um cafe publica a tela
 * do caixa e a do admin para a rede inteira. Opt-in por comando, nao um default
 * que alguem herda sem saber:
 *
 *   WEB_HOST=0.0.0.0 npm run dev
 *
 * NAO confunda com a API: `server.ts` ja escuta em 0.0.0.0:3333 por conta
 * propria — verificado, ela responde no IP da rede sem passar por aqui. Este
 * flag muda o Vite e so.
 */
const HOST = process.env.WEB_HOST ?? 'localhost';

export default defineConfig({
  plugins: [react()],
  server: {
    host: HOST,
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
