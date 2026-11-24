// CIPA (NR-5): dimensionamento, mandatos (CIPA ou designado), membros, eleição (prazos, candidatos, apuração com
// quórum e desempate), reuniões com ata, estabilidades e pendências.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { podeAcessarFilial, noEscopo } = require('../utils/escopo');
const { hoje, dataValida, somarDias, somarMeses } = require('../utils/datas');
const { idValido } = require('../utils/validacao');
const { salvarArquivo } = require('../utils/arquivos');
const { lerDataBase, filtrarPendencias } = require('../services/historico');
const { buscarNoEscopo } = require('./FuncionarioController');
const C = require('../services/cipa');

function texto(valor, max = 2000) {
  if (valor === undefined || valor === null) return null;
  const t = String(valor).trim();
  if (t.length > max) throw new ErroDeNegocio(400, `Texto muito longo (máximo ${max} caracteres)`);
  return t.length ? t : null;
}
function lerData(valor, nome, { futura = true } = {}) {
  if (!dataValida(valor)) throw new ErroDeNegocio(400, `${nome} no formato AAAA-MM-DD`);
  if (!futura && valor > hoje()) throw new ErroDeNegocio(400, `${nome} não pode ser futura`);
  return valor;
}

async function contarEmpregados(db, filialId) {
  const { n } = await db('funcionarios').where({ filial_id: filialId, status: 'Ativo' }).count({ n: '*' }).first();
  return Number(n);
}

async function mandatoNoEscopo(db, req, id, { travar = false } = {}) {
  if (!idValido(id)) throw new ErroDeNegocio(404, 'Mandato não encontrado');
  const q = db('cipa_mandatos').where({ id: Number(id) });
  if (travar) q.forUpdate();
  const m = await q.first();
  if (!m || !podeAcessarFilial(req, m.filial_id)) throw new ErroDeNegocio(404, 'Mandato não encontrado');
  return m;
}

async function eleicaoNoEscopo(db, req, id) {
  if (!idValido(id)) throw new ErroDeNegocio(404, 'Eleição não encontrada');
  const e = await db('cipa_eleicoes').where({ id: Number(id) }).first();
  if (!e) throw new ErroDeNegocio(404, 'Eleição não encontrada');
  const mandato = await mandatoNoEscopo(db, req, e.mandato_id).catch(() => { throw new ErroDeNegocio(404, 'Eleição não encontrada'); });
  return { eleicao: e, mandato };
}

// Funcionário da filial do mandato, ativo
async function funcionarioDoMandato(db, req, mandato, funcionarioId) {
  const f = await buscarNoEscopo(req, funcionarioId, db);
  if (f.filial_id !== mandato.filial_id) throw new ErroDeNegocio(400, `${f.nome} não é empregado desta filial`);
  if (f.status !== 'Ativo') throw new ErroDeNegocio(409, `${f.nome} não está ativo`);
  return f;
}

// NR-5: mandato de um ano, permitida uma reeleição (representante dos empregados, titular)
async function exigirLimiteReeleicao(db, mandato, funcionarioId) {
  const anteriores = await db('cipa_mandatos').where({ filial_id: mandato.filial_id, tipo: 'cipa' }).where('inicio', '<', mandato.inicio)
    .orderBy('inicio', 'desc').limit(2).select('id');
  if (anteriores.length < 2) return;
  const titularEm = await db('cipa_membros').whereIn('mandato_id', anteriores.map((a) => a.id))
    .where({ funcionario_id: funcionarioId, representacao: 'empregados', condicao: 'titular' }).countDistinct({ n: 'mandato_id' }).first();
  if (Number(titularEm.n) >= 2) throw new ErroDeNegocio(409, 'Já foi eleito e reeleito nos dois últimos mandatos: a NR-5 permite uma reeleição');
}

