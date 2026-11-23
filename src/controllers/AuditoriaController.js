// Consulta do log de auditoria (somente matriz). O log não tem rota de alteração nem exclusão.
const knex = require('../database/db');

module.exports = {
  // Filtros: ?tabela=funcionarios&registro_id=10&usuario_id=1&filial_id=2&de=AAAA-MM-DD&ate=AAAA-MM-DD&limite=100
  async index(req, res) {
    const limite = Math.min(Number(req.query.limite) || 100, 1000);
    const query = knex('auditoria')
      .leftJoin('usuarios', 'usuarios.id', 'auditoria.usuario_id')
      .select('auditoria.*', 'usuarios.nome as usuario')
      .orderBy('auditoria.id', 'desc')
      .limit(limite);
    for (const filtro of ['tabela', 'registro_id', 'usuario_id', 'filial_id', 'acao']) {
      if (req.query[filtro]) query.where(`auditoria.${filtro}`, req.query[filtro]);
    }
    if (req.query.de) query.where('auditoria.created_at', '>=', req.query.de);
    if (req.query.ate) query.where('auditoria.created_at', '<', knex.raw("?::date + interval '1 day'", [req.query.ate]));
    return res.json(await query);
  }
};
