// Download de arquivos (termos de adesão, fotos), respeitando a filial do usuário.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { ehAdmin, podeAcessarFilial } = require('../utils/escopo');
const { auditar } = require('../utils/auditoria');

module.exports = {
  async show(req, res) {
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ErroDeNegocio(404, 'Arquivo não encontrado');
    const arquivo = await knex('arquivos').where({ id }).first();
    const permitido = arquivo && (arquivo.filial_id ? podeAcessarFilial(req, arquivo.filial_id) : ehAdmin(req));
    if (!permitido) throw new ErroDeNegocio(404, 'Arquivo não encontrado');

    await auditar(knex, req, { acao: 'baixar_arquivo', tabela: 'arquivos', registro_id: arquivo.id, filial_id: arquivo.filial_id });
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Arquivo-SHA256', arquivo.sha256);
    res.set('Content-Disposition', `inline; filename="${arquivo.nome.replace(/"/g, '')}"`);
    return res.type(arquivo.tipo_mime).send(arquivo.conteudo);
  }
};
