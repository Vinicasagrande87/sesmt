// Catálogo de treinamentos do grupo (NR-10, NR-35, brigada...) e exigências por função: só a matriz altera.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { pegar, exigirCampos, idValido } = require('../utils/validacao');

const CAMPOS = ['nome_treinamento', 'nr_referencia', 'carga_horaria', 'validade_meses', 'obrigatorio', 'conteudo_programatico', 'ativo'];

function validar(dados) {
  for (const campo of ['carga_horaria', 'validade_meses']) {
    if (dados[campo] !== undefined && dados[campo] !== null) {
      const n = Number(dados[campo]);
      if (!Number.isInteger(n) || n < 0) throw new ErroDeNegocio(400, `${campo} deve ser um inteiro`);
      dados[campo] = n;
    }
  }
  if (dados.validade_meses === 0) dados.validade_meses = null; // 0 = não vence
  return dados;
}

module.exports = {
  async index(req, res) {
    const query = knex('treinamentos').orderBy('nome_treinamento');
    if (req.query.ativo !== undefined) query.where('ativo', req.query.ativo === 'true');
    return res.json(await query);
  },

  async create(req, res) {
    exigirCampos(req.body, ['nome_treinamento', 'carga_horaria']);
    const dados = validar(pegar(req.body, CAMPOS));
    const treinamento = await knex.transaction(async (trx) => {
      const [novo] = await trx('treinamentos').insert(dados).returning('*');
      await auditar(trx, req, { acao: 'criar', tabela: 'treinamentos', registro_id: novo.id, depois: novo });
      return novo;
    });
    return res.status(201).json(treinamento);
  },

  async update(req, res) {
    const dados = validar(pegar(req.body, CAMPOS));
    if (!Object.keys(dados).length) throw new ErroDeNegocio(400, 'Nenhum campo para alterar');
    const treinamento = await knex.transaction(async (trx) => {
      const antes = await trx('treinamentos').where({ id: req.params.id }).forUpdate().first();
      if (!antes) throw new ErroDeNegocio(404, 'Treinamento não encontrado');
      const [depois] = await trx('treinamentos').where({ id: antes.id }).update(dados).returning('*');
      await auditar(trx, req, { acao: 'alterar', tabela: 'treinamentos', registro_id: antes.id, antes, depois });
      return depois;
    });
    return res.json(treinamento);
  },

  // GET /funcoes/:id/treinamentos — o que a função exige
  async exigidosDaFuncao(req, res) {
    const funcao = await knex('funcoes').where({ id: req.params.id }).first('id', 'nome');
    if (!funcao) throw new ErroDeNegocio(404, 'Função não encontrada');
    const treinamentos = await knex('funcao_treinamentos as ft')
      .join('treinamentos as t', 't.id', 'ft.treinamento_id')
      .where('ft.funcao_id', funcao.id)
      .orderBy('t.nome_treinamento')
      .select('t.*');
    return res.json({ ...funcao, treinamentos });
  },

  // PUT /funcoes/:id/treinamentos { treinamento_ids: [..] } — substitui a lista de exigências
  async definirExigidos(req, res) {
    const lista = req.body && req.body.treinamento_ids;
    if (!Array.isArray(lista) || !lista.every(idValido)) {
      throw new ErroDeNegocio(400, 'Envie treinamento_ids: lista de ids (pode ser vazia)');
    }
    const ids = [...new Set(lista.map(Number))];
    await knex.transaction(async (trx) => {
      const funcao = await trx('funcoes').where({ id: req.params.id }).forUpdate().first('id');
      if (!funcao) throw new ErroDeNegocio(404, 'Função não encontrada');
      if (ids.length) {
        const existentes = await trx('treinamentos').whereIn('id', ids).pluck('id');
        if (existentes.length !== ids.length) throw new ErroDeNegocio(400, 'Algum treinamento informado não existe');
      }
      const antes = await trx('funcao_treinamentos').where({ funcao_id: funcao.id }).pluck('treinamento_id');
      await trx('funcao_treinamentos').where({ funcao_id: funcao.id }).del();
      if (ids.length) await trx('funcao_treinamentos').insert(ids.map((treinamento_id) => ({ funcao_id: funcao.id, treinamento_id })));
      // Histórico (relatórios "como estava em"): encerra o que saiu e abre o que entrou
      const saiu = antes.filter((t) => !ids.includes(t));
      const entrou = ids.filter((t) => !antes.includes(t));
      if (saiu.length) {
        await trx('funcao_treinamento_vigencias').where({ funcao_id: funcao.id }).whereIn('treinamento_id', saiu).whereNull('fim')
          .update({ fim: trx.fn.now() });
      }
      if (entrou.length) {
        await trx('funcao_treinamento_vigencias')
          .insert(entrou.map((treinamento_id) => ({ funcao_id: funcao.id, treinamento_id, inicio: trx.fn.now(), usuario_id: req.usuario.id })));
      }
      await auditar(trx, req, { acao: 'definir_exigencias', tabela: 'funcoes', registro_id: funcao.id, antes: { treinamentos: antes }, depois: { treinamentos: ids } });
    });
    return module.exports.exigidosDaFuncao(req, res);
  }
};
