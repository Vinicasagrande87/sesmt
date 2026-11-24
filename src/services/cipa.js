// Regras da CIPA (NR-5): dimensionamento (Quadro I, por grau de risco e nº de empregados), carga do treinamento,
// prazos da eleição, estabilidade do cipeiro e a situação de cada filial (hoje ou numa data-base).
const { hoje, somarDias, somarMeses, diasEntre } = require('../utils/datas');
const { noEscopo } = require('../utils/escopo');
const { funcionariosNaData } = require('./historico');

// NR-5, Quadro I — conferir com o texto vigente (Portaria MTP 422/2021). Faixas de empregados até:
const FAIXAS = [19, 29, 50, 80, 100, 120, 140, 300, 500, 1000, 2500, 5000, 10000];
const QUADRO = {
  1: { efetivos: [0, 0, 0, 0, 1, 1, 1, 1, 2, 4, 5, 6, 8], suplentes: [0, 0, 0, 0, 1, 1, 1, 1, 2, 3, 4, 5, 6], acima: [1, 1] },
  2: { efetivos: [0, 1, 1, 2, 2, 2, 2, 3, 4, 5, 6, 8, 10], suplentes: [0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 5, 6, 8], acima: [1, 1] },
  3: { efetivos: [0, 1, 2, 2, 2, 3, 3, 4, 5, 6, 8, 10, 12], suplentes: [0, 1, 1, 1, 2, 2, 2, 3, 4, 4, 6, 8, 8], acima: [2, 2] },
  4: { efetivos: [0, 1, 2, 3, 3, 4, 4, 4, 5, 6, 9, 11, 13], suplentes: [0, 1, 1, 2, 2, 2, 2, 3, 4, 5, 7, 8, 10], acima: [2, 2] }
};
// NR-5, 5.7.4: carga horária mínima do treinamento por grau de risco
const CARGA_TREINAMENTO = { 1: 8, 2: 12, 3: 16, 4: 20 };
const MANDATO_MESES = 12;
const PRAZOS = { edital: 60, inscricao_minima: 15, eleicao: 30, quorum: 0.5 }; // NR-5, 5.5
const DIAS_REUNIAO = 35;           // reunião ordinária mensal (folga de alguns dias)
const SITUACOES = ['grau_risco_nao_informado', 'sem_cipa', 'sem_designado', 'composicao_incompleta', 'membro_sem_treinamento',
  'reuniao_atrasada', 'edital_atrasado', 'edital_proximo', 'em_dia'];
const CARGOS = { presidente: 'Presidente', vice_presidente: 'Vice-presidente', secretario: 'Secretário' };

const nrDaCipa = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^NR0+/, 'NR') === 'NR5';

// { tipo: cipa | designado | nenhum, efetivos, suplentes, carga_horaria }
function dimensionar(grauRisco, empregados) {
  const carga = CARGA_TREINAMENTO[grauRisco] || null;
  if (!QUADRO[grauRisco]) return { tipo: null, efetivos: null, suplentes: null, carga_horaria: null };
  if (!empregados) return { tipo: 'nenhum', efetivos: 0, suplentes: 0, carga_horaria: carga };
  const q = QUADRO[grauRisco];
  let i = FAIXAS.findIndex((limite) => empregados <= limite);
  let extra = 0;
  if (i === -1) {
    i = FAIXAS.length - 1;
    extra = Math.floor((empregados - 10000) / 2500); // acima de 10.000: a cada grupo de 2.500
  }
  const efetivos = q.efetivos[i] + extra * q.acima[0];
  const suplentes = q.suplentes[i] + extra * q.acima[1];
  return { tipo: efetivos ? 'cipa' : 'designado', efetivos, suplentes, carga_horaria: carga };
}

// Prazos da eleição para um mandato que começa em `inicio` (NR-5, 5.5)
function conferirPrazosEleicao({ inicio, edital_em: edital, inscricoes_inicio: insIni, inscricoes_fim: insFim, data_eleicao: eleicao }) {
  const alertas = [];
  if (edital > somarDias(inicio, -PRAZOS.edital)) alertas.push(`edital publicado com menos de ${PRAZOS.edital} dias do início do mandato`);
  if (insIni < edital) alertas.push('inscrições começaram antes do edital');
  if (diasEntre(insIni, insFim) < PRAZOS.inscricao_minima) alertas.push(`período de inscrição menor que ${PRAZOS.inscricao_minima} dias`);
  if (eleicao <= insFim) alertas.push('eleição antes do fim das inscrições');
  if (eleicao > somarDias(inicio, -PRAZOS.eleicao)) alertas.push(`eleição com menos de ${PRAZOS.eleicao} dias do início do mandato`);
  return alertas;
}

