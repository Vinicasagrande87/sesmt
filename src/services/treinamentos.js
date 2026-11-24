// Situação dos treinamentos exigidos pela função de cada funcionário.
// Vale o registro aprovado e não anulado com o vencimento mais distante (null = não vence).
// Com dataBase: só treinamentos realizados até a data e as exigências que a função tinha naquele dia.
const { hoje, somarDias, fimDoDia } = require('../utils/datas');
const { funcionariosNaData } = require('./historico');

const SITUACOES = ['faltando', 'vencido', 'vencendo', 'em_dia'];

// Último registro válido por (funcionário, treinamento)
async function capacitacoesValidas(trx, funcionarioIds, { dataBase = null } = {}) {
  if (!funcionarioIds.length) return new Map();
  const q = trx('certificados_treinamentos as c')
    .leftJoin('certificado_anulacoes as a', 'a.certificado_id', 'c.id')
    .whereIn('c.funcionario_id', funcionarioIds)
    .whereNull('a.id')
    .where('c.status', 'Aprovado')
    .select('c.id', 'c.funcionario_id', 'c.treinamento_id', 'c.data_realizacao', 'c.data_vencimento', 'c.origem', 'c.created_at');
  if (dataBase) q.where('c.data_realizacao', '<=', dataBase);
  const linhas = await q;

  const melhor = new Map();
  for (const c of linhas) {
    const chave = `${c.funcionario_id}:${c.treinamento_id}`;
    const atual = melhor.get(chave);
    // sem vencimento ganha; senão, o vencimento mais distante
    const vence = c.data_vencimento || '9999-12-31';
    if (!atual || vence > (atual.data_vencimento || '9999-12-31')) melhor.set(chave, c);
  }
  return melhor;
}

// O que cada função exige (hoje, ou o que exigia até o fim do dia da data-base)
function exigenciasDasFuncoes(trx, funcaoIds, { dataBase = null } = {}) {
  if (!dataBase) {
    return trx('funcao_treinamentos as ft')
      .join('treinamentos as t', 't.id', 'ft.treinamento_id')
      .whereIn('ft.funcao_id', funcaoIds)
      .where('t.ativo', true)
      .select('ft.funcao_id', 't.id as treinamento_id', 't.nome_treinamento', 't.nr_referencia', 't.validade_meses');
  }
  const corte = fimDoDia(dataBase);
  return trx('funcao_treinamento_vigencias as v')
    .join('treinamentos as t', 't.id', 'v.treinamento_id')
    .whereIn('v.funcao_id', funcaoIds)
    .where('v.inicio', '<', corte)
    .andWhere((w) => w.whereNull('v.fim').orWhere('v.fim', '>=', corte))
    .distinct('v.funcao_id', 't.id as treinamento_id', 't.nome_treinamento', 't.nr_referencia', 't.validade_meses');
}

function classificar(capacitacao, { dataHoje, limite }) {
  if (!capacitacao) return 'faltando';
  if (!capacitacao.data_vencimento) return 'em_dia';
  if (capacitacao.data_vencimento < dataHoje) return 'vencido';
  if (capacitacao.data_vencimento <= limite) return 'vencendo';
  return 'em_dia';
}

// funcionarios: [{ id, nome, matricula, funcao_id, funcao, filial_id, filial, setor }]
async function situacaoDosFuncionarios(trx, funcionarios, { dias = 30, dataBase = null } = {}) {
  const funcaoIds = [...new Set(funcionarios.map((f) => f.funcao_id).filter(Boolean))];
  if (!funcaoIds.length) return [];

  const exigencias = await exigenciasDasFuncoes(trx, funcaoIds, { dataBase });
  const validas = await capacitacoesValidas(trx, funcionarios.map((f) => f.id), { dataBase });
  const dataHoje = dataBase || hoje();
  const limite = somarDias(dataHoje, dias);
  const corte = dataBase ? fimDoDia(dataBase) : null;

  const resultado = [];
  for (const f of funcionarios) {
    for (const e of exigencias.filter((x) => x.funcao_id === f.funcao_id)) {
      const cap = validas.get(`${f.id}:${e.treinamento_id}`);
      const linha = {
        funcionario_id: f.id,
        funcionario: f.nome,
        matricula: f.matricula,
        filial_id: f.filial_id,
        filial: f.filial,
        setor: f.setor,
        funcao: f.funcao,
        treinamento_id: e.treinamento_id,
        treinamento: e.nome_treinamento,
        nr: e.nr_referencia,
        situacao: classificar(cap, { dataHoje, limite }),
        ultima_realizacao: cap ? cap.data_realizacao : null,
        vencimento: cap ? cap.data_vencimento : null,
        certificado_id: cap ? cap.id : null
      };
      if (corte) linha.lancado_depois = !!cap && new Date(cap.created_at) >= corte;
      resultado.push(linha);
    }
  }
  return resultado.sort((a, b) =>
    SITUACOES.indexOf(a.situacao) - SITUACOES.indexOf(b.situacao) ||
    String(a.vencimento || '').localeCompare(String(b.vencimento || '')) ||
    a.funcionario.localeCompare(b.funcionario));
}

// Todas as linhas (inclusive em dia) da filial/setor/funcionário, hoje ou na data-base
async function situacaoTreinamentos(db, req, filtros = {}, { dias = 30, dataBase = null } = {}) {
  const funcionarios = await funcionariosNaData(db, req, filtros, { dataBase });
  return situacaoDosFuncionarios(db, funcionarios.filter((f) => f.funcao_id), { dias, dataBase });
}

module.exports = { situacaoDosFuncionarios, situacaoTreinamentos, capacitacoesValidas, SITUACOES };
