// Situação do ASO de cada funcionário (NR-7).
// Vale o ASO não anulado mais recente (que não seja demissional): se ele deu inapto, é isso que importa,
// mesmo que um ASO anterior ainda estivesse "no prazo".
const { hoje, somarDias, diasEntre } = require('../utils/datas');

const TIPOS = ['admissional', 'periodico', 'retorno_trabalho', 'mudanca_risco', 'demissional'];
const RESULTADOS = ['apto', 'apto_restricao', 'inapto'];
const SITUACOES = ['faltando', 'inapto', 'vencido', 'vencendo', 'demissional_pendente', 'em_dia'];

// NR-7 7.5.11: demissional em até 10 dias do fim do contrato; dispensado se o último exame clínico
// tem menos de 135 dias (grau de risco 1 e 2) ou 90 dias (3 e 4). Sem grau informado, usa 90 (mais rígido).
const PRAZO_DEMISSIONAL_DIAS = 10;
const JANELA_DESLIGADOS_DIAS = 60; // desligados há mais tempo saem da lista de pendências
function diasDispensaDemissional(grauRisco) {
  return grauRisco === 1 || grauRisco === 2 ? 135 : 90;
}

// ASOs válidos (não anulados) dos funcionários, do mais recente para o mais antigo
async function asosValidos(trx, funcionarioIds) {
  if (!funcionarioIds.length) return new Map();
  const linhas = await trx('asos as a')
    .leftJoin('aso_anulacoes as n', 'n.aso_id', 'a.id')
    .whereIn('a.funcionario_id', funcionarioIds)
    .whereNull('n.id')
    .select('a.id', 'a.funcionario_id', 'a.tipo', 'a.data_exame', 'a.resultado', 'a.data_vencimento')
    .orderBy([{ column: 'a.data_exame', order: 'desc' }, { column: 'a.id', order: 'desc' }]);
  const porFuncionario = new Map();
  for (const a of linhas) {
    if (!porFuncionario.has(a.funcionario_id)) porFuncionario.set(a.funcionario_id, []);
    porFuncionario.get(a.funcionario_id).push(a);
  }
  return porFuncionario;
}

function situacaoAtivo(ultimo, { dataHoje, limite }) {
  if (!ultimo) return 'faltando';
  if (ultimo.resultado === 'inapto') return 'inapto';
  if (ultimo.data_vencimento < dataHoje) return 'vencido';
  if (ultimo.data_vencimento <= limite) return 'vencendo';
  return 'em_dia';
}

// funcionarios: [{ id, nome, matricula, status, data_demissao, filial_id, filial, grau_risco, setor, funcao }]
async function situacaoDosAsos(trx, funcionarios, { dias = 30 } = {}) {
  const asos = await asosValidos(trx, funcionarios.map((f) => f.id));
  const dataHoje = hoje();
  const limite = somarDias(dataHoje, dias);
  const resultado = [];

  for (const f of funcionarios) {
    const lista = asos.get(f.id) || [];
    const linha = {
      funcionario_id: f.id, funcionario: f.nome, matricula: f.matricula, status: f.status,
      filial_id: f.filial_id, filial: f.filial, setor: f.setor, funcao: f.funcao
    };

    if (f.status === 'Ativo') {
      const ultimo = lista.find((a) => a.tipo !== 'demissional');
      resultado.push({
        ...linha,
        situacao: situacaoAtivo(ultimo, { dataHoje, limite }),
        com_restricao: !!ultimo && ultimo.resultado === 'apto_restricao',
        ultimo_exame: ultimo ? ultimo.data_exame : null,
        ultimo_tipo: ultimo ? ultimo.tipo : null,
        vencimento: ultimo ? ultimo.data_vencimento : null,
        aso_id: ultimo ? ultimo.id : null
      });
      continue;
    }

    // Desligado recentemente: precisa de demissional, salvo dispensa pelo exame recente
    if (!f.data_demissao || diasEntre(f.data_demissao, dataHoje) > JANELA_DESLIGADOS_DIAS) continue;
    if (lista.some((a) => a.tipo === 'demissional')) continue;
    const ultimo = lista[0];
    const dispensa = diasDispensaDemissional(f.grau_risco);
    if (ultimo && diasEntre(ultimo.data_exame, f.data_demissao) - 1 < dispensa) continue;
    resultado.push({
      ...linha,
      situacao: 'demissional_pendente',
      com_restricao: false,
      ultimo_exame: ultimo ? ultimo.data_exame : null,
      ultimo_tipo: ultimo ? ultimo.tipo : null,
      vencimento: somarDias(f.data_demissao, PRAZO_DEMISSIONAL_DIAS), // prazo para fazer o demissional
      aso_id: ultimo ? ultimo.id : null
    });
  }

  return resultado.sort((a, b) =>
    SITUACOES.indexOf(a.situacao) - SITUACOES.indexOf(b.situacao) ||
    String(a.vencimento || '').localeCompare(String(b.vencimento || '')) ||
    a.funcionario.localeCompare(b.funcionario));
}

module.exports = { situacaoDosAsos, TIPOS, RESULTADOS, SITUACOES, diasDispensaDemissional };
