import { describe, it, expect } from 'vitest';
import {
  calcularTotalItens,
  calcularTotalComanda,
  calcularTotalPorParticipante,
  formatarBRL,
  type ItemCobravel,
} from './total.js';

const item = (over: Partial<ItemCobravel> = {}): ItemCobravel => ({
  qtd: 1,
  precoUnitarioCentavos: 1000,
  canceladoEm: null,
  ...over,
});

describe('calcularTotalItens', () => {
  it('soma qtd * preco unitario', () => {
    expect(calcularTotalItens([item({ qtd: 3, precoUnitarioCentavos: 550 })])).toBe(1650);
  });

  it('ignora itens com canceladoEm preenchido', () => {
    const itens = [
      item({ precoUnitarioCentavos: 1000 }),
      item({ precoUnitarioCentavos: 9999, canceladoEm: new Date() }),
    ];
    expect(calcularTotalItens(itens)).toBe(1000);
  });

  it('retorna 0 para lista vazia', () => {
    expect(calcularTotalItens([])).toBe(0);
  });

  it('nunca produz float', () => {
    // 3 x R$ 0,10 — o classico 0.1+0.1+0.1 !== 0.3
    const total = calcularTotalItens([item({ qtd: 3, precoUnitarioCentavos: 10 })]);
    expect(Number.isInteger(total)).toBe(true);
    expect(total).toBe(30);
  });
});

describe('calcularTotalComanda', () => {
  it('ignora pedidos cancelados por inteiro', () => {
    const pedidos = [
      { status: 'PRONTO' as const, itens: [item({ precoUnitarioCentavos: 2000 })] },
      { status: 'CANCELADO' as const, itens: [item({ precoUnitarioCentavos: 9999 })] },
    ];
    expect(calcularTotalComanda(pedidos)).toBe(2000);
  });

  it('ignora item estornado dentro de pedido ativo', () => {
    const pedidos = [
      {
        status: 'EM_PREPARO' as const,
        itens: [
          item({ precoUnitarioCentavos: 2000 }),
          item({ precoUnitarioCentavos: 500, canceladoEm: new Date() }),
        ],
      },
    ];
    expect(calcularTotalComanda(pedidos)).toBe(2000);
  });

  it('usa o preco snapshot, nao o preco atual do produto', () => {
    // O item guarda 1000. Se o cardapio subiu para 1500 depois, nao importa:
    // calcularTotalComanda so ve o que esta no item.
    const pedidos = [{ status: 'ENTREGUE' as const, itens: [item({ precoUnitarioCentavos: 1000 })] }];
    expect(calcularTotalComanda(pedidos)).toBe(1000);
  });
});

describe('calcularTotalPorParticipante', () => {
  it('agrupa por apelido e joga item sem dono em compartilhado', () => {
    const pedidos = [
      {
        status: 'ENTREGUE' as const,
        itens: [
          { ...item({ precoUnitarioCentavos: 1000 }), participanteApelido: 'Ana' },
          { ...item({ precoUnitarioCentavos: 500 }), participanteApelido: 'Ana' },
          { ...item({ precoUnitarioCentavos: 800 }), participanteApelido: 'Joao' },
          { ...item({ precoUnitarioCentavos: 300 }), participanteApelido: null },
        ],
      },
    ];
    const mapa = calcularTotalPorParticipante(pedidos);
    expect(mapa.get('Ana')).toBe(1500);
    expect(mapa.get('Joao')).toBe(800);
    expect(mapa.get('compartilhado')).toBe(300);
  });

  it('exclui item cancelado da divisao', () => {
    const pedidos = [
      {
        status: 'ENTREGUE' as const,
        itens: [
          { ...item({ precoUnitarioCentavos: 1000 }), participanteApelido: 'Ana' },
          {
            ...item({ precoUnitarioCentavos: 9999, canceladoEm: new Date() }),
            participanteApelido: 'Ana',
          },
        ],
      },
    ];
    expect(calcularTotalPorParticipante(pedidos).get('Ana')).toBe(1000);
  });

  it('soma das partes bate com o total da comanda', () => {
    const pedidos = [
      {
        status: 'ENTREGUE' as const,
        itens: [
          { ...item({ qtd: 2, precoUnitarioCentavos: 1250 }), participanteApelido: 'Ana' },
          { ...item({ precoUnitarioCentavos: 799 }), participanteApelido: 'Joao' },
          { ...item({ precoUnitarioCentavos: 300 }), participanteApelido: null },
        ],
      },
    ];
    const soma = [...calcularTotalPorParticipante(pedidos).values()].reduce((a, b) => a + b, 0);
    expect(soma).toBe(calcularTotalComanda(pedidos));
  });
});

describe('formatarBRL', () => {
  it('formata centavos', () => {
    //   = espaco nao separavel que o Intl insere apos "R$"
    expect(formatarBRL(1250).replace(/ /g, ' ')).toBe('R$ 12,50');
    expect(formatarBRL(0).replace(/ /g, ' ')).toBe('R$ 0,00');
  });
});
