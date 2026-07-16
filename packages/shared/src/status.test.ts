import { describe, it, expect } from 'vitest';
import {
  STATUS_PEDIDO,
  podeTransicionar,
  proximoStatus,
  ehTerminal,
  transicoesValidas,
  type StatusPedido,
} from './status.js';

describe('podeTransicionar', () => {
  it('permite o caminho feliz', () => {
    expect(podeTransicionar('RECEBIDO', 'EM_PREPARO')).toBe(true);
    expect(podeTransicionar('EM_PREPARO', 'PRONTO')).toBe(true);
    expect(podeTransicionar('PRONTO', 'ENTREGUE')).toBe(true);
  });

  it('rejeita voltar no tempo', () => {
    expect(podeTransicionar('ENTREGUE', 'EM_PREPARO')).toBe(false);
    expect(podeTransicionar('PRONTO', 'RECEBIDO')).toBe(false);
    expect(podeTransicionar('EM_PREPARO', 'RECEBIDO')).toBe(false);
  });

  it('rejeita pular etapa', () => {
    expect(podeTransicionar('RECEBIDO', 'PRONTO')).toBe(false);
    expect(podeTransicionar('RECEBIDO', 'ENTREGUE')).toBe(false);
    expect(podeTransicionar('EM_PREPARO', 'ENTREGUE')).toBe(false);
  });

  it('permite cancelar de qualquer estado exceto ENTREGUE', () => {
    expect(podeTransicionar('RECEBIDO', 'CANCELADO')).toBe(true);
    expect(podeTransicionar('EM_PREPARO', 'CANCELADO')).toBe(true);
    expect(podeTransicionar('PRONTO', 'CANCELADO')).toBe(true);
    // Comida entregue nao volta para a cozinha. Estorno e no caixa.
    expect(podeTransicionar('ENTREGUE', 'CANCELADO')).toBe(false);
  });

  it('CANCELADO nao transiciona para nada', () => {
    for (const alvo of STATUS_PEDIDO) {
      expect(podeTransicionar('CANCELADO', alvo)).toBe(false);
    }
  });

  it('nenhum status transiciona para si mesmo', () => {
    for (const s of STATUS_PEDIDO) {
      expect(podeTransicionar(s, s)).toBe(false);
    }
  });
});

describe('proximoStatus', () => {
  it('devolve o proximo do caminho feliz, ignorando CANCELADO', () => {
    expect(proximoStatus('RECEBIDO')).toBe('EM_PREPARO');
    expect(proximoStatus('EM_PREPARO')).toBe('PRONTO');
    expect(proximoStatus('PRONTO')).toBe('ENTREGUE');
  });

  it('devolve null em estado terminal', () => {
    expect(proximoStatus('ENTREGUE')).toBeNull();
    expect(proximoStatus('CANCELADO')).toBeNull();
  });

  it('o resultado e sempre uma transicao valida', () => {
    for (const s of STATUS_PEDIDO) {
      const prox = proximoStatus(s);
      if (prox !== null) expect(podeTransicionar(s, prox)).toBe(true);
    }
  });
});

describe('ehTerminal', () => {
  it('so ENTREGUE e CANCELADO sao terminais', () => {
    const terminais = STATUS_PEDIDO.filter(ehTerminal);
    expect([...terminais].sort()).toEqual(['CANCELADO', 'ENTREGUE']);
  });

  it('estado terminal nao tem transicao de saida', () => {
    for (const s of STATUS_PEDIDO) {
      if (ehTerminal(s)) expect(transicoesValidas(s)).toHaveLength(0);
    }
  });
});

describe('grafo de transicoes', () => {
  it('todo estado nao terminal alcanca ENTREGUE ou CANCELADO', () => {
    const alcanca = (inicio: StatusPedido): boolean => {
      const visto = new Set<StatusPedido>();
      const fila: StatusPedido[] = [inicio];
      while (fila.length) {
        const atual = fila.shift()!;
        if (ehTerminal(atual)) return true;
        if (visto.has(atual)) continue;
        visto.add(atual);
        fila.push(...transicoesValidas(atual));
      }
      return false;
    };
    for (const s of STATUS_PEDIDO) expect(alcanca(s)).toBe(true);
  });
});
