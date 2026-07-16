import { describe, it, expect } from 'vitest';
import {
  calcularTotalItens,
  calcularTotalComanda,
  calcularTotalPorParticipante,
  formatarBRL,
  parsearBRL,
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

describe('parsearBRL', () => {
  it('virgula e ponto dao o mesmo centavo', () => {
    expect(parsearBRL('19,90')).toBe(1990);
    expect(parsearBRL('19.90')).toBe(1990);
  });

  it('inteiro sem separador', () => {
    expect(parsearBRL('19')).toBe(1900);
    expect(parsearBRL('0')).toBe(0);
  });

  it('um decimal so e a casa das DEZENAS de centavo', () => {
    expect(parsearBRL('19,9')).toBe(1990); // dezenove e noventa, nao 19,09
  });

  /**
   * O caso que justifica a funcao existir. parseFloat('19.99') * 100 da
   * 1998.9999999999998; o preco vai errado para o banco ou o arredondamento
   * vira aposta. Aqui os centavos saem do texto, inteiros.
   */
  it('nao passa por float', () => {
    expect(parsearBRL('19,99')).toBe(1999);
    expect(parsearBRL('0,07')).toBe(7);
    expect(parsearBRL('8,29')).toBe(829);
    expect(parsearBRL('1234,56')).toBe(123456);
  });

  it('aceita o R$ que o operador cola junto', () => {
    expect(parsearBRL('R$ 19,90')).toBe(1990);
    expect(parsearBRL('  19,90  ')).toBe(1990);
  });

  it('lixo vira null, nao NaN nem zero', () => {
    for (const t of ['', 'abc', '19,905', '-5', '1,2,3', 'R$', '.']) {
      expect(parsearBRL(t)).toBeNull();
    }
  });
  /**
   * Ida e volta ate R$ 999,99. Acima disso o Intl insere ponto de milhar, que
   * o parser recusa DE PROPOSITO — ver o teste seguinte.
   *
   * O   e o NBSP que o Intl enfia depois do "R$".
   */
  it('ida e volta com formatarBRL abaixo do milhar', () => {
    for (const c of [0, 7, 829, 1990, 99999]) {
      expect(parsearBRL(formatarBRL(c).replace(/ /gu, ' '))).toBe(c);
    }
  });

  /**
   * DECISAO, nao limitacao esquecida: `parsearBRL` NAO e o inverso total de
   * `formatarBRL`, e este teste existe para que ninguem "conserte" isso sem ler.
   *
   * "1.500" e ambiguo — em pt-BR e mil e quinhentos, mas quem tem o dedo no
   * teclado americano digita isso querendo R$ 1,50. Adivinhar erra por 1000x e
   * em silencio; recusar erra alto e o operador reescreve. Numa carta de vinhos
   * essa diferenca e a conta inteira.
   *
   * Quem chama e responsavel por dizer "sem ponto de milhar" ao usuario.
   */
  it('recusa ponto de milhar, inclusive o que o proprio formatarBRL produz', () => {
    expect(parsearBRL('1.234,56')).toBeNull();
    expect(parsearBRL('1.500')).toBeNull();
    expect(parsearBRL(formatarBRL(123456).replace(/ /gu, ' '))).toBeNull();

    // E o mesmo valor, escrito sem o separador, passa.
    expect(parsearBRL('1234,56')).toBe(123456);
  });
});
