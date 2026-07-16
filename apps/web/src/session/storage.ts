/**
 * Persistencia da sessao do cliente. E isto que faz a mesa sobreviver ao F5.
 *
 * Chave versionada: se o shape mudar, incrementa `_v2` e a sessao antiga e
 * simplesmente ignorada (nao explode em JSON.parse de um formato velho).
 */

const CHAVE_SESSAO = 'comanda_session_v1';
const CHAVE_DEVICE = 'device_id_v1';

export interface SessaoComanda {
  token: string;
  comandaId: number;
  participanteId: number;
  apelido: string;
  mesaNumero: number;
}

export function lerSessao(): SessaoComanda | null {
  try {
    const bruto = localStorage.getItem(CHAVE_SESSAO);
    if (!bruto) return null;

    const s = JSON.parse(bruto) as Partial<SessaoComanda>;
    // Valida o shape. Um storage corrompido nao pode derrubar o app inteiro.
    if (
      typeof s.token !== 'string' ||
      typeof s.comandaId !== 'number' ||
      typeof s.participanteId !== 'number' ||
      typeof s.mesaNumero !== 'number' ||
      typeof s.apelido !== 'string'
    ) {
      localStorage.removeItem(CHAVE_SESSAO);
      return null;
    }
    return s as SessaoComanda;
  } catch {
    localStorage.removeItem(CHAVE_SESSAO);
    return null;
  }
}

export function salvarSessao(s: SessaoComanda): void {
  localStorage.setItem(CHAVE_SESSAO, JSON.stringify(s));
}

/** Chamado quando o caixa fecha a mesa (evento de socket ou 410 no fetch). */
export function limparSessao(): void {
  localStorage.removeItem(CHAVE_SESSAO);
}

/**
 * Id estavel do aparelho. Sobrevive ao fechamento da comanda de proposito:
 * e o que permite o mesmo celular reentrar sem virar um participante duplicado
 * ("Ana", "Ana", "Ana") a cada refresh.
 */
export function obterDeviceId(): string {
  let id = localStorage.getItem(CHAVE_DEVICE);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(CHAVE_DEVICE, id);
  }
  return id;
}
