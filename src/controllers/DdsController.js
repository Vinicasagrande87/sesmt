// DDS: banco de temas, registro, presença pelo crachá (QR + PIN) ou manual (gestão), encerramento com resumo,
// cancelamento, lista de presença em PDF, metas de frequência, pendências e indicadores do mês.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { ehAdmin, podeAcessarFilial, noEscopo } = require('../utils/escopo');
const { hoje, dataValida, somarDias } = require('../utils/datas');
const { idValido } = require('../utils/validacao');
const { gerarCodigo } = require('../utils/codigo');
const { conferirPin } = require('../services/pin');
const { lerDataBase, filtrarPendencias } = require('../services/historico');
const { buscarNoEscopo } = require('./FuncionarioController');
const { gerarListaDds } = require('../relatorios/listaDds');
const D = require('../services/dds');

function texto(valor, max = 2000) {
  if (valor === undefined || valor === null) return null;
  const t = String(valor).trim();
  if (t.length > max) throw new ErroDeNegocio(400, `Texto muito longo (máximo ${max} caracteres)`);
  return t.length ? t : null;
}

async function ddsNoEscopo(db, req, id, { travar = false } = {}) {
  if (!idValido(id)) throw new ErroDeNegocio(404, 'DDS não encontrado');
  const q = db('dds').where({ id: Number(id) });
  if (travar) q.forUpdate();
  const d = await q.first();
  if (!d || !podeAcessarFilial(req, d.filial_id)) throw new ErroDeNegocio(404, 'DDS não encontrado');
  return d;
}

function exigirAberto(d) {
  if (d.status !== 'aberto') throw new ErroDeNegocio(409, `DDS ${d.status}`);
}

async function carregar(db, d) {
  const presencas = await db('dds_presencas as p').join('funcionarios as f', 'f.id', 'p.funcionario_id').leftJoin('setores as s', 's.id', 'p.setor_id')
    .leftJoin('dds_presenca_anulacoes as n', 'n.presenca_id', 'p.id').where('p.dds_id', d.id).orderBy('p.assinado_em')
    .select('p.id', 'p.funcionario_id', 'f.nome', 'f.matricula', 's.nome as setor', 'p.assinado_em', 'p.metodo', 'p.codigo_verificacao', 'p.observacao',
      db.raw('(n.id is not null) as anulada'));
  const filial = await db('filiais').where({ id: d.filial_id }).first('nome', 'razao_social', 'cnpj');
  const setor = d.setor_id ? await db('setores').where({ id: d.setor_id }).first('nome') : null;
  const condutor = d.condutor_id ? await db('usuarios').where({ id: d.condutor_id }).first('nome') : null;
  return { ...d, numero: D.numero(d), filial: filial.nome, filial_dados: filial, setor: setor ? setor.nome : null,
    condutor: condutor ? condutor.nome : d.condutor_nome, presentes: presencas.filter((p) => !p.anulada).length, presencas };
}

async function registrarPresenca(trx, req, d, funcionario, { metodo, pinValidado, observacao = null }) {
  if (funcionario.status !== 'Ativo') throw new ErroDeNegocio(409, `${funcionario.nome} está com status ${funcionario.status}`);
  if (funcionario.filial_id !== d.filial_id) throw new ErroDeNegocio(409, `${funcionario.nome} não é empregado desta filial`);
  const ja = await trx('dds_presencas as p').leftJoin('dds_presenca_anulacoes as n', 'n.presenca_id', 'p.id')
    .where({ 'p.dds_id': d.id, 'p.funcionario_id': funcionario.id }).first('p.id', 'n.id as anulada');
  if (ja && !ja.anulada) throw new ErroDeNegocio(409, `${funcionario.nome} já assinou este DDS`);
  if (ja) throw new ErroDeNegocio(409, 'Presença anulada neste DDS: registre num novo DDS');
  const [p] = await trx('dds_presencas').insert({
    dds_id: d.id, funcionario_id: funcionario.id, setor_id: funcionario.setor_id, metodo, pin_validado: pinValidado, observacao,
    codigo_verificacao: gerarCodigo(), usuario_id: req.usuario.id, ip: req.ip || null, user_agent: String(req.headers['user-agent'] || '').slice(0, 300)
  }).returning('*');
  await auditar(trx, req, { acao: metodo === 'qr_pin' ? 'presenca_dds' : 'presenca_dds_manual', tabela: 'dds_presencas', registro_id: p.id, filial_id: d.filial_id, depois: p });
  return { id: p.id, funcionario: funcionario.nome, matricula: funcionario.matricula, assinado_em: p.assinado_em, codigo_verificacao: p.codigo_verificacao };
}