async function carregar(db, m) {
  const membros = await db('cipa_membros as x').join('funcionarios as f', 'f.id', 'x.funcionario_id').where('x.mandato_id', m.id)
    .orderBy([{ column: 'x.representacao' }, { column: 'x.condicao', order: 'desc' }, { column: 'x.votos', order: 'desc' }])
    .select('x.*', 'f.nome', 'f.matricula');
  const eleicao = await db('cipa_eleicoes').where({ mandato_id: m.id }).first();
  const candidatos = eleicao ? await db('cipa_candidatos as c').join('funcionarios as f', 'f.id', 'c.funcionario_id').leftJoin('cipa_votos as v', 'v.candidato_id', 'c.id')
    .where('c.eleicao_id', eleicao.id).orderBy([{ column: 'v.votos', order: 'desc' }, { column: 'f.nome' }])
    .select('c.id', 'c.funcionario_id', 'f.nome', 'c.inscrito_em', 'v.votos') : [];
  const reunioes = await db('cipa_reunioes as r').leftJoin('cipa_reuniao_anulacoes as n', 'n.reuniao_id', 'r.id').where('r.mandato_id', m.id)
    .orderBy('r.data', 'desc').select('r.id', 'r.tipo', 'r.data', 'r.pauta', 'r.ata', 'r.presentes', 'r.arquivo_id', 'r.created_at', db.raw('(n.id is not null) as anulada'));
  const filial = await db('filiais').where({ id: m.filial_id }).first('nome', 'grau_risco');
  return {
    ...m, filial: filial.nome, carga_treinamento: C.CARGA_TREINAMENTO[m.grau_risco] || null,
    membros: membros.map((x) => ({ ...x, ativo: !x.fim || x.fim > hoje(), nome_cargo: x.cargo ? C.CARGOS[x.cargo] : null })),
    eleicao: eleicao ? { ...eleicao, candidatos } : null, reunioes
  };
}