// Estabilidade provisória (ADCT, art. 10, II, "a"; NR-5): candidato desde a inscrição até a eleição;
// representante eleito dos empregados (titular ou suplente) até 1 ano após o fim do mandato (renúncia encerra).
async function estabilidade(db, funcionarioId, data = hoje()) {
  const periodos = [];
  const candidaturas = await db('cipa_candidatos as c').join('cipa_eleicoes as e', 'e.id', 'c.eleicao_id').where('c.funcionario_id', funcionarioId)
    .select('c.inscrito_em', 'e.data_eleicao');
  for (const c of candidaturas) periodos.push({ de: c.inscrito_em, ate: c.data_eleicao, motivo: 'candidato à CIPA' });
  const mandatos = await db('cipa_membros as m').join('cipa_mandatos as d', 'd.id', 'm.mandato_id')
    .where({ 'm.funcionario_id': funcionarioId, 'm.representacao': 'empregados' }).select('m.inicio', 'm.fim', 'm.motivo_saida', 'd.fim as fim_mandato');
  for (const m of mandatos) periodos.push({ de: m.inicio, ate: m.fim || somarMeses(m.fim_mandato, 12), motivo: 'representante eleito dos empregados na CIPA' });
  const vigente = periodos.filter((p) => p.de <= data && data <= p.ate).sort((a, b) => b.ate.localeCompare(a.ate))[0];
  return vigente ? { estavel: true, ate: vigente.ate, motivo: vigente.motivo } : { estavel: false };
}

