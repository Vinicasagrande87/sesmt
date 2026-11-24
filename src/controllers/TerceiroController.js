// Terceirizadas: empresas (únicas no grupo, pelo CNPJ), contratos por filial, trabalhadores, alocações,
// documentos (só inclusão; corrige-se anulando), pendências e consulta de acesso pelo CPF (portaria).
// LGPD: o arquivo do ASO do terceirizado só para saude/admin; CPF mascarado para o perfil consulta.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { ehAdmin, podeAcessarFilial } = require('../utils/escopo');
const { hoje, dataValida, somarMeses } = require('../utils/datas');
const { idValido, somenteDigitos, cpfValido, cnpjValido } = require('../utils/validacao');
const { salvarArquivo } = require('../utils/arquivos');
const { cpfMascarado } = require('../relatorios/formatos');
const { lerDataBase, lerDias, filtrarPendencias } = require('../services/historico');
const T = require('../services/terceiros');

const TIPOS_ARQUIVO = ['application/pdf', 'image/jpeg', 'image/png'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function texto(valor, max = 2000) {
  if (valor === undefined || valor === null) return null;
  const t = String(valor).trim();
  if (t.length > max) throw new ErroDeNegocio(400, `Texto muito longo (máximo ${max} caracteres)`);
  return t.length ? t : null;
}
const cpfParaQuem = (req, cpf) => (req.usuario.perfil === 'consulta' ? cpfMascarado(cpf) : cpf);

// A empresa é visível para quem tem contrato com ela numa das suas filiais (ou para quem a cadastrou)
async function empresaNoEscopo(db, req, id) {
  if (!idValido(id)) throw new ErroDeNegocio(404, 'Empresa não encontrada');
  const e = await db('empresas_terceiras').where({ id: Number(id) }).first();
  if (!e) throw new ErroDeNegocio(404, 'Empresa não encontrada');
  if (ehAdmin(req) || e.criado_por === req.usuario.id) return e;
  const contrato = await db('terceiro_contratos').where({ empresa_id: e.id }).whereIn('filial_id', req.usuario.filiais).first('id');
  if (!contrato) throw new ErroDeNegocio(404, 'Empresa não encontrada');
  return e;
}

async function contratoNoEscopo(db, req, id, { travar = false } = {}) {
  if (!idValido(id)) throw new ErroDeNegocio(404, 'Contrato não encontrado');
  const q = db('terceiro_contratos').where({ id: Number(id) });
  if (travar) q.forUpdate();
  const c = await q.first();
  if (!c || !podeAcessarFilial(req, c.filial_id)) throw new ErroDeNegocio(404, 'Contrato não encontrado');
  return c;
}

async function trabalhadorNoEscopo(db, req, id) {
  if (!idValido(id)) throw new ErroDeNegocio(404, 'Trabalhador não encontrado');
  const t = await db('terceiro_trabalhadores').where({ id: Number(id) }).first();
  if (!t) throw new ErroDeNegocio(404, 'Trabalhador não encontrado');
  await empresaNoEscopo(db, req, t.empresa_id).catch(() => { throw new ErroDeNegocio(404, 'Trabalhador não encontrado'); });
  return t;
}

async function validarTreinamentos(db, lista) {
  if (lista === undefined) return undefined;
  if (!Array.isArray(lista) || !lista.every(idValido)) throw new ErroDeNegocio(400, 'treinamentos_exigidos: lista de ids do catálogo');
  const ids = [...new Set(lista.map(Number))];
  if (ids.length && (await db('treinamentos').whereIn('id', ids).pluck('id')).length !== ids.length) throw new ErroDeNegocio(400, 'Algum treinamento não existe no catálogo');
  return ids;
}

function lerData(valor, nome, { obrigatoria = true, futura = false } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (obrigatoria) throw new ErroDeNegocio(400, `${nome} é obrigatória`);
    return null;
  }
  if (!dataValida(valor)) throw new ErroDeNegocio(400, `${nome} no formato AAAA-MM-DD`);
  if (!futura && valor > hoje()) throw new ErroDeNegocio(400, `${nome} não pode ser futura`);
  return valor;
}