module.exports = {
  // GET /cipa/dimensionamento?filial_id= — o que a NR-5 exige hoje de cada filial
  async dimensionamento(req, res) {
    const q = noEscopo(knex('filiais'), req, 'id').where('ativa', true).orderBy('nome').select('id', 'nome', 'grau_risco');
    if (req.query.filial_id) q.where('id', req.query.filial_id);
    const lista = [];
    for (const f of await q) {
      const empregados = await contarEmpregados(knex, f.id);
      lista.push({ filial_id: f.id, filial: f.nome, grau_risco: f.grau_risco, empregados, ...C.dimensionar(f.grau_risco, empregados) });
    }
    return res.json(lista);
  },

  // GET /cipa/mandatos?filial_id=
  async mandatos(req, res) {
    const q = noEscopo(knex('cipa_mandatos as m'), req, 'm.filial_id').join('filiais as f', 'f.id', 'm.filial_id').orderBy('m.inicio', 'desc')
      .select('m.*', 'f.nome as filial', knex.raw('(select count(*)::int from cipa_membros x where x.mandato_id = m.id and (x.fim is null or x.fim > ?)) as membros_ativos', [hoje()]));
    if (req.query.filial_id) q.where('m.filial_id', req.query.filial_id);
    return res.json(await q);
  },

  async mandato(req, res) {
    return res.json(await carregar(knex, await mandatoNoEscopo(knex, req, req.params.id)));
  },

  // POST /cipa/mandatos { filial_id, inicio, fim?, tipo?, observacao? } — gestão. Grava o dimensionamento da data.
  async criarMandato(req, res) {
    const b = req.body || {};
    if (!idValido(b.filial_id) || !podeAcessarFilial(req, b.filial_id)) throw new ErroDeNegocio(404, 'Filial não encontrada');
    const inicio = lerData(b.inicio, 'inicio');
    const fim = b.fim ? lerData(b.fim, 'fim') : somarDias(somarMeses(inicio, C.MANDATO_MESES), -1);
    if (fim <= inicio) throw new ErroDeNegocio(400, 'fim deve ser depois do início');
    if (fim > somarDias(somarMeses(inicio, C.MANDATO_MESES), -1)) throw new ErroDeNegocio(400, 'O mandato da CIPA é de um ano');
    const novo = await knex.transaction(async (trx) => {
      const filial = await trx('filiais').where({ id: Number(b.filial_id) }).forUpdate().first('id', 'grau_risco');
      if (!filial.grau_risco) throw new ErroDeNegocio(409, 'Informe o grau de risco da filial (cadastro da filial) para dimensionar a CIPA');
      const empregados = await contarEmpregados(trx, filial.id);
      const dim = C.dimensionar(filial.grau_risco, empregados);
      const tipo = b.tipo || (dim.tipo === 'cipa' ? 'cipa' : 'designado');
      if (!['cipa', 'designado'].includes(tipo)) throw new ErroDeNegocio(400, 'tipo deve ser cipa ou designado');
      if (tipo === 'designado' && dim.tipo === 'cipa') throw new ErroDeNegocio(409, `Pelo Quadro I da NR-5 esta filial precisa de CIPA (${dim.efetivos} titular(es) e ${dim.suplentes} suplente(s) dos empregados)`);
      const sobrepoe = await trx('cipa_mandatos').where({ filial_id: filial.id }).where('inicio', '<=', fim).where('fim', '>=', inicio).first('id');
      if (sobrepoe) throw new ErroDeNegocio(409, 'Já há mandato nesta filial cobrindo parte deste período');
      const [m] = await trx('cipa_mandatos').insert({
        filial_id: filial.id, tipo, inicio, fim, grau_risco: filial.grau_risco, empregados,
        efetivos_exigidos: tipo === 'cipa' ? dim.efetivos : 0, suplentes_exigidos: tipo === 'cipa' ? dim.suplentes : 0,
        observacao: texto(b.observacao), criado_por: req.usuario.id
      }).returning('*');
      await auditar(trx, req, { acao: 'criar_mandato_cipa', tabela: 'cipa_mandatos', registro_id: m.id, filial_id: m.filial_id, depois: m });
      return m;
    });
    return res.status(201).json(await carregar(knex, novo));
  },

  // POST /cipa/mandatos/:id/membros { funcionario_id, representacao, condicao?, cargo?, inicio? } — gestão
  async adicionarMembro(req, res) {
    const b = req.body || {};
    const m = await knex.transaction(async (trx) => {
      const mandato = await mandatoNoEscopo(trx, req, req.params.id, { travar: true });
      if (mandato.fim < hoje()) throw new ErroDeNegocio(409, 'Mandato encerrado');
      const reps = mandato.tipo === 'designado' ? ['designado'] : ['empregador', 'empregados'];
      if (!reps.includes(b.representacao)) throw new ErroDeNegocio(400, `representacao deve ser: ${reps.join(', ')}`);
      const condicao = b.condicao || 'titular';
      if (!['titular', 'suplente'].includes(condicao)) throw new ErroDeNegocio(400, 'condicao deve ser titular ou suplente');
      if (b.cargo && !C.CARGOS[b.cargo]) throw new ErroDeNegocio(400, `cargo deve ser: ${Object.keys(C.CARGOS).join(', ')}`);
      if (b.cargo === 'presidente' && b.representacao !== 'empregador') throw new ErroDeNegocio(400, 'O presidente é indicado pelo empregador (NR-5)');
      if (b.cargo === 'vice_presidente' && b.representacao !== 'empregados') throw new ErroDeNegocio(400, 'O vice-presidente é escolhido entre os representantes dos empregados (NR-5)');
      const f = await funcionarioDoMandato(trx, req, mandato, b.funcionario_id);
      const ativos = await trx('cipa_membros').where({ mandato_id: mandato.id }).andWhere((w) => w.whereNull('fim').orWhere('fim', '>', hoje()));
      if (ativos.some((x) => x.funcionario_id === f.id)) throw new ErroDeNegocio(409, `${f.nome} já é membro deste mandato`);
      if (b.cargo && ativos.some((x) => x.cargo === b.cargo)) throw new ErroDeNegocio(409, `O cargo de ${C.CARGOS[b.cargo].toLowerCase()} já está ocupado`);
      if (mandato.tipo === 'designado' && ativos.length) throw new ErroDeNegocio(409, 'O mandato de designado tem uma pessoa só');
      if (b.representacao === 'empregados') {
        const eleicao = await trx('cipa_eleicoes').where({ mandato_id: mandato.id }).first('id');
        if (eleicao && !(await trx('cipa_candidatos').where({ eleicao_id: eleicao.id, funcionario_id: f.id }).first('id'))) {
          throw new ErroDeNegocio(409, 'Representante dos empregados precisa ter sido candidato na eleição deste mandato');
        }
        await exigirLimiteReeleicao(trx, mandato, f.id);
      }
      const inicio = b.inicio ? lerData(b.inicio, 'inicio') : (mandato.inicio > hoje() ? mandato.inicio : hoje());
      if (inicio < mandato.inicio || inicio > mandato.fim) throw new ErroDeNegocio(400, 'A posse precisa ser dentro do mandato');
      const [novo] = await trx('cipa_membros').insert({ mandato_id: mandato.id, funcionario_id: f.id, representacao: b.representacao, condicao,
        cargo: b.cargo || null, inicio, registrado_por: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'incluir_membro_cipa', tabela: 'cipa_membros', registro_id: novo.id, filial_id: mandato.filial_id, depois: novo });
      return mandato;
    });
    return res.status(201).json(await carregar(knex, m));
  },

  // PUT /cipa-membros/:id { cargo } — gestão (ex.: o vice-presidente é escolhido entre os eleitos; null tira o cargo)
  async definirCargo(req, res) {
    const cargo = req.body ? req.body.cargo : undefined;
    if (cargo === undefined) throw new ErroDeNegocio(400, 'Informe o cargo (ou null)');
    if (cargo !== null && !C.CARGOS[cargo]) throw new ErroDeNegocio(400, `cargo deve ser: ${Object.keys(C.CARGOS).join(', ')}`);
    const m = await knex.transaction(async (trx) => {
      const x = idValido(req.params.id) && await trx('cipa_membros').where({ id: Number(req.params.id) }).forUpdate().first();
      if (!x) throw new ErroDeNegocio(404, 'Membro não encontrado');
      const mandato = await mandatoNoEscopo(trx, req, x.mandato_id, { travar: true }).catch(() => { throw new ErroDeNegocio(404, 'Membro não encontrado'); });
      if (x.fim) throw new ErroDeNegocio(409, 'Membro já saiu do mandato');
      if (cargo === 'presidente' && x.representacao !== 'empregador') throw new ErroDeNegocio(400, 'O presidente é indicado pelo empregador (NR-5)');
      if (cargo === 'vice_presidente' && x.representacao !== 'empregados') throw new ErroDeNegocio(400, 'O vice-presidente é escolhido entre os representantes dos empregados (NR-5)');
      if (cargo && await trx('cipa_membros').where({ mandato_id: mandato.id, cargo }).whereNull('fim').whereNot('id', x.id).first('id')) {
        throw new ErroDeNegocio(409, `O cargo de ${C.CARGOS[cargo].toLowerCase()} já está ocupado`);
      }
      const [d] = await trx('cipa_membros').where({ id: x.id }).update({ cargo }).returning('*');
      await auditar(trx, req, { acao: 'cargo_membro_cipa', tabela: 'cipa_membros', registro_id: x.id, filial_id: mandato.filial_id, antes: x, depois: d });
      return mandato;
    });
    return res.json(await carregar(knex, m));
  },

  // POST /cipa-membros/:id/saida { motivo, fim? } — gestão (renúncia, desligamento, falta a reuniões...)
  async saidaMembro(req, res) {
    const motivo = texto(req.body && req.body.motivo, 2000);
    if (!motivo || motivo.length < 5) throw new ErroDeNegocio(400, 'Informe o motivo da saída');
    const m = await knex.transaction(async (trx) => {
      const x = idValido(req.params.id) && await trx('cipa_membros').where({ id: Number(req.params.id) }).forUpdate().first();
      if (!x) throw new ErroDeNegocio(404, 'Membro não encontrado');
      const mandato = await mandatoNoEscopo(trx, req, x.mandato_id).catch(() => { throw new ErroDeNegocio(404, 'Membro não encontrado'); });
      if (x.fim) throw new ErroDeNegocio(409, 'Saída já registrada');
      const fim = (req.body && req.body.fim) ? lerData(req.body.fim, 'fim', { futura: false }) : hoje();
      if (fim < x.inicio) throw new ErroDeNegocio(400, 'Saída antes da posse');
      const [d] = await trx('cipa_membros').where({ id: x.id }).update({ fim, motivo_saida: motivo }).returning('*');
      await auditar(trx, req, { acao: 'saida_membro_cipa', tabela: 'cipa_membros', registro_id: x.id, filial_id: mandato.filial_id, antes: x, depois: d });
      return mandato;
    });
    return res.json(await carregar(knex, m));
  },

  // POST /cipa/mandatos/:id/eleicao { edital_em, inscricoes_inicio, inscricoes_fim, data_eleicao } — gestão
  async criarEleicao(req, res) {
    const b = req.body || {};
    const datas = {
      edital_em: lerData(b.edital_em, 'edital_em'), inscricoes_inicio: lerData(b.inscricoes_inicio, 'inscricoes_inicio'),
      inscricoes_fim: lerData(b.inscricoes_fim, 'inscricoes_fim'), data_eleicao: lerData(b.data_eleicao, 'data_eleicao')
    };
    if (datas.inscricoes_fim < datas.inscricoes_inicio) throw new ErroDeNegocio(400, 'Fim das inscrições antes do início');
    const r = await knex.transaction(async (trx) => {
      const mandato = await mandatoNoEscopo(trx, req, req.params.id, { travar: true });
      if (mandato.tipo !== 'cipa') throw new ErroDeNegocio(409, 'Designado não tem eleição');
      if (await trx('cipa_eleicoes').where({ mandato_id: mandato.id }).first('id')) throw new ErroDeNegocio(409, 'Este mandato já tem eleição registrada');
      if (datas.data_eleicao >= mandato.inicio) throw new ErroDeNegocio(400, 'A eleição precisa acontecer antes do início do mandato');
      const alertas = C.conferirPrazosEleicao({ inicio: mandato.inicio, ...datas });
      const [e] = await trx('cipa_eleicoes').insert({ mandato_id: mandato.id, ...datas, alertas: JSON.stringify(alertas), criado_por: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'criar_eleicao_cipa', tabela: 'cipa_eleicoes', registro_id: e.id, filial_id: mandato.filial_id, depois: e });
      return { mandato, alertas };
    });
    return res.status(201).json({ alertas: r.alertas, mandato: await carregar(knex, r.mandato) });
  },

  // POST /cipa/eleicoes/:id/candidatos { funcionario_id, inscrito_em? } — a estabilidade começa na inscrição
  async inscreverCandidato(req, res) {
    const b = req.body || {};
    const r = await knex.transaction(async (trx) => {
      const { eleicao, mandato } = await eleicaoNoEscopo(trx, req, req.params.id);
      if (eleicao.resultado === 'apurada') throw new ErroDeNegocio(409, 'Eleição já apurada');
      const inscrito = b.inscrito_em ? lerData(b.inscrito_em, 'inscrito_em', { futura: false }) : hoje();
      if (inscrito < eleicao.inscricoes_inicio || inscrito > eleicao.inscricoes_fim) throw new ErroDeNegocio(409, 'Fora do período de inscrição');
      const f = await funcionarioDoMandato(trx, req, mandato, b.funcionario_id);
      await exigirLimiteReeleicao(trx, mandato, f.id);
      if (await trx('cipa_candidatos').where({ eleicao_id: eleicao.id, funcionario_id: f.id }).first('id')) throw new ErroDeNegocio(409, `${f.nome} já é candidato`);
      const [c] = await trx('cipa_candidatos').insert({ eleicao_id: eleicao.id, funcionario_id: f.id, inscrito_em: inscrito, registrado_por: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'inscrever_candidato_cipa', tabela: 'cipa_candidatos', registro_id: c.id, filial_id: mandato.filial_id, depois: c });
      return mandato;
    });
    return res.status(201).json(await carregar(knex, r));
  },

  // POST /cipa/eleicoes/:id/apuracao { total_empregados, votantes, votos: [{ candidato_id, votos }], ata? } — gestão
  // Sem 50% de participação: não apura (nova votação). Apurada: os mais votados viram titulares e suplentes; empate = mais tempo de casa.
  async apurar(req, res) {
    const b = req.body || {};
    const total = Number(b.total_empregados);
    const votantes = Number(b.votantes);
    if (!Number.isInteger(total) || total < 1 || !Number.isInteger(votantes) || votantes < 0 || votantes > total) throw new ErroDeNegocio(400, 'total_empregados e votantes inválidos');
    const r = await knex.transaction(async (trx) => {
      const { eleicao, mandato } = await eleicaoNoEscopo(trx, req, req.params.id);
      await trx('cipa_mandatos').where({ id: mandato.id }).forUpdate().first('id');
      if (eleicao.resultado === 'apurada') throw new ErroDeNegocio(409, 'Eleição já apurada');
      if (hoje() < eleicao.data_eleicao) throw new ErroDeNegocio(409, 'A eleição ainda não aconteceu');
      const ata = b.ata ? await salvarArquivo(trx, req, { base64: b.ata, contexto: 'ata_eleicao_cipa', tipos: ['application/pdf', 'image/jpeg', 'image/png'], maxBytes: 10 * 1024 * 1024, filial_id: mandato.filial_id }) : null;
      if (votantes / total < C.PRAZOS.quorum) {
        await trx('cipa_eleicoes').where({ id: eleicao.id }).update({ total_empregados: total, votantes, resultado: 'sem_quorum', ata_arquivo_id: ata ? ata.id : null, updated_at: trx.fn.now() });
        await auditar(trx, req, { acao: 'apurar_eleicao_cipa', tabela: 'cipa_eleicoes', registro_id: eleicao.id, filial_id: mandato.filial_id, depois: { total, votantes, resultado: 'sem_quorum' } });
        return { mandato, resultado: 'sem_quorum', eleitos: [] };
      }
      const candidatos = await trx('cipa_candidatos as c').join('funcionarios as f', 'f.id', 'c.funcionario_id').where('c.eleicao_id', eleicao.id)
        .select('c.id', 'c.funcionario_id', 'f.nome', 'f.data_admissao', 'f.status');
      if (!Array.isArray(b.votos) || b.votos.length !== candidatos.length) throw new ErroDeNegocio(400, 'Informe os votos de cada candidato');
      const votos = new Map();
      for (const v of b.votos) {
        const n = Number(v && v.votos);
        if (!candidatos.some((c) => c.id === Number(v.candidato_id)) || !Number.isInteger(n) || n < 0) throw new ErroDeNegocio(400, 'Voto inválido');
        votos.set(Number(v.candidato_id), n);
      }
      if ([...votos.values()].reduce((t, n) => t + n, 0) > votantes) throw new ErroDeNegocio(400, 'Mais votos do que votantes');
      for (const c of candidatos) await trx('cipa_votos').insert({ candidato_id: c.id, votos: votos.get(c.id) });
      const ordem = candidatos.filter((c) => votos.get(c.id) > 0 && c.status === 'Ativo')
        .sort((a, b2) => votos.get(b2.id) - votos.get(a.id) || String(a.data_admissao).localeCompare(String(b2.data_admissao)));
      const eleitos = [];
      ordem.forEach((c, i) => {
        if (i < mandato.efetivos_exigidos) eleitos.push({ ...c, condicao: 'titular' });
        else if (i < mandato.efetivos_exigidos + mandato.suplentes_exigidos) eleitos.push({ ...c, condicao: 'suplente' });
      });
      for (const e of eleitos) {
        await trx('cipa_membros').insert({ mandato_id: mandato.id, funcionario_id: e.funcionario_id, representacao: 'empregados', condicao: e.condicao,
          votos: votos.get(e.id), inicio: mandato.inicio, registrado_por: req.usuario.id });
      }
      await trx('cipa_eleicoes').where({ id: eleicao.id }).update({ total_empregados: total, votantes, resultado: 'apurada', ata_arquivo_id: ata ? ata.id : null, updated_at: trx.fn.now() });
      await auditar(trx, req, { acao: 'apurar_eleicao_cipa', tabela: 'cipa_eleicoes', registro_id: eleicao.id, filial_id: mandato.filial_id,
        depois: { total, votantes, resultado: 'apurada', eleitos: eleitos.map((e) => ({ funcionario_id: e.funcionario_id, condicao: e.condicao, votos: votos.get(e.id) })) } });
      return { mandato, resultado: 'apurada', eleitos: eleitos.map((e) => ({ funcionario: e.nome, condicao: e.condicao, votos: votos.get(e.id) })) };
    });
    return res.json({ resultado: r.resultado, eleitos: r.eleitos, mandato: await carregar(knex, r.mandato) });
  },

  // POST /cipa/mandatos/:id/reunioes { tipo, data, pauta, ata, presentes: [ids de membros], arquivo? }
  async registrarReuniao(req, res) {
    const b = req.body || {};
    if (!['ordinaria', 'extraordinaria'].includes(b.tipo)) throw new ErroDeNegocio(400, 'tipo deve ser ordinaria ou extraordinaria');
    const data = lerData(b.data, 'data', { futura: false });
    const pauta = texto(b.pauta, 5000);
    const ata = texto(b.ata, 20000);
    if (!pauta || !ata) throw new ErroDeNegocio(400, 'Informe a pauta e a ata da reunião');
    if (!Array.isArray(b.presentes) || !b.presentes.length || !b.presentes.every(idValido)) throw new ErroDeNegocio(400, 'presentes: lista dos membros presentes');
    const m = await knex.transaction(async (trx) => {
      const mandato = await mandatoNoEscopo(trx, req, req.params.id);
      if (mandato.tipo !== 'cipa') throw new ErroDeNegocio(409, 'Designado não tem reunião de CIPA');
      if (data < mandato.inicio || data > mandato.fim) throw new ErroDeNegocio(400, 'Data fora do mandato');
      const membros = await trx('cipa_membros').where({ mandato_id: mandato.id }).where('inicio', '<=', data).andWhere((w) => w.whereNull('fim').orWhere('fim', '>', data)).pluck('id');
      const presentes = [...new Set(b.presentes.map(Number))];
      if (!presentes.every((p) => membros.includes(p))) throw new ErroDeNegocio(400, 'Há presente que não era membro na data');
      const arq = b.arquivo ? await salvarArquivo(trx, req, { base64: b.arquivo, contexto: 'ata_reuniao_cipa', tipos: ['application/pdf', 'image/jpeg', 'image/png'], maxBytes: 10 * 1024 * 1024, filial_id: mandato.filial_id }) : null;
      const [r] = await trx('cipa_reunioes').insert({ mandato_id: mandato.id, tipo: b.tipo, data, pauta, ata, presentes: JSON.stringify(presentes),
        arquivo_id: arq ? arq.id : null, registrado_por: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'reuniao_cipa', tabela: 'cipa_reunioes', registro_id: r.id, filial_id: mandato.filial_id, depois: { ...r, sha256: arq && arq.sha256 } });
      return mandato;
    });
    return res.status(201).json(await carregar(knex, m));
  },

  // POST /cipa-reunioes/:id/anular { motivo } — gestão
  async anularReuniao(req, res) {
    const motivo = texto(req.body && req.body.motivo, 2000);
    if (!motivo || motivo.length < 5) throw new ErroDeNegocio(400, 'Informe o motivo');
    const a = await knex.transaction(async (trx) => {
      const r = idValido(req.params.id) && await trx('cipa_reunioes').where({ id: Number(req.params.id) }).first();
      if (!r) throw new ErroDeNegocio(404, 'Reunião não encontrada');
      const mandato = await mandatoNoEscopo(trx, req, r.mandato_id).catch(() => { throw new ErroDeNegocio(404, 'Reunião não encontrada'); });
      if (await trx('cipa_reuniao_anulacoes').where({ reuniao_id: r.id }).first('id')) throw new ErroDeNegocio(409, 'Reunião já anulada');
      const [an] = await trx('cipa_reuniao_anulacoes').insert({ reuniao_id: r.id, motivo, usuario_id: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'anular_reuniao_cipa', tabela: 'cipa_reunioes', registro_id: r.id, filial_id: mandato.filial_id, antes: r, depois: an });
      return an;
    });
    return res.status(201).json(a);
  },

  // GET /cipa/pendencias?filial_id=&situacao=&todas=true&data_base=
  async pendencias(req, res) {
    const { dataBase } = lerDataBase(req.query);
    const itens = await C.situacaoCipa(knex, req, req.query, { dataBase });
    return res.json({ data_base: dataBase || hoje(), ...filtrarPendencias(itens, C.SITUACOES, req.query) });
  },

  // GET /cipa/estabilidades?filial_id= — quem tem estabilidade provisória hoje (não pode ser desligado sem justa causa)
  async estabilidades(req, res) {
    const q = noEscopo(knex('funcionarios'), req, 'filial_id').where('status', 'Ativo')
      .whereIn('id', knex('cipa_candidatos').select('funcionario_id').union(knex('cipa_membros').where('representacao', 'empregados').select('funcionario_id')))
      .orderBy('nome').select('id', 'nome', 'matricula', 'filial_id');
    if (req.query.filial_id) q.where('filial_id', req.query.filial_id);
    const lista = [];
    for (const f of await q) {
      const e = await C.estabilidade(knex, f.id);
      if (e.estavel) lista.push({ funcionario_id: f.id, funcionario: f.nome, matricula: f.matricula, filial_id: f.filial_id, ate: e.ate, motivo: e.motivo });
    }
    return res.json(lista);
  }
};
