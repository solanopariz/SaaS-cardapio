import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import {
  ROOM_CAIXA,
  ROOM_COZINHA,
  roomComanda,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@cardapio/shared';
import { env } from '../lib/env.js';
import {
  verificarTokenComanda,
  verificarTokenStaff,
  type TokenComanda,
  type TokenStaff,
} from '../plugins/auth.js';

interface SocketData {
  staff?: TokenStaff;
  comanda?: TokenComanda;
}

/** Nunca ha eventos entre servidores: o 3o generico e vazio de proposito. */
export type TypedServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

let io: TypedServer | null = null;

export function criarIo(httpServer: HttpServer): TypedServer {
  io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
    httpServer,
    { cors: { origin: env.CORS_ORIGIN, credentials: true } },
  );

  /**
   * Autenticacao no HANDSHAKE, nao depois. E o servidor que decide as rooms.
   *
   * Jamais faca `socket.on('join', room => socket.join(room))`: isso deixa
   * qualquer pessoa escutar a comanda de qualquer mesa — inclusive os itens e
   * o total da conta dos outros.
   */
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('sem token'));

    try {
      // Tenta staff primeiro; se falhar, tenta comanda. Segredos distintos,
      // entao um token de comanda nunca valida como staff.
      try {
        const staff = verificarTokenStaff(token);
        if (staff.role === 'COZINHA' || staff.role === 'ADMIN') socket.join(ROOM_COZINHA);
        if (staff.role === 'CAIXA' || staff.role === 'ADMIN') socket.join(ROOM_CAIXA);
        socket.data.staff = staff;
        return next();
      } catch {
        const comanda = verificarTokenComanda(token);
        socket.join(roomComanda(comanda.comandaId));
        socket.data.comanda = comanda;
        return next();
      }
    } catch {
      return next(new Error('token invalido'));
    }
  });

  /**
   * Nenhum `socket.on(...)` de mutacao. De proposito.
   * O cliente muda estado por HTTP. O socket so recebe.
   *
   * `test/realtime/rooms.test.ts` guarda isto. Foi verificado reintroduzindo
   * `socket.on('join', room => socket.join(room))` aqui: o teste fica vermelho
   * com o payload da comanda alheia — total incluso — chegando no celular
   * errado. O teste tem dentes; nao e decorativo.
   */

  return io;
}

export function getIo(): TypedServer {
  if (!io) throw new Error('Socket.IO nao inicializado — chame criarIo() antes');
  return io;
}
