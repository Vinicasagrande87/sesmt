// Fechamento mensal por filial.
// Congela (1) a situação de cada módulo no último dia do mês e (2) a impressão digital (SHA-256) de cada
// registro de prova lançado no mês (entregas, presenças, certificados, ASOs, ciências, inspeções,
// manutenções, PPCI, alvarás, estornos e anulações). Também ancora o fechamento na cadeia da auditoria.
// Depois, a conferência recalcula tudo: qualquer registro alterado, apagado ou incluído com data
// retroativa aparece, e o fechamento é encadeado ao anterior da mesma filial.
const { canonico, sha256, hashCanonico } = require('../utils/hash');
const { somarDias, somarMeses, fimDoDia } = require('../utils/datas');
const { MODULOS, consolidar } = require('./conformidade');
const { GENESIS } = require('./integridade');

const local = (col) => `(${col} at time zone 'America/Sao_Paulo')::date`;
// Filial do funcionário numa data: a lotação da época (ou o cadastro, se não houver lotação)
const filialDoFuncionario = (funcionario, data) => `coalesce((select l.filial_id from funcionario_lotacoes l
  where l.funcionario_id = ${funcionario} and l.inicio <= ${data} and (l.fim is null or l.fim >= ${data})
  order by l.inicio desc, l.id desc limit 1), (select f.filial_id from funcionarios f where f.id = ${funcionario}))`;

const filialCertificado = (c) => `coalesce((select tu.filial_id from turmas tu where tu.id = ${c}.turma_id), ${filialDoFuncionario(`${c}.funcionario_id`, local(`${c}.created_at`))})`;

// tabela -> coluna do instante de lançamento e expressão SQL da filial (t = a própria linha)
const FONTES = {
  entregas: { quando: 'created_at', filial: 't.filial_id' },
  entrega_estornos: { quando: 'created_at', filial: '(select e.filial_id from entregas e where e.id = t.entrega_id)' },
  movimentacoes: { quando: 'created_at', filial: 't.filial_id' },
  turma_presencas: { quando: 'assinado_em', filial: '(select tu.filial_id from turmas tu where tu.id = t.turma_id)' },
  presenca_anulacoes: { quando: 'created_at', filial: '(select tu.filial_id from turma_presencas p join turmas tu on tu.id = p.turma_id where p.id = t.presenca_id)' },
  certificados_treinamentos: { quando: 'created_at', filial: filialCertificado('t') },
  certificado_anulacoes: { quando: 'created_at', filial: `(select ${filialCertificado('c')} from certificados_treinamentos c where c.id = t.certificado_id)` },
  asos: { quando: 'created_at', filial: 't.filial_id' },
  aso_anulacoes: { quando: 'created_at', filial: '(select a.filial_id from asos a where a.id = t.aso_id)' },
  os_ciencias: { quando: 'assinado_em', filial: filialDoFuncionario('t.funcionario_id', 't.data_ciencia') },
  os_ciencia_anulacoes: { quando: 'created_at', filial: `(select ${filialDoFuncionario('c.funcionario_id', 'c.data_ciencia')} from os_ciencias c where c.id = t.ciencia_id)` },
  equipamento_inspecoes: { quando: 'data_hora', filial: 't.filial_id' },
  inspecao_anulacoes: { quando: 'created_at', filial: '(select i.filial_id from equipamento_inspecoes i where i.id = t.inspecao_id)' },
  equipamento_manutencoes: { quando: 'created_at', filial: '(select e.filial_id from equipamentos_incendio e where e.id = t.equipamento_id)' },
  manutencao_anulacoes: { quando: 'created_at', filial: '(select e.filial_id from equipamento_manutencoes m join equipamentos_incendio e on e.id = m.equipamento_id where m.id = t.manutencao_id)' },
  ppcis: { quando: 'created_at', filial: 't.filial_id' },
  ppci_anulacoes: { quando: 'created_at', filial: '(select p.filial_id from ppcis p where p.id = t.ppci_id)' },
  alvaras: { quando: 'created_at', filial: 't.filial_id' },
  alvara_anulacoes: { quando: 'created_at', filial: '(select a.filial_id from alvaras a where a.id = t.alvara_id)' }
};

function periodo(competencia) {
  const inicio = `${competencia}-01`;
  const ultimoDia = somarDias(somarMeses(inicio, 1), -1);
  return { inicio, ultimoDia, de: new Date(`${inicio}T00:00:00-03:00`), ate: fimDoDia(ultimoDia) };
}

// { fonte: [[id, sha256 da linha], ...] } dos registros lançados no mês na filial
async function impressoesDoMes(db, filialId, competencia) {
  const { de, ate } = periodo(competencia);
  const resultado = {};
  for (const [tabela, f] of Object.entries(FONTES)) {
    const linhas = await db(`${tabela} as t`).whereRaw(`${f.filial} = ?`, [filialId])
      .where(`t.${f.quando}`, '>=', de).where(`t.${f.quando}`, '<', ate).orderBy('t.id').select('t.*');
    resultado[tabela] = linhas.map((l) => [Number(l.id), hashCanonico(l)]);
  }
  return resultado;
}

