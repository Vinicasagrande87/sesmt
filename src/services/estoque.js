// Regras do estoque. Todas as funções recebem a transação (trx) de quem chama.
//
// - O saldo de um lote é a soma das movimentações dele (nunca um campo editável).
// - Saídas consomem os lotes mais antigos primeiro (PEPS), cada parte com o preço do seu lote.
// - Lotes vencidos não são usados em entregas: precisam ser descartados.
// - Antes de calcular saldo para uma saída, os lotes do item na filial são travados (FOR UPDATE),
//   então duas operações simultâneas não conseguem usar o mesmo saldo.
const { ErroDeNegocio } = require('../utils/erros');
const { hoje } = require('../utils/datas');

const TIPOS_SAIDA = ['entrega', 'descarte', 'ajuste', 'transferencia_saida'];

function arredondar(valor) {
  return Math.round(valor * 100) / 100;
}

// Lotes do item na filial com o saldo de cada um, do mais antigo para o mais novo (travados)
async function lotesComSaldo(trx, { filial_id, item_id, incluirVencidos = false }) {
  const lotes = await trx('lotes')
    .where({ filial_id, item_id })
    .orderBy([{ column: 'data_entrada' }, { column: 'id' }])
    .forUpdate()
    .select('id', 'valor_unitario', 'data_validade', 'data_entrada');
  if (!lotes.length) return [];

  const saldos = await trx('movimentacoes')
    .whereIn('lote_id', lotes.map((l) => l.id))
    .groupBy('lote_id')
    .select('lote_id')
    .sum({ saldo: 'quantidade' });
  const saldoPorLote = new Map(saldos.map((s) => [s.lote_id, Number(s.saldo)]));

  const dataHoje = hoje();
  return lotes
    .map((l) => ({ ...l, saldo: saldoPorLote.get(l.id) || 0, vencido: !!l.data_validade && l.data_validade < dataHoje }))
    .filter((l) => l.saldo > 0 && (incluirVencidos || !l.vencido));
}

async function saldoDisponivel(trx, { filial_id, item_id }) {
  const lotes = await lotesComSaldo(trx, { filial_id, item_id });
  return lotes.reduce((total, l) => total + l.saldo, 0);
}

// Retira 'quantidade' do item na filial usando PEPS. Grava uma movimentação por lote usado.
// Devolve { movimentos, custo_total }.
async function consumirPEPS(trx, { filial_id, item_id, quantidade, tipo, usuario_id, entrega_id, transferencia_id, motivo }) {
  if (!TIPOS_SAIDA.includes(tipo)) throw new Error(`tipo de saída inválido: ${tipo}`);

  const lotes = await lotesComSaldo(trx, { filial_id, item_id });
  const disponivel = lotes.reduce((total, l) => total + l.saldo, 0);
  if (disponivel < quantidade) {
    throw new ErroDeNegocio(409, `Saldo insuficiente: disponível ${disponivel}, solicitado ${quantidade}`, { disponivel });
  }

  const movimentos = [];
  let falta = quantidade;
  for (const lote of lotes) {
    if (falta === 0) break;
    const usar = Math.min(falta, lote.saldo);
    movimentos.push({
      filial_id,
      item_id,
      lote_id: lote.id,
      tipo,
      quantidade: -usar,
      valor_unitario: lote.valor_unitario,
      valor_total: -arredondar(usar * lote.valor_unitario),
      entrega_id: entrega_id || null,
      transferencia_id: transferencia_id || null,
      motivo: motivo || null,
      usuario_id
    });
    falta -= usar;
  }

  const gravados = await trx('movimentacoes').insert(movimentos).returning('*');
  const custo_total = arredondar(-gravados.reduce((total, m) => total + m.valor_total, 0));
  return { movimentos: gravados, custo_total };
}

// Retira de um lote específico (descarte de lote vencido, ajuste de inventário)
async function retirarDoLote(trx, { lote_id, quantidade, tipo, usuario_id, motivo }) {
  const lote = await trx('lotes').where({ id: lote_id }).forUpdate().first();
  if (!lote) throw new ErroDeNegocio(404, 'Lote não encontrado');
  const { saldo } = await trx('movimentacoes').where({ lote_id }).sum({ saldo: 'quantidade' }).first();
  if (Number(saldo || 0) < quantidade) {
    throw new ErroDeNegocio(409, `Saldo insuficiente no lote: disponível ${Number(saldo || 0)}`);
  }
  const [mov] = await trx('movimentacoes').insert({
    filial_id: lote.filial_id,
    item_id: lote.item_id,
    lote_id,
    tipo,
    quantidade: -quantidade,
    valor_unitario: lote.valor_unitario,
    valor_total: -arredondar(quantidade * lote.valor_unitario),
    motivo,
    usuario_id
  }).returning('*');
  return { lote, movimento: mov };
}

// Cria um lote e a movimentação de entrada
async function registrarEntrada(trx, dados, { usuario_id, tipo = 'entrada', transferencia_id = null, motivo = null }) {
  const [lote] = await trx('lotes').insert({ ...dados, criado_por: usuario_id }).returning('*');
  const [movimento] = await trx('movimentacoes').insert({
    filial_id: lote.filial_id,
    item_id: lote.item_id,
    lote_id: lote.id,
    tipo,
    quantidade: lote.quantidade_inicial,
    valor_unitario: lote.valor_unitario,
    valor_total: arredondar(lote.quantidade_inicial * lote.valor_unitario),
    transferencia_id,
    motivo,
    usuario_id
  }).returning('*');
  return { lote, movimento };
}

// Estorna movimentações: cria o lançamento contrário de cada uma (mesmo lote, mesmo valor).
// Se o estorno tirar do lote (estorno de entrada), confere o saldo do lote antes.
async function estornar(trx, movimentos, { usuario_id, motivo }) {
  const estornos = [];
  for (const m of movimentos) {
    if (m.tipo === 'estorno') throw new ErroDeNegocio(400, 'Não é possível estornar um estorno');
    const ja = await trx('movimentacoes').where({ estorno_de_id: m.id }).first('id');
    if (ja) throw new ErroDeNegocio(409, 'Esta movimentação já foi estornada');

    if (m.quantidade > 0) {
      await trx('lotes').where({ id: m.lote_id }).forUpdate().first('id');
      const { saldo } = await trx('movimentacoes').where({ lote_id: m.lote_id }).sum({ saldo: 'quantidade' }).first();
      if (Number(saldo || 0) < m.quantidade) {
        throw new ErroDeNegocio(409, `Não dá para estornar: parte do lote já foi usada (saldo ${Number(saldo || 0)} de ${m.quantidade})`);
      }
    }

    const [estorno] = await trx('movimentacoes').insert({
      filial_id: m.filial_id,
      item_id: m.item_id,
      lote_id: m.lote_id,
      tipo: 'estorno',
      quantidade: -m.quantidade,
      valor_unitario: m.valor_unitario,
      valor_total: -m.valor_total,
      entrega_id: m.entrega_id,
      transferencia_id: m.transferencia_id,
      estorno_de_id: m.id,
      motivo,
      usuario_id
    }).returning('*');
    estornos.push(estorno);
  }
  return estornos;
}

module.exports = { lotesComSaldo, saldoDisponivel, consumirPEPS, retirarDoLote, registrarEntrada, estornar, arredondar };
