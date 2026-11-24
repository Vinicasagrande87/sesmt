// Painel de conformidade (semáforo) por filial e por módulo, hoje ou como estava numa data-base.
// vermelho = há item vencido/faltando (ação imediata); amarelo = só itens vencendo ou para conferir;
// verde = tudo em dia; cinza = nada a verificar (ex.: filial sem prédio cadastrado).
const { situacaoTreinamentos } = require('./treinamentos');
const { situacaoAsos } = require('./asos');
const { situacaoOrdensServico } = require('./ordensServico');
const { situacaoPpci, DIAS_EQUIPAMENTO, DIAS_ALVARA } = require('./ppci');
const { situacaoOcorrencias } = require('./ocorrencias');
const { situacaoAcoes } = require('./acoes');
const { situacaoPermissoes } = require('./permissoes');

const ORDEM_COR = ['cinza', 'verde', 'amarelo', 'vermelho'];
const pior = (a, b) => (ORDEM_COR.indexOf(a) >= ORDEM_COR.indexOf(b) ? a : b);

// Cada módulo: como calcular, a gravidade de cada item e a "unidade" que ele afeta
const MODULOS = {
  treinamentos: {
    nome: 'Treinamentos',
    async calcular(db, req, filtros, o) {
      const itens = await situacaoTreinamentos(db, req, filtros, o);
      return { itens, unidades: itens.map((i) => ({ filial_id: i.filial_id, chave: `${i.funcionario_id}:${i.treinamento_id}` })) };
    },
    chave: (i) => `${i.funcionario_id}:${i.treinamento_id}`,
    gravidade: (i) => (['faltando', 'vencido'].includes(i.situacao) ? 'vermelho' : i.situacao === 'vencendo' ? 'amarelo' : null)
  },
  asos: {
    nome: 'ASOs',
    async calcular(db, req, filtros, o) {
      const itens = await situacaoAsos(db, req, filtros, o);
      return { itens, unidades: itens.map((i) => ({ filial_id: i.filial_id, chave: String(i.funcionario_id) })) };
    },
    chave: (i) => String(i.funcionario_id),
    gravidade: (i) => (['faltando', 'inapto', 'vencido', 'demissional_pendente'].includes(i.situacao) ? 'vermelho' : i.situacao === 'vencendo' ? 'amarelo' : null)
  },
  ordens_servico: {
    nome: 'Ordens de serviço',
    async calcular(db, req, filtros, o) {
      const itens = await situacaoOrdensServico(db, req, filtros, o);
      return { itens, unidades: itens.map((i) => ({ filial_id: i.filial_id, chave: String(i.funcionario_id) })) };
    },
    chave: (i) => String(i.funcionario_id),
    gravidade: (i) => (i.situacao !== 'em_dia' || i.pgr_vencido ? 'vermelho' : (i.epis_nunca_entregues || []).length ? 'amarelo' : null)
  },
  ppci: {
    nome: 'PPCI',
    calcular: (db, req, filtros, o) => situacaoPpci(db, req, filtros, o),
    chave: (i) => (i.nivel === 'predio' ? `p${i.predio_id}` : `e${i.equipamento_id}`),
    gravidade: (i) => (i.situacao.endsWith('_vencendo') ? 'amarelo' : 'vermelho')
  },
  // Ocorrências abertas ou dos últimos 12 meses: CAT fora do prazo ou investigação atrasada = vermelho
  ocorrencias: {
    nome: 'Ocorrências (CAT e investigação)',
    async calcular(db, req, filtros, o) {
      const itens = await situacaoOcorrencias(db, req, filtros, { dataBase: o.dataBase });
      return { itens, unidades: itens.map((i) => ({ filial_id: i.filial_id, chave: `o${i.ocorrencia_id}` })) };
    },
    chave: (i) => `o${i.ocorrencia_id}`,
    gravidade: (i) => (['cat_pendente', 'investigacao_atrasada'].includes(i.situacao) ? 'vermelho' : i.situacao === 'cat_a_emitir' ? 'amarelo' : null)
  },
  // Plano de ação: atrasada = vermelho; vence em até 30 dias = amarelo
  acoes: {
    nome: 'Plano de ação',
    async calcular(db, req, filtros, o) {
      const itens = await situacaoAcoes(db, req, filtros, { dias: o.dias, dataBase: o.dataBase });
      return { itens, unidades: itens.map((i) => ({ filial_id: i.filial_id, chave: `a${i.acao_id}` })) };
    },
    chave: (i) => `a${i.acao_id}`,
    gravidade: (i) => (i.situacao === 'atrasada' ? 'vermelho' : i.situacao === 'vence_em_breve' ? 'amarelo' : null)
  },
  // Permissões de trabalho dos últimos 30 dias: vencida sem encerramento = vermelho; já começou sem todas as assinaturas = amarelo
  permissoes: {
    nome: 'Permissões de trabalho',
    async calcular(db, req, filtros, o) {
      const itens = await situacaoPermissoes(db, req, filtros, { dataBase: o.dataBase });
      return { itens, unidades: itens.map((i) => ({ filial_id: i.filial_id, chave: `pt${i.pt_id}` })) };
    },
    chave: (i) => `pt${i.pt_id}`,
    gravidade: (i) => (i.situacao === 'vencida_sem_encerramento' ? 'vermelho' : i.situacao === 'aguardando_assinaturas' ? 'amarelo' : null)
  }
};