async function situacaoCipa(db, req, filtros = {}, { dataBase = null } = {}) {
  const dataRef = dataBase || hoje();
  const q = noEscopo(db('filiais'), req, 'id').where('ativa', true).orderBy('nome').select('id', 'nome', 'grau_risco');
  if (filtros.filial_id) q.where('id', filtros.filial_id);
  const filiais = await q;
  const pessoas = await funcionariosNaData(db, req, filtros.filial_id ? { filial_id: filtros.filial_id } : {}, { dataBase });
  const itens = [];
  for (const f of filiais) {
    const base = { filial_id: f.id, filial: f.nome };
    const empregados = pessoas.filter((p) => p.filial_id === f.id).length;
    const dim = dimensionar(f.grau_risco, empregados);
    const doFilial = [];
    const add = (situacao, extra = {}) => doFilial.push({ ...base, situacao, empregados, exigido: dim.tipo, ...extra });
    if (!dim.tipo) { add('grau_risco_nao_informado'); itens.push(...doFilial); continue; }
    if (dim.tipo === 'nenhum') { add('em_dia'); itens.push(...doFilial); continue; }

    const mandato = await db('cipa_mandatos').where('filial_id', f.id).where('inicio', '<=', dataRef).where('fim', '>=', dataRef).orderBy('inicio', 'desc').first();
    if (!mandato || (dim.tipo === 'cipa' && mandato.tipo !== 'cipa')) {
      add(dim.tipo === 'cipa' ? 'sem_cipa' : 'sem_designado', { detalhe: dim.tipo === 'cipa' ? `${dim.efetivos} titular(es) e ${dim.suplentes} suplente(s) dos empregados` : null });
      itens.push(...doFilial);
      continue;
    }
    const membros = await db('cipa_membros as m').join('funcionarios as fu', 'fu.id', 'm.funcionario_id').where('m.mandato_id', mandato.id)
      .where('m.inicio', '<=', dataRef).andWhere((w) => w.whereNull('m.fim').orWhere('m.fim', '>', dataRef)).select('m.*', 'fu.nome');
    const mb = { mandato_id: mandato.id, mandato_fim: mandato.fim };
    if (mandato.tipo === 'designado') {
      if (!membros.some((m) => m.representacao === 'designado')) add('sem_designado', mb);
    } else {
      const falta = [];
      const conta = (rep, cond) => membros.filter((m) => m.representacao === rep && m.condicao === cond).length;
      if (conta('empregados', 'titular') < mandato.efetivos_exigidos) falta.push(`titulares dos empregados: ${conta('empregados', 'titular')} de ${mandato.efetivos_exigidos}`);
      if (conta('empregados', 'suplente') < mandato.suplentes_exigidos) falta.push(`suplentes dos empregados: ${conta('empregados', 'suplente')} de ${mandato.suplentes_exigidos}`);
      if (conta('empregador', 'titular') < mandato.efetivos_exigidos) falta.push(`titulares do empregador: ${conta('empregador', 'titular')} de ${mandato.efetivos_exigidos}`);
      if (conta('empregador', 'suplente') < mandato.suplentes_exigidos) falta.push(`suplentes do empregador: ${conta('empregador', 'suplente')} de ${mandato.suplentes_exigidos}`);
      if (!membros.some((m) => m.cargo === 'presidente')) falta.push('sem presidente');
      if (!membros.some((m) => m.cargo === 'vice_presidente')) falta.push('sem vice-presidente');
      if (falta.length) add('composicao_incompleta', { ...mb, detalhe: falta.join('; ') });

      const ultima = await db('cipa_reunioes as r').leftJoin('cipa_reuniao_anulacoes as n', 'n.reuniao_id', 'r.id').whereNull('n.id')
        .where({ 'r.mandato_id': mandato.id, 'r.tipo': 'ordinaria' }).where('r.data', '<=', dataRef).max({ data: 'r.data' }).first();
      const desde = ultima && ultima.data ? ultima.data : mandato.inicio;
      if (diasEntre(desde, dataRef) - 1 > DIAS_REUNIAO) add('reuniao_atrasada', { ...mb, detalhe: ultima && ultima.data ? `última ordinária em ${desde.split('-').reverse().join('/')}` : 'nenhuma reunião ordinária no mandato', vencimento: somarDias(desde, DIAS_REUNIAO) });

      // Próxima eleição: edital até 60 dias antes do início do próximo mandato
      const proximoInicio = somarDias(mandato.fim, 1);
      const prazoEdital = somarDias(proximoInicio, -PRAZOS.edital);
      const proxima = await db('cipa_mandatos as d').join('cipa_eleicoes as e', 'e.mandato_id', 'd.id')
        .where('d.filial_id', f.id).where('d.inicio', '>', mandato.inicio).where('e.edital_em', '<=', dataRef).first('e.id');
      if (!proxima && dataRef > prazoEdital) add('edital_atrasado', { ...mb, vencimento: prazoEdital });
      else if (!proxima && dataRef >= somarDias(prazoEdital, -30)) add('edital_proximo', { ...mb, vencimento: prazoEdital });
    }
    // Treinamento de cada membro (NR-5, 5.7): curso da NR-5 com a carga mínima do grau de risco
    const certs = membros.length ? await db('certificados_treinamentos as c').join('treinamentos as t', 't.id', 'c.treinamento_id')
      .leftJoin('certificado_anulacoes as a', 'a.certificado_id', 'c.id').whereNull('a.id').where('c.status', 'Aprovado')
      .whereIn('c.funcionario_id', membros.map((m) => m.funcionario_id)).where('c.data_realizacao', '<=', dataRef)
      .select('c.funcionario_id', 'c.carga_horaria', 't.nr_referencia') : [];
    for (const m of membros) {
      const ok = certs.some((c) => c.funcionario_id === m.funcionario_id && nrDaCipa(c.nr_referencia) && (c.carga_horaria || 0) >= dim.carga_horaria);
      if (!ok) add('membro_sem_treinamento', { ...mb, membro_id: m.id, funcionario_id: m.funcionario_id, membro: m.nome, detalhe: `treinamento NR-5 de ${dim.carga_horaria} h` });
    }
    if (!doFilial.length) add('em_dia', mb);
    itens.push(...doFilial);
  }
  return itens.sort((a, b) => SITUACOES.indexOf(a.situacao) - SITUACOES.indexOf(b.situacao) || a.filial.localeCompare(b.filial));
}

module.exports = {
  FAIXAS, QUADRO, CARGA_TREINAMENTO, MANDATO_MESES, PRAZOS, DIAS_REUNIAO, SITUACOES, CARGOS,
  dimensionar, conferirPrazosEleicao, estabilidade, situacaoCipa
};
