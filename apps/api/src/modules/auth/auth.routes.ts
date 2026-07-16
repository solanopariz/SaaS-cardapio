import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { loginSchema } from '@cardapio/shared';
import { prisma } from '../../lib/prisma.js';
import { naoAutorizado } from '../../lib/errors.js';
import { assinarTokenStaff } from '../../plugins/auth.js';

/** Hash descartavel, usado so para gastar o mesmo tempo quando o email nao existe. */
const HASH_FALSO = '$2a$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/login', async (req) => {
    const { email, senha } = loginSchema.parse(req.body);

    const usuario = await prisma.usuario.findUnique({ where: { email } });

    /**
     * Compara o hash mesmo quando o usuario nao existe. Sem isto, um email
     * inexistente responde em 2ms e um existente em 80ms — o que deixa alguem
     * enumerar quais emails sao funcionarios.
     */
    const confere = await bcrypt.compare(senha, usuario?.senhaHash ?? HASH_FALSO);

    if (!usuario || !usuario.ativo || !confere) throw naoAutorizado();

    return {
      token: assinarTokenStaff({ usuarioId: usuario.id, role: usuario.role }),
      usuario: { id: usuario.id, nome: usuario.nome, role: usuario.role },
    };
  });
}
