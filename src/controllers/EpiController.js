// Catálogo de EPIs do grupo: todos consultam, só a matriz (admin) cadastra e altera.
// EPI com histórico não é apagado: envie { ativo: false }.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { hoje, dataValida } = require('../utils/datas');
const { pegar, exigirCampos } = require('../utils/validacao');

const CAMPOS = ['nome', 'categoria', 'unidade', 'fabricante', 'descricao', 'validade_dias', 'ativo'];

function validar(dados) {
  if (dados.validade_dias !== undefined) {
    const dias = Number(dados.validade_dias);
    if (!Number.isInteger(dias) || dias < 1) throw new ErroDeNegocio(400, 'validade_dias (periodicidade de troca) deve ser um inteiro maior que zero');
    dados.validade_dias = dias;
  }
  return dados;
}

function validarCa(ca) {
  if (!ca || !ca.numero) throw new ErroDeNegocio(400, 'Informe o CA: { numero, validade }');
  const numero = String(ca.numero).replace(/\D/g, '');
  if (!numero) throw new ErroDeNegocio(400, 'Número do CA inválido');
  if (!ca.validade || !dataValida(ca.validade)) throw new ErroDeNegocio(400, 'Validade do CA deve estar no formato AAAA-MM-DD');
  return { numero, validade: ca.validade };
}

// EPIs com itens (tamanhos) e CAs, marcando o vigente
async function montarCatalogo(query) {
  const epis = await query;
  if (!epis.length) return [];
  const idsEpi = epis.map((e) => e.id);
  const itens = await knex('epi_itens').whereIn('epi_id', idsEpi).orderBy('id');
  const cas = await knex('epi_cas').whereIn('epi_id', idsEpi).orderBy('validade', 'desc');
  const dataHoje = hoje();
  return epis.map((e) => {
    const casDoEpi = cas.filter((c) => c.epi_id === e.id);
    const vigente = casDoEpi.find((c) => c.validade && c.validade >= dataHoje) || null;
    return {
      ...e,
      itens: itens.filter((i) => i.epi_id === e.id),
      ca_vigente: vigente && { numero: vigente.numero, validade: vigente.validade },
      cas: casDoEpi.map(({ id, numero, validade, created_at }) => ({ id, numero, validade, created_at }))
    };
  });
}

module.exports = {
  // Filtros: ?ativo=true&categoria=...
  async index(req, res) {
    const query = knex('epis').orderBy('nome').select('id', 'nome', 'categoria', 'unidade', 'fabricante', 'descricao', 'validade_dias', 'ativo');
    if (req.query.ativo !== undefined) query.where('ativo', req.query.ativo === 'true');
    if (req.query.categoria) query.where('categoria', req.query.categoria);
    return res.json(await montarCatalogo(query));
  },

  async show(req, res) {
    const [epi] = await montarCatalogo(knex('epis').where({ id: req.params.id }));
    if (!epi) throw new ErroDeNegocio(404, 'EPI não encontrado');
    return res.json(epi);
  },

  // { nome, validade_dias, categoria?, unidade?, fabricante?, descricao?, tamanhos?: ['P','M','G'], ca: { numero, validade } }
  async create(req, res) {
    exigirCampos(req.body, ['nome', 'validade_dias', 'ca']);
    const dados = validar(pegar(req.body, CAMPOS));
    const ca = validarCa(req.body.ca);
    const tamanhos = Array.isArray(req.body.tamanhos) && req.body.tamanhos.length
      ? [...new Set(req.body.tamanhos.map((t) => String(t).trim()).filter(Boolean))]
      : ['Único'];

    const id = await knex.transaction(async (trx) => {
      const [novo] = await trx('epis').insert(dados).returning('*');
      await trx('epi_itens').insert(tamanhos.map((tamanho) => ({ epi_id: novo.id, tamanho })));
      await trx('epi_cas').insert({ epi_id: novo.id, ...ca, cadastrado_por: req.usuario.id });
      await auditar(trx, req, { acao: 'criar', tabela: 'epis', registro_id: novo.id, depois: { ...novo, tamanhos, ca } });
      return novo.id;
    });
    const [epi] = await montarCatalogo(knex('epis').where({ id }));
    return res.status(201).json(epi);
  },

  async update(req, res) {
    const dados = validar(pegar(req.body, CAMPOS));
    if (!Object.keys(dados).length) throw new ErroDeNegocio(400, 'Nenhum campo para alterar');
    await knex.transaction(async (trx) => {
      const antes = await trx('epis').where({ id: req.params.id }).forUpdate().first();
      if (!antes) throw new ErroDeNegocio(404, 'EPI não encontrado');
      const [depois] = await trx('epis').where({ id: antes.id })
        .update({ ...dados, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'alterar', tabela: 'epis', registro_id: antes.id, antes, depois });
    });
    const [epi] = await montarCatalogo(knex('epis').where({ id: req.params.id }));
    return res.json(epi);
  },

  // POST /epis/:id/cas { numero, validade } — renovação ou novo CA
  async adicionarCa(req, res) {
    const ca = validarCa(req.body);
    await knex.transaction(async (trx) => {
      const epi = await trx('epis').where({ id: req.params.id }).first('id');
      if (!epi) throw new ErroDeNegocio(404, 'EPI não encontrado');
      const [novo] = await trx('epi_cas').insert({ epi_id: epi.id, ...ca, cadastrado_por: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'adicionar_ca', tabela: 'epis', registro_id: epi.id, depois: novo });
    });
    const [epi] = await montarCatalogo(knex('epis').where({ id: req.params.id }));
    return res.status(201).json(epi);
  },

  // POST /epis/:id/itens { tamanho, codigo? }
  async adicionarItem(req, res) {
    exigirCampos(req.body, ['tamanho']);
    const item = await knex.transaction(async (trx) => {
      const epi = await trx('epis').where({ id: req.params.id }).first('id');
      if (!epi) throw new ErroDeNegocio(404, 'EPI não encontrado');
      const [novo] = await trx('epi_itens')
        .insert({ epi_id: epi.id, tamanho: String(req.body.tamanho).trim(), codigo: req.body.codigo || null })
        .returning('*');
      await auditar(trx, req, { acao: 'criar', tabela: 'epi_itens', registro_id: novo.id, depois: novo });
      return novo;
    });
    return res.status(201).json(item);
  },

  // PUT /epi-itens/:id { codigo?, ativo? }
  async alterarItem(req, res) {
    const dados = pegar(req.body, ['codigo', 'ativo']);
    if (!Object.keys(dados).length) throw new ErroDeNegocio(400, 'Nenhum campo para alterar');
    const item = await knex.transaction(async (trx) => {
      const antes = await trx('epi_itens').where({ id: req.params.id }).forUpdate().first();
      if (!antes) throw new ErroDeNegocio(404, 'Item não encontrado');
      const [depois] = await trx('epi_itens').where({ id: antes.id })
        .update({ ...dados, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'alterar', tabela: 'epi_itens', registro_id: antes.id, antes, depois });
      return depois;
    });
    return res.json(item);
  }
};