function consolidar(modulo, itens, unidades) {
  const porUnidade = new Map();
  for (const i of itens) {
    const g = modulo.gravidade(i);
    if (g) porUnidade.set(modulo.chave(i), pior(porUnidade.get(modulo.chave(i)) || 'verde', g));
  }
  const total = new Set(unidades.map((u) => u.chave)).size;
  const vermelho = [...porUnidade.values()].filter((c) => c === 'vermelho').length;
  const amarelo = [...porUnidade.values()].filter((c) => c === 'amarelo').length;
  const resumo = {};
  for (const i of itens) if (modulo.gravidade(i)) resumo[i.situacao] = (resumo[i.situacao] || 0) + 1;
  return {
    cor: !total ? 'cinza' : vermelho ? 'vermelho' : amarelo ? 'amarelo' : 'verde',
    total, em_dia: total - vermelho - amarelo, amarelo, vermelho,
    percentual: total ? Math.round(((total - vermelho - amarelo) / total) * 1000) / 10 : null,
    resumo
  };
}

function somar(blocos) {
  const total = blocos.reduce((t, b) => t + b.total, 0);
  const emDia = blocos.reduce((t, b) => t + b.em_dia, 0);
  return {
    cor: blocos.reduce((c, b) => pior(c, b.cor), 'cinza'),
    total, em_dia: emDia,
    amarelo: blocos.reduce((t, b) => t + b.amarelo, 0),
    vermelho: blocos.reduce((t, b) => t + b.vermelho, 0),
    percentual: total ? Math.round((emDia / total) * 1000) / 10 : null
  };
}

// filiais: [{ id, nome }] já filtradas pelo escopo do usuário
async function painelConformidade(db, req, filiais, { dias = 30, diasAlvara = DIAS_ALVARA, diasEquipamento = DIAS_EQUIPAMENTO, dataBase = null } = {}) {
  const filtros = filiais.length === 1 ? { filial_id: filiais[0].id } : {};
  const calculados = {};
  for (const [chave, modulo] of Object.entries(MODULOS)) {
    const opcoes = chave === 'ppci' ? { dias: diasEquipamento, diasAlvara, dataBase } : { dias, dataBase };
    calculados[chave] = await modulo.calcular(db, req, filtros, opcoes);
  }

  const porFilial = filiais.map((f) => {
    const modulos = {};
    for (const [chave, modulo] of Object.entries(MODULOS)) {
      const { itens, unidades } = calculados[chave];
      modulos[chave] = { nome: modulo.nome, ...consolidar(modulo, itens.filter((i) => i.filial_id === f.id), unidades.filter((u) => u.filial_id === f.id)) };
    }
    return { filial_id: f.id, filial: f.nome, ...somar(Object.values(modulos)), modulos };
  });

  const geralModulos = {};
  for (const [chave, modulo] of Object.entries(MODULOS)) {
    geralModulos[chave] = { nome: modulo.nome, ...somar(porFilial.map((f) => f.modulos[chave])) };
  }
  return { filiais: porFilial, geral: { ...somar(Object.values(geralModulos)), modulos: geralModulos } };
}

module.exports = { MODULOS, painelConformidade, consolidar, ORDEM_COR };
