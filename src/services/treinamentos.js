// Situação dos treinamentos exigidos pela função de cada funcionário.
// Vale o registro aprovado e não anulado com o vencimento mais distante (null = não vence).
const { hoje, somarDias } = require('../utils/datas');

const SITUACOES = ['faltando', 'vencido', 'vencendo', 'em_dia'];

// Último registro válido por (funcionário, treinamento)
async function capacitacoesValidas(trx, funcionarioIds) {
  if (!funcionarioIds.length) return new Map();
  const linhas = await trx('certificados_treinamentos as c')
    .leftJoin('certificado_anulacoes as a', 'a.certificado_id', 'c.id')
    .whereIn('c.funcionario_id', funcionarioIds)
    .whereNull('a.id')
    .where('c.status', 'Aprovado')
    .select('c.id', 'c.funcionario_id', 'c.treinamento_id', 'c.data_realizacao', 'c.data_vencimento', 'c.origem');

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

function classificar(capacitacao, { dataHoje, limite }) {
  if (!capacitacao) return 'faltando';
  if (!capacitacao.data_vencimento) return 'em_dia';
  if (capacitacao.data_vencimento < dataHoje) return 'vencido';
  if (capacitacao.data_vencimento <= limite) return 'vencendo';
  return 'em_dia';
}

// funcionarios: [{ id, nome, matricula, funcao_id, funcao, filial_id, filial, setor }]
async function situacaoDosFuncionarios(trx, funcionarios, { dias = 30 } = {}) {
  const funcaoIds = [...new Set(funcionarios.map((f) => f.funcao_id).filter(Boolean))];
  if (!funcaoIds.length) return [];

  const exigencias = await trx('funcao_treinamentos as ft')
    .join('treinamentos as t', 't.id', 'ft.treinamento_id')
    .whereIn('ft.funcao_id', funcaoIds)
    .where('t.ativo', true)
    .select('ft.funcao_id', 't.id as treinamento_id', 't.nome_treinamento', 't.nr_referencia', 't.validade_meses');

  const validas = await capacitacoesValidas(trx, funcionarios.map((f) => f.id));
  const dataHoje = hoje();
  const limite = somarDias(dataHoje, dias);

  const resultado = [];
  for (const f of funcionarios) {
    for (const e of exigencias.filter((x) => x.funcao_id === f.funcao_id)) {
      const cap = validas.get(`${f.id}:${e.treinamento_id}`);
      resultado.push({
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
      });
    }
  }
  return resultado.sort((a, b) =>
    SITUACOES.indexOf(a.situacao) - SITUACOES.indexOf(b.situacao) ||
    String(a.vencimento || '').localeCompare(String(b.vencimento || '')) ||
    a.funcionario.localeCompare(b.funcionario));
}

module.exports = { situacaoDosFuncionarios, capacitacoesValidas, SITUACOES };