module.exports = {
  // GET /terceiros/empresas?cnpj= — com cnpj, procura em todo o grupo (para não cadastrar duas vezes)
  async empresas(req, res) {
    if (req.query.cnpj) {
      const e = await knex('empresas_terceiras').where({ cnpj: somenteDigitos(req.query.cnpj) }).first('id', 'razao_social', 'nome_fantasia', 'cnpj', 'ativa');
      return res.json(e ? [e] : []);
    }
    const q = knex('empresas_terceiras as e').orderBy('e.razao_social').select('e.*');
    if (!ehAdmin(req)) {
      q.where((w) => w.where('e.criado_por', req.usuario.id)
        .orWhereExists(knex('terceiro_contratos as c').whereRaw('c.empresa_id = e.id').whereIn('c.filial_id', req.usuario.filiais)));
    }
    return res.json(await q);
  },

  // GET /terceiros/empresas/:id — contratos (das filiais do usuário), trabalhadores e documentos da empresa
  async empresa(req, res) {
    const e = await empresaNoEscopo(knex, req, req.params.id);
    const contratos = await knex('terceiro_contratos as c').join('filiais as f', 'f.id', 'c.filial_id').where('c.empresa_id', e.id)
      .modify((q) => { if (!ehAdmin(req)) q.whereIn('c.filial_id', req.usuario.filiais); }).orderBy('c.inicio', 'desc').select('c.*', 'f.nome as filial');
    const trabalhadores = await knex('terceiro_trabalhadores').where({ empresa_id: e.id }).orderBy('nome');
    const documentos = await knex('terceiro_documentos as d').leftJoin('terceiro_documento_anulacoes as n', 'n.documento_id', 'd.id')
      .where('d.empresa_id', e.id).orderBy('d.data_documento', 'desc')
      .select('d.id', 'd.trabalhador_id', 'd.tipo', 'd.descricao', 'd.treinamento_id', 'd.nr_referencia', 'd.resultado', 'd.data_documento', 'd.data_vencimento',
        'd.created_at', knex.raw('(n.id is not null) as anulado'));
    return res.json({ ...e, contratos, trabalhadores: trabalhadores.map((t) => ({ ...t, cpf: cpfParaQuem(req, t.cpf) })), documentos });
  },

  // POST /terceiros/empresas { razao_social, cnpj, nome_fantasia?, contato_nome?, contato_email?, contato_telefone? }
  async criarEmpresa(req, res) {
    const b = req.body || {};
    const cnpj = somenteDigitos(b.cnpj);
    if (!cnpjValido(cnpj)) throw new ErroDeNegocio(400, 'CNPJ inválido');
    const razao = texto(b.razao_social, 200);
    if (!razao) throw new ErroDeNegocio(400, 'razao_social é obrigatória');
    const email = texto(b.contato_email, 200);
    if (email && !EMAIL.test(email)) throw new ErroDeNegocio(400, 'contato_email inválido');
    const nova = await knex.transaction(async (trx) => {
      const existe = await trx('empresas_terceiras').where({ cnpj }).first('id');
      if (existe) throw new ErroDeNegocio(409, 'Empresa já cadastrada no grupo: use o cadastro existente', { empresa_id: existe.id });
      const [e] = await trx('empresas_terceiras').insert({ razao_social: razao, cnpj, nome_fantasia: texto(b.nome_fantasia, 200), contato_nome: texto(b.contato_nome, 200),
        contato_email: email && email.toLowerCase(), contato_telefone: texto(b.contato_telefone, 30), criado_por: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'cadastrar_terceira', tabela: 'empresas_terceiras', registro_id: e.id, depois: e });
      return e;
    });
    return res.status(201).json(nova);
  },

  // PUT /terceiros/empresas/:id { razao_social?, nome_fantasia?, contato_*?, ativa? }
  async alterarEmpresa(req, res) {
    const b = req.body || {};
    const depois = await knex.transaction(async (trx) => {
      const e = await empresaNoEscopo(trx, req, req.params.id);
      const d = {};
      for (const c of ['razao_social', 'nome_fantasia', 'contato_nome', 'contato_telefone']) if (b[c] !== undefined) d[c] = texto(b[c], 200);
      if (d.razao_social === null) throw new ErroDeNegocio(400, 'razao_social não pode ser vazia');
      if (b.contato_email !== undefined) {
        d.contato_email = texto(b.contato_email, 200);
        if (d.contato_email && !EMAIL.test(d.contato_email)) throw new ErroDeNegocio(400, 'contato_email inválido');
      }
      if (b.ativa !== undefined) { if (typeof b.ativa !== 'boolean') throw new ErroDeNegocio(400, 'ativa deve ser true ou false'); d.ativa = b.ativa; }
      if (!Object.keys(d).length) throw new ErroDeNegocio(400, 'Nada para alterar');
      const [novo] = await trx('empresas_terceiras').where({ id: e.id }).update({ ...d, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'alterar_terceira', tabela: 'empresas_terceiras', registro_id: e.id, antes: e, depois: novo });
      return novo;
    });
    return res.json(depois);
  },

  // GET /terceiros/contratos?filial_id=&empresa_id=&ativos=true
  async contratos(req, res) {
    const q = knex('terceiro_contratos as c').join('empresas_terceiras as e', 'e.id', 'c.empresa_id').join('filiais as f', 'f.id', 'c.filial_id')
      .orderBy('c.inicio', 'desc').select('c.*', 'e.razao_social as empresa', 'f.nome as filial',
        knex.raw('(select count(*)::int from terceiro_alocacoes a where a.contrato_id = c.id and (a.fim is null or a.fim >= ?)) as trabalhadores_alocados', [hoje()]));
    if (!ehAdmin(req)) q.whereIn('c.filial_id', req.usuario.filiais);
    if (req.query.filial_id) q.where('c.filial_id', req.query.filial_id);
    if (req.query.empresa_id) q.where('c.empresa_id', req.query.empresa_id);
    if (req.query.ativos === 'true') q.whereNull('c.encerrado_em').andWhere((w) => w.whereNull('c.fim').orWhere('c.fim', '>=', hoje()));
    return res.json(await q);
  },

  // POST /terceiros/contratos { empresa_id, filial_id, objeto, inicio, fim?, numero?, responsavel_id? | responsavel_nome?, treinamentos_exigidos? }
  async criarContrato(req, res) {
    const b = req.body || {};
    if (!idValido(b.filial_id) || !podeAcessarFilial(req, b.filial_id)) throw new ErroDeNegocio(404, 'Filial não encontrada');
    const objeto = texto(b.objeto, 2000);
    if (!objeto) throw new ErroDeNegocio(400, 'Descreva o objeto do contrato (o serviço)');
    const inicio = lerData(b.inicio, 'inicio', { futura: true });
    const fim = lerData(b.fim, 'fim', { obrigatoria: false, futura: true });
    if (fim && fim < inicio) throw new ErroDeNegocio(400, 'fim antes do início');
    const novo = await knex.transaction(async (trx) => {
      const e = idValido(b.empresa_id) && await trx('empresas_terceiras').where({ id: Number(b.empresa_id) }).first();
      if (!e) throw new ErroDeNegocio(400, 'Empresa não encontrada: cadastre a empresa (ou procure pelo CNPJ)');
      if (!e.ativa) throw new ErroDeNegocio(409, 'Empresa inativa');
      let responsavelId = null;
      if (b.responsavel_id !== undefined && b.responsavel_id !== null) {
        const u = idValido(b.responsavel_id) && await trx('usuarios').where({ id: Number(b.responsavel_id), ativo: true }).first('id');
        if (!u) throw new ErroDeNegocio(400, 'Responsável (fiscal do contrato) não encontrado');
        responsavelId = u.id;
      }
      const [c] = await trx('terceiro_contratos').insert({
        empresa_id: e.id, filial_id: Number(b.filial_id), numero: texto(b.numero, 40), objeto, inicio, fim,
        responsavel_id: responsavelId, responsavel_nome: responsavelId ? null : texto(b.responsavel_nome, 200),
        treinamentos_exigidos: JSON.stringify((await validarTreinamentos(trx, b.treinamentos_exigidos)) || []), criado_por: req.usuario.id
      }).returning('*');
      await auditar(trx, req, { acao: 'criar_contrato_terceiro', tabela: 'terceiro_contratos', registro_id: c.id, filial_id: c.filial_id, depois: c });
      return c;
    });
    return res.status(201).json(novo);
  },

  // PUT /terceiros/contratos/:id { objeto?, fim?, numero?, treinamentos_exigidos?, responsavel_nome? }
  async alterarContrato(req, res) {
    const b = req.body || {};
    const depois = await knex.transaction(async (trx) => {
      const c = await contratoNoEscopo(trx, req, req.params.id, { travar: true });
      if (c.encerrado_em) throw new ErroDeNegocio(409, 'Contrato encerrado');
      const d = {};
      if (b.objeto !== undefined) { d.objeto = texto(b.objeto, 2000); if (!d.objeto) throw new ErroDeNegocio(400, 'objeto não pode ser vazio'); }
      if (b.numero !== undefined) d.numero = texto(b.numero, 40);
      if (b.responsavel_nome !== undefined) d.responsavel_nome = texto(b.responsavel_nome, 200);
      if (b.fim !== undefined) {
        d.fim = lerData(b.fim, 'fim', { obrigatoria: false, futura: true });
        if (d.fim && d.fim < c.inicio) throw new ErroDeNegocio(400, 'fim antes do início');
      }
      const treinos = await validarTreinamentos(trx, b.treinamentos_exigidos);
      if (treinos) d.treinamentos_exigidos = JSON.stringify(treinos);
      if (!Object.keys(d).length) throw new ErroDeNegocio(400, 'Nada para alterar');
      const [novo] = await trx('terceiro_contratos').where({ id: c.id }).update({ ...d, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'alterar_contrato_terceiro', tabela: 'terceiro_contratos', registro_id: c.id, filial_id: c.filial_id, antes: c, depois: novo });
      return novo;
    });
    return res.json(depois);
  },

  // POST /terceiros/contratos/:id/encerrar { motivo } — gestão
  async encerrarContrato(req, res) {
    const motivo = texto(req.body && req.body.motivo, 2000);
    if (!motivo || motivo.length < 5) throw new ErroDeNegocio(400, 'Informe o motivo (pelo menos 5 caracteres)');
    const depois = await knex.transaction(async (trx) => {
      const c = await contratoNoEscopo(trx, req, req.params.id, { travar: true });
      if (c.encerrado_em) throw new ErroDeNegocio(409, 'Contrato já encerrado');
      const [novo] = await trx('terceiro_contratos').where({ id: c.id }).update({ encerrado_em: trx.fn.now(), motivo_encerramento: motivo, updated_at: trx.fn.now() }).returning('*');
      await trx('terceiro_alocacoes').where({ contrato_id: c.id }).whereNull('fim').update({ fim: hoje() });
      await auditar(trx, req, { acao: 'encerrar_contrato_terceiro', tabela: 'terceiro_contratos', registro_id: c.id, filial_id: c.filial_id, antes: c, depois: novo });
      return novo;
    });
    return res.json(depois);
  },

  // GET /terceiros/trabalhadores?empresa_id=
  async trabalhadores(req, res) {
    if (!req.query.empresa_id) throw new ErroDeNegocio(400, 'Informe empresa_id');
    const e = await empresaNoEscopo(knex, req, req.query.empresa_id);
    const lista = await knex('terceiro_trabalhadores').where({ empresa_id: e.id }).orderBy('nome');
    return res.json(lista.map((t) => ({ ...t, cpf: cpfParaQuem(req, t.cpf) })));
  },

  // POST /terceiros/trabalhadores { empresa_id, nome, cpf, funcao? }
  async criarTrabalhador(req, res) {
    const b = req.body || {};
    const cpf = somenteDigitos(b.cpf);
    if (!cpfValido(cpf)) throw new ErroDeNegocio(400, 'CPF inválido');
    const nome = texto(b.nome, 200);
    if (!nome) throw new ErroDeNegocio(400, 'nome é obrigatório');
    const novo = await knex.transaction(async (trx) => {
      const e = await empresaNoEscopo(trx, req, b.empresa_id);
      const existe = await trx('terceiro_trabalhadores').where({ cpf }).first('id', 'empresa_id');
      if (existe) throw new ErroDeNegocio(409, existe.empresa_id === e.id ? 'Trabalhador já cadastrado nesta empresa' : 'Este CPF já está cadastrado em outra empresa terceirizada');
      const [t] = await trx('terceiro_trabalhadores').insert({ empresa_id: e.id, nome, cpf, funcao: texto(b.funcao, 200), criado_por: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'cadastrar_terceirizado', tabela: 'terceiro_trabalhadores', registro_id: t.id, depois: t });
      return t;
    });
    return res.status(201).json(novo);
  },

  // PUT /terceiros/trabalhadores/:id { nome?, funcao?, ativo? }
  async alterarTrabalhador(req, res) {
    const b = req.body || {};
    const depois = await knex.transaction(async (trx) => {
      const t = await trabalhadorNoEscopo(trx, req, req.params.id);
      const d = {};
      if (b.nome !== undefined) { d.nome = texto(b.nome, 200); if (!d.nome) throw new ErroDeNegocio(400, 'nome não pode ser vazio'); }
      if (b.funcao !== undefined) d.funcao = texto(b.funcao, 200);
      if (b.ativo !== undefined) { if (typeof b.ativo !== 'boolean') throw new ErroDeNegocio(400, 'ativo deve ser true ou false'); d.ativo = b.ativo; }
      if (!Object.keys(d).length) throw new ErroDeNegocio(400, 'Nada para alterar');
      const [novo] = await trx('terceiro_trabalhadores').where({ id: t.id }).update({ ...d, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'alterar_terceirizado', tabela: 'terceiro_trabalhadores', registro_id: t.id, antes: t, depois: novo });
      return novo;
    });
    return res.json(depois);
  },

  // POST /terceiros/contratos/:id/alocacoes { trabalhador_id, inicio? } — quem trabalha neste contrato
  async alocar(req, res) {
    const b = req.body || {};
    const inicio = lerData(b.inicio || hoje(), 'inicio', { futura: true });
    const nova = await knex.transaction(async (trx) => {
      const c = await contratoNoEscopo(trx, req, req.params.id, { travar: true });
      if (c.encerrado_em) throw new ErroDeNegocio(409, 'Contrato encerrado');
      const t = await trabalhadorNoEscopo(trx, req, b.trabalhador_id);
      if (t.empresa_id !== c.empresa_id) throw new ErroDeNegocio(400, 'O trabalhador não é da empresa deste contrato');
      if (await trx('terceiro_alocacoes').where({ contrato_id: c.id, trabalhador_id: t.id }).whereNull('fim').first('id')) throw new ErroDeNegocio(409, 'Trabalhador já alocado neste contrato');
      const [a] = await trx('terceiro_alocacoes').insert({ contrato_id: c.id, trabalhador_id: t.id, inicio, registrado_por: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'alocar_terceirizado', tabela: 'terceiro_alocacoes', registro_id: a.id, filial_id: c.filial_id, depois: a });
      return a;
    });
    return res.status(201).json(nova);
  },

  // POST /terceiro-alocacoes/:id/encerrar { fim? } — saiu do contrato
  async desalocar(req, res) {
    const fim = lerData((req.body && req.body.fim) || hoje(), 'fim', { futura: true });
    const depois = await knex.transaction(async (trx) => {
      const a = idValido(req.params.id) && await trx('terceiro_alocacoes').where({ id: Number(req.params.id) }).forUpdate().first();
      if (!a) throw new ErroDeNegocio(404, 'Alocação não encontrada');
      const c = await contratoNoEscopo(trx, req, a.contrato_id).catch(() => { throw new ErroDeNegocio(404, 'Alocação não encontrada'); });
      if (a.fim) throw new ErroDeNegocio(409, 'Alocação já encerrada');
      if (fim < a.inicio) throw new ErroDeNegocio(400, 'fim antes do início da alocação');
      const [novo] = await trx('terceiro_alocacoes').where({ id: a.id }).update({ fim }).returning('*');
      await auditar(trx, req, { acao: 'desalocar_terceirizado', tabela: 'terceiro_alocacoes', registro_id: a.id, filial_id: c.filial_id, antes: a, depois: novo });
      return novo;
    });
    return res.json(depois);
  },

  // POST /terceiros/documentos { empresa_id | trabalhador_id, tipo, data_documento, arquivo, data_vencimento?, descricao?,
  //                              treinamento_id? | nr_referencia? (treinamento), resultado? (ASO: apto, apto_restricao, inapto) }
  async registrarDocumento(req, res) {
    const b = req.body || {};
    const doTrabalhador = b.trabalhador_id !== undefined && b.trabalhador_id !== null;
    const tipos = doTrabalhador ? T.DOCS_TRABALHADOR : T.DOCS_EMPRESA;
    if (!tipos[b.tipo]) throw new ErroDeNegocio(400, `tipo deve ser: ${Object.keys(tipos).join(', ')}`);
    const dataDocumento = lerData(b.data_documento, 'data_documento');
    let vencimento = lerData(b.data_vencimento, 'data_vencimento', { obrigatoria: false, futura: true });
    if (vencimento && vencimento <= dataDocumento) throw new ErroDeNegocio(400, 'data_vencimento deve ser depois da data do documento');
    if (b.tipo === 'integracao' && !vencimento) vencimento = somarMeses(dataDocumento, T.INTEGRACAO_MESES);
    if (['pgr', 'pcmso', 'aso'].includes(b.tipo) && !vencimento) throw new ErroDeNegocio(400, `${tipos[b.tipo]}: informe a data_vencimento`);
    let resultado = null;
    if (b.tipo === 'aso') {
      resultado = b.resultado;
      if (!['apto', 'apto_restricao', 'inapto'].includes(resultado)) throw new ErroDeNegocio(400, 'ASO: resultado deve ser apto, apto_restricao ou inapto');
    }
    let treinamentoId = null;
    let nrRef = texto(b.nr_referencia, 20);
    if (b.tipo === 'treinamento') {
      if (b.treinamento_id !== undefined && b.treinamento_id !== null) {
        const t = idValido(b.treinamento_id) && await knex('treinamentos').where({ id: Number(b.treinamento_id) }).first('id', 'nr_referencia');
        if (!t) throw new ErroDeNegocio(400, 'Treinamento não existe no catálogo');
        treinamentoId = t.id;
        nrRef = nrRef || t.nr_referencia;
      }
      if (!treinamentoId && !nrRef) throw new ErroDeNegocio(400, 'Treinamento: informe treinamento_id (catálogo) ou nr_referencia');
    }
    if (!b.arquivo) throw new ErroDeNegocio(400, 'arquivo é obrigatório (o documento enviado pela contratada)');

    const doc = await knex.transaction(async (trx) => {
      let empresaId;
      let trabalhadorId = null;
      if (doTrabalhador) {
        const t = await trabalhadorNoEscopo(trx, req, b.trabalhador_id);
        empresaId = t.empresa_id;
        trabalhadorId = t.id;
      } else {
        empresaId = (await empresaNoEscopo(trx, req, b.empresa_id)).id;
      }
      const arq = await salvarArquivo(trx, req, { base64: b.arquivo, contexto: `terceiro_${b.tipo}`, tipos: TIPOS_ARQUIVO, maxBytes: 10 * 1024 * 1024 });
      const [d] = await trx('terceiro_documentos').insert({
        empresa_id: empresaId, trabalhador_id: trabalhadorId, tipo: b.tipo, descricao: texto(b.descricao, 200), treinamento_id: treinamentoId,
        nr_referencia: nrRef, resultado, data_documento: dataDocumento, data_vencimento: vencimento, arquivo_id: arq.id, registrado_por: req.usuario.id
      }).returning('*');
      await auditar(trx, req, { acao: 'documento_terceiro', tabela: 'terceiro_documentos', registro_id: d.id, depois: { ...d, sha256: arq.sha256 } });
      return d;
    });
    return res.status(201).json(doc);
  },

  // POST /terceiro-documentos/:id/anular { motivo } — gestão
  async anularDocumento(req, res) {
    const motivo = texto(req.body && req.body.motivo, 2000);
    if (!motivo || motivo.length < 5) throw new ErroDeNegocio(400, 'Informe o motivo (pelo menos 5 caracteres)');
    const a = await knex.transaction(async (trx) => {
      const d = idValido(req.params.id) && await trx('terceiro_documentos').where({ id: Number(req.params.id) }).first();
      if (!d) throw new ErroDeNegocio(404, 'Documento não encontrado');
      await empresaNoEscopo(trx, req, d.empresa_id).catch(() => { throw new ErroDeNegocio(404, 'Documento não encontrado'); });
      if (await trx('terceiro_documento_anulacoes').where({ documento_id: d.id }).first('id')) throw new ErroDeNegocio(409, 'Documento já anulado');
      const [an] = await trx('terceiro_documento_anulacoes').insert({ documento_id: d.id, motivo, usuario_id: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'anular_documento_terceiro', tabela: 'terceiro_documentos', registro_id: d.id, antes: d, depois: an });
      return an;
    });
    return res.status(201).json(a);
  },

  // GET /terceiro-documentos/:id/arquivo — ASO só para saude/admin
  async arquivo(req, res) {
    const d = idValido(req.params.id) && await knex('terceiro_documentos').where({ id: Number(req.params.id) }).first();
    if (!d) throw new ErroDeNegocio(404, 'Documento não encontrado');
    await empresaNoEscopo(knex, req, d.empresa_id).catch(() => { throw new ErroDeNegocio(404, 'Documento não encontrado'); });
    if (d.tipo === 'aso' && !['admin', 'saude'].includes(req.usuario.perfil)) throw new ErroDeNegocio(403, 'O ASO é dado de saúde: só a saúde abre o arquivo');
    const arq = await knex('arquivos').where({ id: d.arquivo_id }).first();
    await auditar(knex, req, { acao: 'baixar_documento_terceiro', tabela: 'terceiro_documentos', registro_id: d.id });
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Arquivo-SHA256', arq.sha256);
    res.set('Cache-Control', 'no-store');
    return res.type(arq.tipo_mime).send(arq.conteudo);
  },

  // GET /terceiros/pendencias?filial_id=&empresa_id=&contrato_id=&situacao=&dias=30&todas=true&data_base=
  async pendencias(req, res) {
    const dias = lerDias(req.query, 'dias', 30);
    const { dataBase } = lerDataBase(req.query);
    const itens = await T.situacaoTerceiros(knex, req, req.query, { dias, dataBase });
    return res.json({ data_base: dataBase || hoje(), ...filtrarPendencias(itens, T.SITUACOES, req.query) });
  },

  // GET /terceiros/acesso?cpf=&filial_id= — portaria: este terceirizado pode trabalhar hoje nesta filial?
  async acesso(req, res) {
    const cpf = somenteDigitos(req.query.cpf);
    if (!cpfValido(cpf)) throw new ErroDeNegocio(400, 'CPF inválido');
    if (!idValido(req.query.filial_id) || !podeAcessarFilial(req, req.query.filial_id)) throw new ErroDeNegocio(404, 'Filial não encontrada');
    const t = await knex('terceiro_trabalhadores').where({ cpf }).first();
    if (!t) return res.json({ liberado: false, problemas: ['CPF não cadastrado como terceirizado'] });
    const conferido = await T.conferirTerceiro(knex, t, Number(req.query.filial_id), hoje());
    await auditar(knex, req, { acao: 'consultar_acesso_terceiro', tabela: 'terceiro_trabalhadores', registro_id: t.id, filial_id: Number(req.query.filial_id),
      depois: { liberado: conferido.ok, problemas: conferido.problemas } });
    return res.json({
      liberado: conferido.ok, problemas: conferido.problemas,
      trabalhador: { id: t.id, nome: t.nome, funcao: t.funcao, cpf: cpfParaQuem(req, t.cpf) },
      empresa: conferido.conferencia.empresa, contratos: conferido.conferencia.contratos
    });
  }
};