const resumoDasImpressoes = (lista) => ({ quantidade: lista.length, hash: sha256(lista.map(([id, h]) => `${id}:${h}`).join('\n')), itens: lista });

const hashDoFechamento = ({ hashAnterior, filialId, competencia, hashConteudo, fechadoEm }) =>
  sha256(`${hashAnterior || GENESIS}|${filialId}|${competencia}|${hashConteudo}|${new Date(fechadoEm).toISOString()}`);

// Situação dos módulos no último dia do mês + impressões dos registros. Volta pronto para gravar.
async function montarFechamento(db, req, filial, competencia, ancora) {
  const { ultimoDia } = periodo(competencia);
  const modulos = {};
  const situacao = {};
  for (const [chave, modulo] of Object.entries(MODULOS)) {
    const calc = await modulo.calcular(db, req, { filial_id: filial.id }, { dataBase: ultimoDia });
    const itens = calc.itens.filter((i) => i.filial_id === filial.id);
    const { resumo: _r, ...totais } = consolidar(modulo, itens, calc.unidades.filter((u) => u.filial_id === filial.id));
    modulos[chave] = { nome: modulo.nome, ...totais };
    situacao[chave] = itens;
  }
  const impressoes = await impressoesDoMes(db, filial.id, competencia);
  const registros = Object.fromEntries(Object.entries(impressoes).map(([t, lista]) => [t, resumoDasImpressoes(lista)]));
  const conteudo = JSON.parse(JSON.stringify({
    filial: { id: filial.id, nome: filial.nome, cnpj: filial.cnpj }, competencia, data_base: ultimoDia,
    modulos, situacao, registros, auditoria: ancora
  }));
  const blocos = Object.values(modulos);
  const total = blocos.reduce((t, b) => t + b.total, 0);
  const emDia = blocos.reduce((t, b) => t + b.em_dia, 0);
  const ordem = ['cinza', 'verde', 'amarelo', 'vermelho'];
  const resumo = {
    cor: blocos.reduce((c, b) => (ordem.indexOf(b.cor) > ordem.indexOf(c) ? b.cor : c), 'cinza'),
    percentual: total ? Math.round((emDia / total) * 1000) / 10 : null,
    modulos: Object.fromEntries(Object.entries(modulos).map(([k, m]) => [k, { cor: m.cor, total: m.total, em_dia: m.em_dia, amarelo: m.amarelo, vermelho: m.vermelho }])),
    registros: Object.fromEntries(Object.entries(registros).map(([t, r]) => [t, r.quantidade]))
  };
  return { conteudo, resumo, hashConteudo: sha256(canonico(conteudo)), ultimoDia };
}

// Recalcula e compara: conteúdo, encadeamento, âncora da auditoria e cada registro do mês
async function conferirFechamento(db, fechamento) {
  const conteudoIntegro = sha256(canonico(fechamento.conteudo)) === fechamento.hash_conteudo;
  const anterior = await db('fechamentos').where('filial_id', fechamento.filial_id).where('id', '<', fechamento.id).orderBy('id', 'desc').first('hash');
  const encadeamentoOk = (fechamento.hash_anterior || null) === (anterior ? anterior.hash : null) &&
    hashDoFechamento({ hashAnterior: fechamento.hash_anterior, filialId: fechamento.filial_id, competencia: fechamento.competencia,
      hashConteudo: fechamento.hash_conteudo, fechadoEm: fechamento.fechado_em }) === fechamento.hash;

  let auditoriaOk = true;
  if (fechamento.auditoria_sequencia) {
    const linha = await db('auditoria').where('sequencia', fechamento.auditoria_sequencia).first('hash');
    auditoriaOk = !!linha && linha.hash === fechamento.auditoria_hash;
  }

  const atuais = await impressoesDoMes(db, fechamento.filial_id, fechamento.competencia);
  const divergencias = {};
  for (const [tabela, lista] of Object.entries(atuais)) {
    const guardados = new Map(((fechamento.conteudo.registros[tabela] || {}).itens || []).map(([id, h]) => [id, h]));
    const agora = new Map(lista);
    const alterados = [...guardados].filter(([id, h]) => agora.has(id) && agora.get(id) !== h).map(([id]) => id);
    const removidos = [...guardados.keys()].filter((id) => !agora.has(id));
    const incluidosDepois = [...agora.keys()].filter((id) => !guardados.has(id));
    if (alterados.length || removidos.length || incluidosDepois.length) {
      divergencias[tabela] = { alterados, removidos, incluidos_depois: incluidosDepois };
    }
  }
  const registrosOk = !Object.keys(divergencias).length;
  return {
    ok: conteudoIntegro && encadeamentoOk && auditoriaOk && registrosOk,
    conteudo_integro: conteudoIntegro, encadeamento_ok: encadeamentoOk, auditoria_ok: auditoriaOk, registros_ok: registrosOk, divergencias
  };
}

module.exports = { FONTES, periodo, impressoesDoMes, montarFechamento, conferirFechamento, hashDoFechamento };
