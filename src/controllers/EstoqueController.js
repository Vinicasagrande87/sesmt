// Estoque por filial e por lote, com o valor pago em cada compra.
// Nada é editado: entradas, saídas, descartes e ajustes são movimentações; erro se corrige com estorno.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { noEscopo, exigirFilial } = require('../utils/escopo');
const { hoje, dataValida } = require('../utils/datas');
const { exigirCampos, idValido } = require('../utils/validacao');
const { itemAtivo } = require('../services/epi');
const estoque = require('../services/estoque');

function inteiroPositivo(valor, campo) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1) throw new ErroDeNegocio(400, `${campo} deve ser um número inteiro maior que zero`);
  return n;
}

function exigirMotivo(motivo) {
  if (!motivo || String(motivo).trim().length < 5) {
    throw new ErroDeNegocio(400, 'Informe o motivo (pelo menos 5 caracteres)');
  }
  return String(motivo).trim();
}

function validarDatas(dados, campos) {
  for (const campo of campos) {
    if (dados[campo] && !dataValida(dados[campo])) throw new ErroDeNegocio(400, `${campo} deve estar no formato AAAA-MM-DD`);
  }
}

module.exports = {
  // POST /estoque/entradas — compra/recebimento: cria um lote com o preço pago
  async entrada(req, res) {
    exigirCampos(req.body, ['filial_id', 'item_id', 'quantidade', 'valor_unitario']);
    const b = req.body;
    if (!idValido(b.filial_id) || !idValido(b.item_id)) throw new ErroDeNegocio(400, 'filial_id e item_id inválidos');
    exigirFilial(req, b.filial_id);

    const quantidade = inteiroPositivo(b.quantidade, 'quantidade');
    const valor_unitario = Number(b.valor_unitario);
    if (!Number.isFinite(valor_unitario) || valor_unitario < 0) throw new ErroDeNegocio(400, 'valor_unitario deve ser um número maior ou igual a zero');

    const data_entrada = b.data_entrada || hoje();
    validarDatas({ ...b, data_entrada }, ['data_entrada', 'nota_data', 'data_fabricacao', 'data_validade']);
    if (data_entrada > hoje()) throw new ErroDeNegocio(400, 'data_entrada não pode ser futura');
    if (b.data_validade && b.data_validade < hoje()) throw new ErroDeNegocio(400, 'Lote já vencido: não pode entrar no estoque');

    const resultado = await knex.transaction(async (trx) => {
      await itemAtivo(trx, b.item_id);
      if (b.fornecedor_id) {
        const f = await trx('fornecedores').where({ id: b.fornecedor_id }).first('filial_id', 'ativo');
        if (!f || !f.ativo || f.filial_id !== Number(b.filial_id)) throw new ErroDeNegocio(400, 'Fornecedor não encontrado nesta filial');
      }

      const { lote, movimento } = await estoque.registrarEntrada(trx, {
        filial_id: Number(b.filial_id),
        item_id: Number(b.item_id),
        fornecedor_id: b.fornecedor_id || null,
        nota_numero: b.nota_numero || null,
        nota_data: b.nota_data || null,
        data_entrada,
        quantidade_inicial: quantidade,
        valor_unitario,
        data_fabricacao: b.data_fabricacao || null,
        data_validade: b.data_validade || null,
        lote_fabricante: b.lote_fabricante || null,
        observacao: b.observacao || null
      }, { usuario_id: req.usuario.id });

      await auditar(trx, req, { acao: 'entrada', tabela: 'lotes', registro_id: lote.id, filial_id: lote.filial_id, depois: lote });
      return { lote, movimento };
    });
    return res.status(201).json(resultado);
  },

  // GET /estoque/saldos?filial_id=&abaixo_minimo=true
  // valor = soma dos valores das movimentações (custo histórico de cada lote, nunca o preço atual)
  async saldos(req, res) {
    const dataHoje = hoje();
    const query = noEscopo(knex('movimentacoes as m'), req, 'm.filial_id')
      .join('lotes as l', 'l.id', 'm.lote_id')
      .groupBy('m.filial_id', 'm.item_id')
      .select('m.filial_id', 'm.item_id')
      .sum({ saldo: 'm.quantidade' })
      .sum({ valor: 'm.valor_total' })
      .select(knex.raw('coalesce(sum(case when l.data_validade < ? then m.quantidade else 0 end), 0) as saldo_vencido', [dataHoje]));
    if (req.query.filial_id) query.where('m.filial_id', req.query.filial_id);

    const minimosQuery = noEscopo(knex('estoque_minimo'), req, 'filial_id');
    if (req.query.filial_id) minimosQuery.where('filial_id', req.query.filial_id);

    const [linhas, minimos] = await Promise.all([query, minimosQuery]);
    const chave = (f, i) => `${f}:${i}`;
    const mapa = new Map(linhas.map((l) => [chave(l.filial_id, l.item_id), { ...l }]));
    for (const m of minimos) {
      const k = chave(m.filial_id, m.item_id);
      if (!mapa.has(k)) mapa.set(k, { filial_id: m.filial_id, item_id: m.item_id, saldo: 0, valor: 0, saldo_vencido: 0 });
      mapa.get(k).minimo = m.minimo;
    }
    if (!mapa.size) return res.json([]);

    const registros = [...mapa.values()];
    const itens = await knex('epi_itens').join('epis', 'epis.id', 'epi_itens.epi_id')
      .whereIn('epi_itens.id', [...new Set(registros.map((r) => r.item_id))])
      .select('epi_itens.id', 'epi_itens.tamanho', 'epis.id as epi_id', 'epis.nome as epi', 'epis.unidade');
    const filiais = await knex('filiais').whereIn('id', [...new Set(registros.map((r) => r.filial_id))]).select('id', 'nome');

    let resultado = registros.map((r) => {
      const item = itens.find((i) => i.id === r.item_id);
      const saldo = Number(r.saldo);
      const vencido = Number(r.saldo_vencido);
      const minimo = r.minimo ?? null;
      return {
        filial_id: r.filial_id,
        filial: filiais.find((f) => f.id === r.filial_id).nome,
        item_id: r.item_id,
        epi_id: item.epi_id,
        epi: item.epi,
        tamanho: item.tamanho,
        unidade: item.unidade,
        saldo,
        saldo_disponivel: saldo - vencido,
        saldo_vencido: vencido,
        valor: estoque.arredondar(Number(r.valor)),
        minimo,
        abaixo_minimo: minimo !== null && saldo - vencido < minimo
      };
    }).sort((a, b) => a.filial.localeCompare(b.filial) || a.epi.localeCompare(b.epi) || a.tamanho.localeCompare(b.tamanho));

    if (req.query.abaixo_minimo === 'true') resultado = resultado.filter((r) => r.abaixo_minimo);
    return res.json(resultado);
  },

  // GET /estoque/disponivel?filial_id= — o que pode ser entregue agora (para o leitor)
  async disponivel(req, res) {
    if (!idValido(req.query.filial_id)) throw new ErroDeNegocio(400, 'Informe filial_id');
    exigirFilial(req, req.query.filial_id);
    const dataHoje = hoje();

    const linhas = await knex('movimentacoes as m')
      .join('lotes as l', 'l.id', 'm.lote_id')
      .join('epi_itens as i', 'i.id', 'm.item_id')
      .join('epis as e', 'e.id', 'i.epi_id')
      .where('m.filial_id', req.query.filial_id)
      .where('i.ativo', true).where('e.ativo', true)
      .where((q) => q.whereNull('l.data_validade').orWhere('l.data_validade', '>=', dataHoje))
      .groupBy('i.id', 'i.tamanho', 'e.id', 'e.nome', 'e.unidade')
      .havingRaw('sum(m.quantidade) > 0')
      .select('i.id as item_id', 'i.tamanho', 'e.id as epi_id', 'e.nome as epi', 'e.unidade')
      .sum({ saldo: 'm.quantidade' })
      .orderBy([{ column: 'e.nome' }, { column: 'i.tamanho' }]);

    const cas = await knex('epi_cas')
      .whereIn('epi_id', [...new Set(linhas.map((l) => l.epi_id))])
      .where('validade', '>=', dataHoje)
      .orderBy('validade', 'desc');

    return res.json(linhas.map((l) => {
      const ca = cas.find((c) => c.epi_id === l.epi_id);
      return { ...l, saldo: Number(l.saldo), ca_vigente: ca ? { numero: ca.numero, validade: ca.validade } : null };
    }));
  },

  // GET /estoque/lotes?filial_id=&item_id=&com_saldo=true
  async lotes(req, res) {
    const query = noEscopo(knex('lotes as l'), req, 'l.filial_id')
      .join('epi_itens as i', 'i.id', 'l.item_id')
      .join('epis as e', 'e.id', 'i.epi_id')
      .join('filiais as f', 'f.id', 'l.filial_id')
      .leftJoin('fornecedores as fo', 'fo.id', 'l.fornecedor_id')
      .leftJoin('movimentacoes as m', 'm.lote_id', 'l.id')
      .groupBy('l.id', 'e.nome', 'i.tamanho', 'f.nome', 'fo.nome')
      .select('l.*', 'e.nome as epi', 'i.tamanho', 'f.nome as filial', 'fo.nome as fornecedor')
      .select(knex.raw('coalesce(sum(m.quantidade), 0) as saldo'))
      .orderBy([{ column: 'l.data_entrada' }, { column: 'l.id' }]);
    if (req.query.filial_id) query.where('l.filial_id', req.query.filial_id);
    if (req.query.item_id) query.where('l.item_id', req.query.item_id);
    if (req.query.com_saldo === 'true') query.havingRaw('sum(m.quantidade) > 0');
    const dataHoje = hoje();
    const lotes = await query;
    return res.json(lotes.map((l) => ({ ...l, saldo: Number(l.saldo), vencido: !!l.data_validade && l.data_validade < dataHoje })));
  },

  // GET /estoque/movimentacoes?filial_id=&item_id=&lote_id=&tipo=&de=&ate=
  async movimentacoes(req, res) {
    const query = noEscopo(knex('movimentacoes as m'), req, 'm.filial_id')
      .join('epi_itens as i', 'i.id', 'm.item_id')
      .join('epis as e', 'e.id', 'i.epi_id')
      .join('usuarios as u', 'u.id', 'm.usuario_id')
      .select('m.*', 'e.nome as epi', 'i.tamanho', 'u.nome as usuario')
      .orderBy('m.id', 'desc')
      .limit(Math.min(Number(req.query.limite) || 500, 5000));
    for (const filtro of ['filial_id', 'item_id', 'lote_id', 'tipo', 'entrega_id']) {
      if (req.query[filtro]) query.where(`m.${filtro}`, req.query[filtro]);
    }
    if (req.query.de) query.where('m.created_at', '>=', req.query.de);
    if (req.query.ate) query.where('m.created_at', '<', knex.raw("?::date + interval '1 day'", [req.query.ate]));
    return res.json(await query);
  },

  // POST /estoque/descartes { lote_id, quantidade, motivo } — vencido, danificado, perdido
  async descarte(req, res) {
    exigirCampos(req.body, ['lote_id', 'quantidade', 'motivo']);
    const quantidade = inteiroPositivo(req.body.quantidade, 'quantidade');
    const motivo = exigirMotivo(req.body.motivo);
    const resultado = await knex.transaction(async (trx) => {
      const lote = await trx('lotes').where({ id: req.body.lote_id }).first('filial_id');
      if (!lote) throw new ErroDeNegocio(404, 'Lote não encontrado');
      exigirFilial(req, lote.filial_id);
      const { movimento } = await estoque.retirarDoLote(trx, { lote_id: req.body.lote_id, quantidade, tipo: 'descarte', usuario_id: req.usuario.id, motivo });
      await auditar(trx, req, { acao: 'descarte', tabela: 'movimentacoes', registro_id: movimento.id, filial_id: lote.filial_id, depois: movimento });
      return movimento;
    });
    return res.status(201).json(resultado);
  },

  // POST /estoque/ajustes { lote_id, quantidade (+ sobra / - falta), motivo } — inventário (gestão)
  async ajuste(req, res) {
    exigirCampos(req.body, ['lote_id', 'quantidade', 'motivo']);
    const quantidade = Number(req.body.quantidade);
    if (!Number.isInteger(quantidade) || quantidade === 0) throw new ErroDeNegocio(400, 'quantidade deve ser um inteiro diferente de zero');
    const motivo = exigirMotivo(req.body.motivo);

    const resultado = await knex.transaction(async (trx) => {
      const lote = await trx('lotes').where({ id: req.body.lote_id }).forUpdate().first();
      if (!lote) throw new ErroDeNegocio(404, 'Lote não encontrado');
      exigirFilial(req, lote.filial_id);

      let movimento;
      if (quantidade < 0) {
        ({ movimento } = await estoque.retirarDoLote(trx, { lote_id: lote.id, quantidade: -quantidade, tipo: 'ajuste', usuario_id: req.usuario.id, motivo }));
      } else {
        [movimento] = await trx('movimentacoes').insert({
          filial_id: lote.filial_id, item_id: lote.item_id, lote_id: lote.id, tipo: 'ajuste',
          quantidade, valor_unitario: lote.valor_unitario,
          valor_total: estoque.arredondar(quantidade * lote.valor_unitario),
          motivo, usuario_id: req.usuario.id
        }).returning('*');
      }
      await auditar(trx, req, { acao: 'ajuste', tabela: 'movimentacoes', registro_id: movimento.id, filial_id: lote.filial_id, depois: movimento });
      return movimento;
    });
    return res.status(201).json(resultado);
  },

  // POST /estoque/movimentacoes/:id/estorno { motivo } — desfaz entrada, descarte ou ajuste lançados errado
  async estornar(req, res) {
    const motivo = exigirMotivo(req.body && req.body.motivo);
    const resultado = await knex.transaction(async (trx) => {
      const mov = await trx('movimentacoes').where({ id: req.params.id }).first();
      if (!mov) throw new ErroDeNegocio(404, 'Movimentação não encontrada');
      exigirFilial(req, mov.filial_id);
      if (mov.tipo === 'entrega') throw new ErroDeNegocio(400, 'Entrega se estorna por POST /entregas/:id/estorno');
      if (mov.tipo.startsWith('transferencia')) throw new ErroDeNegocio(400, 'Transferência se desfaz cancelando a transferência');

      const [estorno] = await estoque.estornar(trx, [mov], { usuario_id: req.usuario.id, motivo });
      await auditar(trx, req, { acao: 'estorno', tabela: 'movimentacoes', registro_id: mov.id, filial_id: mov.filial_id, antes: mov, depois: estorno });
      return estorno;
    });
    return res.status(201).json(resultado);
  },

  // PUT /estoque/minimos { filial_id, item_id, minimo } (minimo 0 remove o alerta)
  async definirMinimo(req, res) {
    exigirCampos(req.body, ['filial_id', 'item_id', 'minimo']);
    const { filial_id, item_id } = req.body;
    if (!idValido(filial_id) || !idValido(item_id)) throw new ErroDeNegocio(400, 'filial_id e item_id inválidos');
    exigirFilial(req, filial_id);
    const minimo = Number(req.body.minimo);
    if (!Number.isInteger(minimo) || minimo < 0) throw new ErroDeNegocio(400, 'minimo deve ser um inteiro maior ou igual a zero');

    await knex.transaction(async (trx) => {
      await itemAtivo(trx, item_id);
      const antes = await trx('estoque_minimo').where({ filial_id, item_id }).first();
      if (minimo === 0) {
        await trx('estoque_minimo').where({ filial_id, item_id }).del();
      } else {
        await trx('estoque_minimo').insert({ filial_id, item_id, minimo, updated_at: trx.fn.now() })
          .onConflict(['filial_id', 'item_id']).merge();
      }
      await auditar(trx, req, { acao: 'definir_minimo', tabela: 'estoque_minimo', registro_id: `${filial_id}:${item_id}`, filial_id, antes, depois: { filial_id, item_id, minimo } });
    });
    return res.json({ filial_id: Number(filial_id), item_id: Number(item_id), minimo });
  }
};
