const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { noEscopo, exigirFilial } = require('../utils/escopo');
const { UFS, somenteDigitos, cnpjValido, pegar, exigirCampos } = require('../utils/validacao');

const CAMPOS = ['nome', 'tipo', 'matriz', 'cnpj', 'razao_social', 'uf', 'cidade', 'codigo_ibge',
  'bairro', 'cep', 'logradouro', 'numero', 'complemento', 'ativa', 'grau_risco'];

function normalizar(dados) {
  if (dados.grau_risco !== undefined && dados.grau_risco !== null) {
    const grau = Number(dados.grau_risco);
    if (![1, 2, 3, 4].includes(grau)) throw new ErroDeNegocio(400, 'grau_risco deve ser 1, 2, 3 ou 4');
    dados.grau_risco = grau;
  }
  if (dados.cnpj !== undefined) {
    dados.cnpj = somenteDigitos(dados.cnpj);
    if (!cnpjValido(dados.cnpj)) throw new ErroDeNegocio(400, 'CNPJ inválido');
  }
  if (dados.uf !== undefined) {
    dados.uf = String(dados.uf).trim().toUpperCase();
    if (!UFS.includes(dados.uf)) throw new ErroDeNegocio(400, 'UF inválida');
  }
  if (dados.cep !== undefined && dados.cep !== null) {
    dados.cep = somenteDigitos(dados.cep);
    if (dados.cep.length !== 8) throw new ErroDeNegocio(400, 'CEP deve ter 8 dígitos');
  }
  return dados;
}

module.exports = {
  // Admin vê todas; os demais, só as suas. Filtros: ?uf=RS&cidade=Guaíba&tipo=Campus&ativa=true
  async index(req, res) {
    const query = noEscopo(knex('filiais'), req, 'filiais.id').orderBy('nome');
    for (const filtro of ['uf', 'cidade', 'tipo']) {
      if (req.query[filtro]) query.where(filtro, req.query[filtro]);
    }
    if (req.query.ativa !== undefined) query.where('ativa', req.query.ativa === 'true');
    return res.json(await query.select('*'));
  },

  async show(req, res) {
    exigirFilial(req, req.params.id);
    const filial = await knex('filiais').where({ id: req.params.id }).first();
    if (!filial) throw new ErroDeNegocio(404, 'Filial não encontrada');
    const predios = await knex('predios').where({ filial_id: filial.id }).orderBy('nome');
    const setores = await knex('setores').where({ filial_id: filial.id }).orderBy('nome');
    return res.json({ ...filial, predios, setores });
  },

  // Somente admin (matriz)
  async create(req, res) {
    exigirCampos(req.body, ['nome', 'cnpj', 'uf', 'cidade', 'bairro']);
    const dados = normalizar(pegar(req.body, CAMPOS));

    const filial = await knex.transaction(async (trx) => {
      const [nova] = await trx('filiais').insert(dados).returning('*');
      await auditar(trx, req, { acao: 'criar', tabela: 'filiais', registro_id: nova.id, filial_id: nova.id, depois: nova });
      return nova;
    });
    return res.status(201).json(filial);
  },

  // Somente admin. Para "excluir", envie { ativa: false }: filial com histórico nunca é apagada.
  async update(req, res) {
    const dados = normalizar(pegar(req.body, CAMPOS));
    if (!Object.keys(dados).length) throw new ErroDeNegocio(400, 'Nenhum campo para alterar');

    const filial = await knex.transaction(async (trx) => {
      const antes = await trx('filiais').where({ id: req.params.id }).forUpdate().first();
      if (!antes) throw new ErroDeNegocio(404, 'Filial não encontrada');
      const [depois] = await trx('filiais').where({ id: antes.id })
        .update({ ...dados, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'alterar', tabela: 'filiais', registro_id: antes.id, filial_id: antes.id, antes, depois });
      return depois;
    });
    return res.json(filial);
  }
};