module.exports = {
  // GET /dds/temas?todos=true
  async temas(req, res) {
    const q = knex('dds_temas').orderBy('titulo');
    if (req.query.todos !== 'true') q.where('ativo', true);
    return res.json(await q);
  },

  // POST /dds/temas { titulo, conteudo?, nr_referencia? }
  async criarTema(req, res) {
    const b = req.body || {};
    const titulo = texto(b.titulo, 200);
    if (!titulo) throw new ErroDeNegocio(400, 'titulo é obrigatório');
    const novo = await knex.transaction(async (trx) => {
      if (await trx('dds_temas').whereRaw('lower(titulo) = lower(?)', [titulo]).first('id')) throw new ErroDeNegocio(409, 'Já existe um tema com este título');
      const [t] = await trx('dds_temas').insert({ titulo, conteudo: texto(b.conteudo, 10000), nr_referencia: texto(b.nr_referencia, 20), criado_por: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'criar_tema_dds', tabela: 'dds_temas', registro_id: t.id, depois: t });
      return t;
    });
    return res.status(201).json(novo);
  },

  // PUT /dds/temas/:id { titulo?, conteudo?, nr_referencia?, ativo? }
  async alterarTema(req, res) {
    const b = req.body || {};
    const depois = await knex.transaction(async (trx) => {
      const t = idValido(req.params.id) && await trx('dds_temas').where({ id: Number(req.params.id) }).first();
      if (!t) throw new ErroDeNegocio(404, 'Tema não encontrado');
      const d = {};
      if (b.titulo !== undefined) { d.titulo = texto(b.titulo, 200); if (!d.titulo) throw new ErroDeNegocio(400, 'titulo não pode ser vazio'); }
      if (b.conteudo !== undefined) d.conteudo = texto(b.conteudo, 10000);
      if (b.nr_referencia !== undefined) d.nr_referencia = texto(b.nr_referencia, 20);
      if (b.ativo !== undefined) { if (typeof b.ativo !== 'boolean') throw new ErroDeNegocio(400, 'ativo deve ser true ou false'); d.ativo = b.ativo; }
      if (!Object.keys(d).length) throw new ErroDeNegocio(400, 'Nada para alterar');
      const [novo] = await trx('dds_temas').where({ id: t.id }).update({ ...d, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'alterar_tema_dds', tabela: 'dds_temas', registro_id: t.id, antes: t, depois: novo });
      return novo;
    });
    return res.json(depois);
  },

  // GET /dds?filial_id=&setor_id=&hoje=true&de=&ate=
  async index(req, res) {
    const q = noEscopo(knex('dds as d'), req, 'd.filial_id').join('filiais as f', 'f.id', 'd.filial_id').leftJoin('setores as s', 's.id', 'd.setor_id')
      .leftJoin('usuarios as u', 'u.id', 'd.condutor_id').orderBy([{ column: 'd.data', order: 'desc' }, { column: 'd.id', order: 'desc' }]).limit(500)
      .select('d.id', 'd.filial_id', 'f.nome as filial', 'd.ano', 'd.sequencial', 'd.data', 'd.setor_id', 's.nome as setor', 'd.local', 'd.tema', 'd.status',
        knex.raw('coalesce(u.nome, d.condutor_nome) as condutor'),
        knex.raw('(select count(*)::int from dds_presencas p left join dds_presenca_anulacoes n on n.presenca_id = p.id where p.dds_id = d.id and n.id is null) as presentes'));
    if (req.query.filial_id) q.where('d.filial_id', req.query.filial_id);
    if (req.query.setor_id) q.where('d.setor_id', req.query.setor_id);
    if (req.query.hoje === 'true') q.where('d.data', hoje()).where('d.status', 'aberto');
    if (req.query.de && dataValida(req.query.de)) q.where('d.data', '>=', req.query.de);
    if (req.query.ate && dataValida(req.query.ate)) q.where('d.data', '<=', req.query.ate);
    return res.json((await q).map((d) => ({ ...d, numero: D.numero(d) })));
  },

  async show(req, res) {
    return res.json(await carregar(knex, await ddsNoEscopo(knex, req, req.params.id)));
  },

  // POST /dds { filial_id, tema_id? | tema, data?, setor_id?, local?, condutor_nome?, duracao_min? }
  async create(req, res) {
    const b = req.body || {};
    if (!idValido(b.filial_id) || !podeAcessarFilial(req, b.filial_id)) throw new ErroDeNegocio(404, 'Filial não encontrada');
    const data = b.data || hoje();
    if (!dataValida(data) || data > hoje()) throw new ErroDeNegocio(400, 'data inválida ou futura');
    if (data < somarDias(hoje(), -30)) throw new ErroDeNegocio(400, 'DDS de mais de 30 dias atrás não pode ser lançado');
    let duracao = null;
    if (b.duracao_min !== undefined && b.duracao_min !== null) {
      duracao = Number(b.duracao_min);
      if (!Number.isInteger(duracao) || duracao < 1 || duracao > 240) throw new ErroDeNegocio(400, 'duracao_min entre 1 e 240');
    }
    const novo = await knex.transaction(async (trx) => {
      const filial = await trx('filiais').where({ id: Number(b.filial_id) }).forUpdate().first('id');
      let tema = texto(b.tema, 200);
      let temaId = null;
      if (b.tema_id !== undefined && b.tema_id !== null) {
        const t = idValido(b.tema_id) && await trx('dds_temas').where({ id: Number(b.tema_id), ativo: true }).first();
        if (!t) throw new ErroDeNegocio(400, 'Tema não encontrado no banco de temas');
        temaId = t.id;
        tema = tema || t.titulo;
      }
      if (!tema) throw new ErroDeNegocio(400, 'Informe o tema (tema_id do banco de temas ou o texto)');
      if (b.setor_id !== undefined && b.setor_id !== null) {
        const s = idValido(b.setor_id) && await trx('setores').where({ id: Number(b.setor_id) }).first('filial_id');
        if (!s || s.filial_id !== filial.id) throw new ErroDeNegocio(400, 'Setor não pertence à filial');
      }
      const ano = Number(data.slice(0, 4));
      const { max } = await trx('dds').where({ filial_id: filial.id, ano }).max({ max: 'sequencial' }).first();
      const condutorNome = texto(b.condutor_nome, 200);
      const [d] = await trx('dds').insert({
        filial_id: filial.id, ano, sequencial: (max || 0) + 1, data, setor_id: b.setor_id || null, local: texto(b.local, 200), tema_id: temaId, tema,
        duracao_min: duracao, condutor_id: condutorNome ? null : req.usuario.id, condutor_nome: condutorNome, criado_por: req.usuario.id
      }).returning('*');
      await auditar(trx, req, { acao: 'criar_dds', tabela: 'dds', registro_id: d.id, filial_id: d.filial_id, depois: d });
      return d;
    });
    return res.status(201).json(await carregar(knex, novo));
  },

  // POST /dds/:id/presencas { token, pin } — no dia do DDS
  async presencaQr(req, res) {
    const { token, pin } = req.body || {};
    if (!token) throw new ErroDeNegocio(400, 'token é obrigatório');
    const previo = await ddsNoEscopo(knex, req, req.params.id);
    exigirAberto(previo);
    if (previo.data !== hoje()) throw new ErroDeNegocio(409, 'A assinatura pelo crachá só no dia do DDS; depois, só a gestão lança (lista em papel)');
    const funcionario = await knex('funcionarios').where({ qr_token: String(token) }).first();
    const visivel = funcionario && (funcionario.filial_id ? podeAcessarFilial(req, funcionario.filial_id) : ehAdmin(req));
    if (!visivel) throw new ErroDeNegocio(404, 'QR code não reconhecido');
    await conferirPin(funcionario.id, pin);
    const r = await knex.transaction(async (trx) => {
      const d = await ddsNoEscopo(trx, req, previo.id, { travar: true });
      exigirAberto(d);
      return registrarPresenca(trx, req, d, await trx('funcionarios').where({ id: funcionario.id }).first(), { metodo: 'qr_pin', pinValidado: true });
    });
    return res.status(201).json(r);
  },

  // POST /dds/:id/presencas/manual { funcionario_id, observacao } — gestão (lista assinada em papel)
  async presencaManual(req, res) {
    const observacao = texto(req.body && req.body.observacao, 2000);
    if (!observacao || observacao.length < 10) throw new ErroDeNegocio(400, 'Presença sem crachá exige justificativa (pelo menos 10 caracteres)');
    const r = await knex.transaction(async (trx) => {
      const d = await ddsNoEscopo(trx, req, req.params.id, { travar: true });
      exigirAberto(d);
      const f = await buscarNoEscopo(req, req.body.funcionario_id, trx);
      return registrarPresenca(trx, req, d, f, { metodo: 'manual', pinValidado: false, observacao });
    });
    return res.status(201).json(r);
  },

  // POST /dds-presencas/:id/anular { motivo } — gestão, enquanto o DDS está aberto
  async anularPresenca(req, res) {
    const motivo = texto(req.body && req.body.motivo, 2000);
    if (!motivo || motivo.length < 5) throw new ErroDeNegocio(400, 'Informe o motivo');
    const a = await knex.transaction(async (trx) => {
      const p = idValido(req.params.id) && await trx('dds_presencas').where({ id: Number(req.params.id) }).first();
      if (!p) throw new ErroDeNegocio(404, 'Presença não encontrada');
      const d = await ddsNoEscopo(trx, req, p.dds_id, { travar: true }).catch(() => { throw new ErroDeNegocio(404, 'Presença não encontrada'); });
      exigirAberto(d);
      if (await trx('dds_presenca_anulacoes').where({ presenca_id: p.id }).first('id')) throw new ErroDeNegocio(409, 'Presença já anulada');
      const [an] = await trx('dds_presenca_anulacoes').insert({ presenca_id: p.id, motivo, usuario_id: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'anular_presenca_dds', tabela: 'dds_presencas', registro_id: p.id, filial_id: d.filial_id, antes: p, depois: an });
      return an;
    });
    return res.status(201).json(a);
  },

  // POST /dds/:id/encerrar { resumo, duracao_min? } — o que foi falado; depois não entra mais ninguém
  async encerrar(req, res) {
    const resumo = texto(req.body && req.body.resumo, 10000);
    if (!resumo || resumo.length < 10) throw new ErroDeNegocio(400, 'Escreva o resumo do que foi falado (pelo menos 10 caracteres)');
    const d = await knex.transaction(async (trx) => {
      const atual = await ddsNoEscopo(trx, req, req.params.id, { travar: true });
      exigirAberto(atual);
      const { n } = await trx('dds_presencas as p').leftJoin('dds_presenca_anulacoes as x', 'x.presenca_id', 'p.id').where('p.dds_id', atual.id).whereNull('x.id').count({ n: '*' }).first();
      if (!Number(n)) throw new ErroDeNegocio(409, 'Nenhuma presença registrada: cancele o DDS em vez de encerrar');
      const dados = { status: 'encerrado', resumo, encerrado_em: trx.fn.now(), updated_at: trx.fn.now() };
      if (req.body.duracao_min !== undefined) {
        const m = Number(req.body.duracao_min);
        if (!Number.isInteger(m) || m < 1 || m > 240) throw new ErroDeNegocio(400, 'duracao_min entre 1 e 240');
        dados.duracao_min = m;
      }
      const [depois] = await trx('dds').where({ id: atual.id }).update(dados).returning('*');
      await auditar(trx, req, { acao: 'encerrar_dds', tabela: 'dds', registro_id: atual.id, filial_id: atual.filial_id, antes: atual, depois });
      return depois;
    });
    return res.json(await carregar(knex, d));
  },

  // POST /dds/:id/cancelar { motivo } — gestão (registrado por engano ou não aconteceu)
  async cancelar(req, res) {
    const motivo = texto(req.body && req.body.motivo, 2000);
    if (!motivo || motivo.length < 5) throw new ErroDeNegocio(400, 'Informe o motivo');
    const d = await knex.transaction(async (trx) => {
      const atual = await ddsNoEscopo(trx, req, req.params.id, { travar: true });
      exigirAberto(atual);
      const [depois] = await trx('dds').where({ id: atual.id }).update({ status: 'cancelado', motivo_cancelamento: motivo, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'cancelar_dds', tabela: 'dds', registro_id: atual.id, filial_id: atual.filial_id, antes: atual, depois });
      return depois;
    });
    return res.json(await carregar(knex, d));
  },

  // GET /dds/:id/pdf — lista de presença do DDS
  async pdf(req, res) {
    const d = await carregar(knex, await ddsNoEscopo(knex, req, req.params.id));
    const doc = gerarListaDds({ dds: d, emitidoPor: req.usuario.nome, urlVerificacao: `${req.protocol}://${req.get('host')}/verificar/` });
    res.type('application/pdf');
    res.set('Content-Disposition', `inline; filename="dds-${d.numero.replace('/', '-')}.pdf"`);
    doc.pipe(res);
  },

  // GET /dds/metas?filial_id=
  async metas(req, res) {
    const q = noEscopo(knex('dds_metas as m'), req, 'm.filial_id').join('filiais as f', 'f.id', 'm.filial_id').leftJoin('setores as s', 's.id', 'm.setor_id')
      .orderBy(['f.nome', 's.nome']).select('m.*', 'f.nome as filial', 's.nome as setor');
    if (req.query.filial_id) q.where('m.filial_id', req.query.filial_id);
    return res.json(await q);
  },

  // PUT /dds/metas { filial_id, setor_id? (sem = filial inteira), frequencia, ativa? } — gestão
  async definirMeta(req, res) {
    const b = req.body || {};
    if (!idValido(b.filial_id) || !podeAcessarFilial(req, b.filial_id)) throw new ErroDeNegocio(404, 'Filial não encontrada');
    if (!D.FREQUENCIAS[b.frequencia]) throw new ErroDeNegocio(400, `frequencia deve ser: ${Object.keys(D.FREQUENCIAS).join(', ')}`);
    const setorId = b.setor_id === undefined || b.setor_id === null ? null : Number(b.setor_id);
    const ativa = b.ativa === undefined ? true : b.ativa;
    if (typeof ativa !== 'boolean') throw new ErroDeNegocio(400, 'ativa deve ser true ou false');
    const meta = await knex.transaction(async (trx) => {
      if (setorId !== null) {
        const s = idValido(setorId) && await trx('setores').where({ id: setorId }).first('filial_id');
        if (!s || s.filial_id !== Number(b.filial_id)) throw new ErroDeNegocio(400, 'Setor não pertence à filial');
      }
      const antes = await trx('dds_metas').where({ filial_id: Number(b.filial_id) }).modify((q) => (setorId === null ? q.whereNull('setor_id') : q.where('setor_id', setorId))).first();
      const [m] = antes
        ? await trx('dds_metas').where({ id: antes.id }).update({ frequencia: b.frequencia, ativa, definido_por: req.usuario.id, updated_at: trx.fn.now() }).returning('*')
        : await trx('dds_metas').insert({ filial_id: Number(b.filial_id), setor_id: setorId, frequencia: b.frequencia, ativa, definido_por: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'meta_dds', tabela: 'dds_metas', registro_id: m.id, filial_id: m.filial_id, antes, depois: m });
      return m;
    });
    return res.json(meta);
  },

  // GET /dds/pendencias?filial_id=&situacao=&todas=true&data_base=
  async pendencias(req, res) {
    const { dataBase } = lerDataBase(req.query);
    const itens = await D.situacaoDds(knex, req, req.query, { dataBase });
    return res.json({ data_base: dataBase || hoje(), ...filtrarPendencias(itens, D.SITUACOES, req.query) });
  },

  // GET /dds/indicadores?mes=AAAA-MM&filial_id=&detalhar=true
  async indicadores(req, res) {
    const mes = req.query.mes || hoje().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes) || mes > hoje().slice(0, 7)) throw new ErroDeNegocio(400, 'mes no formato AAAA-MM (até o mês atual)');
    if (req.query.filial_id !== undefined && (!idValido(req.query.filial_id) || !podeAcessarFilial(req, req.query.filial_id))) throw new ErroDeNegocio(404, 'Filial não encontrada');
    return res.json(await D.indicadores(knex, req, { filialId: req.query.filial_id ? Number(req.query.filial_id) : null, mes, detalhar: req.query.detalhar === 'true' }));
  }
};
