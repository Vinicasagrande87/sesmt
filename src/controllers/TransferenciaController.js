// Transferência de EPI entre filiais: a origem envia (sai do estoque dela), o destino confirma o recebimento
// (entra no estoque dele com o MESMO custo e validade dos lotes de origem). Pendente pode ser cancelada.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { ehAdmin, exigirFilial } = require('../utils/escopo');
const { hoje } = require('../utils/datas');
const { exigirCampos, idValido } = require('../utils/validacao');
const { itemAtivo } = require('../services/epi');
const estoque = require('../services/estoque');

async function buscar(trx, id) {
  const t = await trx('transferencias').where({ id }).forUpdate().first();
  if (!t) throw new ErroDeNegocio(404, 'Transferência não encontrada');
  return t;
}

module.exports = {
  // GET /transferencias?status=pendente — as que saem ou chegam nas filiais do usuário
  async index(req, res) {
    const query = knex('transferencias as t')
      .join('filiais as o', 'o.id', 't.origem_filial_id')
      .join('filiais as d', 'd.id', 't.destino_filial_id')
      .join('epi_itens as i', 'i.id', 't.item_id')
      .join('epis as e', 'e.id', 'i.epi_id')
      .select('t.*', 'o.nome as origem', 'd.nome as destino', 'e.nome as epi', 'i.tamanho')
      .orderBy('t.id', 'desc');
    if (!ehAdmin(req)) {
      query.where((q) => q.whereIn('t.origem_filial_id', req.usuario.filiais).orWhereIn('t.destino_filial_id', req.usuario.filiais));
    }
    if (req.query.status) query.where('t.status', req.query.status);
    return res.json(await query);
  },

  // POST /transferencias { origem_filial_id, destino_filial_id, item_id, quantidade, observacao? }
  async enviar(req, res) {
    exigirCampos(req.body, ['origem_filial_id', 'destino_filial_id', 'item_id', 'quantidade']);
    const { origem_filial_id, destino_filial_id, item_id, observacao } = req.body;
    if (![origem_filial_id, destino_filial_id, item_id].every(idValido)) throw new ErroDeNegocio(400, 'Ids inválidos');
    if (Number(origem_filial_id) === Number(destino_filial_id)) throw new ErroDeNegocio(400, 'Origem e destino devem ser filiais diferentes');
    const quantidade = Number(req.body.quantidade);
    if (!Number.isInteger(quantidade) || quantidade < 1) throw new ErroDeNegocio(400, 'quantidade deve ser um inteiro maior que zero');
    exigirFilial(req, origem_filial_id);

    const transferencia = await knex.transaction(async (trx) => {
      await itemAtivo(trx, item_id);
      const destino = await trx('filiais').where({ id: destino_filial_id }).first('ativa');
      if (!destino || !destino.ativa) throw new ErroDeNegocio(400, 'Filial de destino não encontrada ou inativa');

      const [t] = await trx('transferencias').insert({
        origem_filial_id, destino_filial_id, item_id, quantidade, observacao: observacao || null, enviado_por: req.usuario.id
      }).returning('*');
      const { custo_total } = await estoque.consumirPEPS(trx, {
        filial_id: Number(origem_filial_id), item_id: Number(item_id), quantidade,
        tipo: 'transferencia_saida', usuario_id: req.usuario.id, transferencia_id: t.id,
        motivo: `Transferência #${t.id}`
      });
      await auditar(trx, req, { acao: 'enviar', tabela: 'transferencias', registro_id: t.id, filial_id: t.origem_filial_id, depois: { ...t, custo_total } });
      return { ...t, custo_total };
    });
    return res.status(201).json(transferencia);
  },

  // POST /transferencias/:id/receber — feito por quem atua na filial de destino
  async receber(req, res) {
    const resultado = await knex.transaction(async (trx) => {
      const t = await buscar(trx, req.params.id);
      exigirFilial(req, t.destino_filial_id);
      if (t.status !== 'pendente') throw new ErroDeNegocio(409, `Transferência já está ${t.status}`);

      const saidas = await trx('movimentacoes as m')
        .join('lotes as l', 'l.id', 'm.lote_id')
        .where({ 'm.transferencia_id': t.id, 'm.tipo': 'transferencia_saida' })
        .select('m.quantidade', 'l.*');

      const lotes = [];
      for (const s of saidas) {
        const { lote } = await estoque.registrarEntrada(trx, {
          filial_id: t.destino_filial_id,
          item_id: t.item_id,
          fornecedor_id: null,
          nota_numero: s.nota_numero,
          nota_data: s.nota_data,
          data_entrada: hoje(),
          quantidade_inicial: -s.quantidade,
          valor_unitario: s.valor_unitario,          // mesmo custo da compra original
          data_fabricacao: s.data_fabricacao,
          data_validade: s.data_validade,
          lote_fabricante: s.lote_fabricante,
          origem_lote_id: s.id,
          observacao: `Recebido da transferência #${t.id}`
        }, { usuario_id: req.usuario.id, tipo: 'transferencia_entrada', transferencia_id: t.id, motivo: `Transferência #${t.id}` });
        lotes.push(lote);
      }

      const [depois] = await trx('transferencias').where({ id: t.id })
        .update({ status: 'recebida', concluido_por: req.usuario.id, concluido_em: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'receber', tabela: 'transferencias', registro_id: t.id, filial_id: t.destino_filial_id, antes: t, depois });
      return { ...depois, lotes };
    });
    return res.json(resultado);
  },

  // POST /transferencias/:id/cancelar { motivo } — pela origem, enquanto pendente: o estoque volta para os lotes de origem
  async cancelar(req, res) {
    const motivo = req.body && req.body.motivo;
    if (!motivo || String(motivo).trim().length < 5) throw new ErroDeNegocio(400, 'Informe o motivo (pelo menos 5 caracteres)');
    const resultado = await knex.transaction(async (trx) => {
      const t = await buscar(trx, req.params.id);
      exigirFilial(req, t.origem_filial_id);
      if (t.status !== 'pendente') throw new ErroDeNegocio(409, `Transferência já está ${t.status}`);

      const saidas = await trx('movimentacoes').where({ transferencia_id: t.id, tipo: 'transferencia_saida' });
      await estoque.estornar(trx, saidas, { usuario_id: req.usuario.id, motivo: `Cancelamento da transferência #${t.id}: ${motivo}` });
      const [depois] = await trx('transferencias').where({ id: t.id })
        .update({ status: 'cancelada', concluido_por: req.usuario.id, concluido_em: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'cancelar', tabela: 'transferencias', registro_id: t.id, filial_id: t.origem_filial_id, antes: t, depois: { ...depois, motivo } });
      return depois;
    });
    return res.json(resultado);
  }
};
