// Controller genérico para cadastros que pertencem a uma filial (prédios, setores).
// Listagem filtrada pelas filiais do usuário; criação/alteração só na filial dele.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { noEscopo, exigirFilial } = require('../utils/escopo');
const { pegar, exigirCampos, idValido, somenteDigitos } = require('../utils/validacao');

module.exports = function cadastroDaFilial({ tabela, nome, campos, obrigatorios, validarExtra }) {
  function normalizar(dados) {
    if (dados.cep) {
      dados.cep = somenteDigitos(dados.cep);
      if (dados.cep.length !== 8) throw new ErroDeNegocio(400, 'CEP deve ter 8 dígitos');
    }
    return validarExtra ? validarExtra(dados) : dados;
  }

  return {
    // Filtros: ?filial_id=1&ativo=true
    async index(req, res) {
      const query = noEscopo(knex(tabela), req, `${tabela}.filial_id`)
        .join('filiais', 'filiais.id', `${tabela}.filial_id`)
        .select(`${tabela}.*`, 'filiais.nome as filial')
        .orderBy([{ column: 'filiais.nome' }, { column: `${tabela}.nome` }]);
      if (req.query.filial_id) query.where(`${tabela}.filial_id`, req.query.filial_id);
      if (req.query.ativo !== undefined) query.where(`${tabela}.ativo`, req.query.ativo === 'true');
      return res.json(await query);
    },

    async create(req, res) {
      exigirCampos(req.body, ['filial_id', ...obrigatorios]);
      if (!idValido(req.body.filial_id)) throw new ErroDeNegocio(400, 'filial_id inválido');
      exigirFilial(req, req.body.filial_id);

      const dados = normalizar({ ...pegar(req.body, campos), filial_id: Number(req.body.filial_id) });
      const registro = await knex.transaction(async (trx) => {
        const filial = await trx('filiais').where({ id: dados.filial_id }).first('id', 'ativa');
        if (!filial) throw new ErroDeNegocio(404, 'Filial não encontrada');
        if (!filial.ativa) throw new ErroDeNegocio(409, 'Filial inativa');

        const [novo] = await trx(tabela).insert(dados).returning('*');
        await auditar(trx, req, { acao: 'criar', tabela, registro_id: novo.id, filial_id: novo.filial_id, depois: novo });
        return novo;
      });
      return res.status(201).json(registro);
    },

    // A filial não muda. Para "excluir", envie { ativo: false }.
    async update(req, res) {
      const dados = normalizar(pegar(req.body, campos));
      if (!Object.keys(dados).length) throw new ErroDeNegocio(400, 'Nenhum campo para alterar');

      const registro = await knex.transaction(async (trx) => {
        const antes = await trx(tabela).where({ id: req.params.id }).forUpdate().first();
        if (!antes) throw new ErroDeNegocio(404, `${nome} não encontrado`);
        exigirFilial(req, antes.filial_id);

        const [depois] = await trx(tabela).where({ id: antes.id })
          .update({ ...dados, updated_at: trx.fn.now() }).returning('*');
        await auditar(trx, req, { acao: 'alterar', tabela, registro_id: antes.id, filial_id: antes.filial_id, antes, depois });
        return depois;
      });
      return res.json(registro);
    }
  };
};
