const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { noEscopo, ehAdmin, podeAcessarFilial } = require('../utils/escopo');
const { hoje, somarDias, dataValida } = require('../utils/datas');
const { idValido } = require('../utils/validacao');
const { buscarNoEscopo } = require('./FuncionarioController');

// Funcionário precisa estar visível para o usuário e Ativo para receber EPI
function exigirAptoParaReceber(req, funcionario) {
  const visivel = funcionario.filial_id ? podeAcessarFilial(req, funcionario.filial_id) : ehAdmin(req);
  if (!visivel) throw new ErroDeNegocio(404, 'Funcionário não encontrado');
  if (funcionario.status !== 'Ativo') {
    throw new ErroDeNegocio(409, `Funcionário com status "${funcionario.status}" não pode receber EPI`);
  }
}

module.exports = {
  // Entregas das filiais do usuário. Filtros: ?filial_id=&funcionario_id=&de=AAAA-MM-DD&ate=AAAA-MM-DD
  async index(req, res) {
    const query = noEscopo(knex('entregas'), req, 'funcionarios.filial_id')
      .join('funcionarios', 'funcionarios.id', 'entregas.funcionario_id')
      .join('epis', 'epis.id', 'entregas.epi_id')
      .leftJoin('filiais', 'filiais.id', 'funcionarios.filial_id')
      .select(
        'entregas.id',
        'entregas.funcionario_id',
        'funcionarios.nome as funcionario',
        'funcionarios.matricula',
        'filiais.nome as filial',
        'entregas.epi_id',
        'epis.nome as epi',
        'epis.ca',
        'entregas.data_entrega',
        'entregas.data_proxima_troca',
        'entregas.assinatura_status'
      )
      .orderBy([{ column: 'entregas.data_entrega', order: 'desc' }, { column: 'entregas.id', order: 'desc' }]);
    if (req.query.filial_id) query.where('funcionarios.filial_id', req.query.filial_id);
    if (req.query.funcionario_id) query.where('entregas.funcionario_id', req.query.funcionario_id);
    if (req.query.de) query.where('entregas.data_entrega', '>=', req.query.de);
    if (req.query.ate) query.where('entregas.data_entrega', '<=', req.query.ate);
    return res.json(await query);
  },

  // Registro manual (sem QR) de uma entrega
  async create(req, res) {
    const { funcionario_id, epi_id } = req.body;
    const data_entrega = req.body.data_entrega || hoje();

    if (!idValido(funcionario_id) || !idValido(epi_id)) {
      throw new ErroDeNegocio(400, 'funcionario_id e epi_id são obrigatórios');
    }
    if (!dataValida(data_entrega)) {
      throw new ErroDeNegocio(400, 'data_entrega deve estar no formato AAAA-MM-DD');
    }

    const resultado = await knex.transaction(async (trx) => {
      const funcionario = await buscarNoEscopo(req, funcionario_id, trx);
      exigirAptoParaReceber(req, funcionario);

      const epi = await trx('epis').where({ id: epi_id }).first();
      if (!epi || !epi.ativo) throw new ErroDeNegocio(404, 'EPI não encontrado ou inativo');

      // data_proxima_troca = data_entrega + validade do EPI
      const data_proxima_troca = somarDias(data_entrega, epi.validade_dias);
      const [entrega] = await trx('entregas').insert({
        funcionario_id: funcionario.id,
        epi_id: epi.id,
        data_entrega,
        data_proxima_troca
      }).returning('*');
      await auditar(trx, req, { acao: 'criar', tabela: 'entregas', registro_id: entrega.id, filial_id: funcionario.filial_id, depois: entrega });
      return { data_entrega, data_proxima_troca };
    });

    return res.status(201).json({ message: 'Entrega registrada com sucesso!', ...resultado });
  },

  // Entrega pela leitura do QR do crachá: { token, epi_id, quantidade }
  async createPorQr(req, res) {
    const { token, epi_id } = req.body;
    const quantidade = Number(req.body.quantidade ?? 1);

    if (!token || !idValido(epi_id)) {
      throw new ErroDeNegocio(400, 'token e epi_id são obrigatórios');
    }
    if (!Number.isInteger(quantidade) || quantidade < 1) {
      throw new ErroDeNegocio(400, 'quantidade deve ser um número inteiro maior que zero');
    }

    const resultado = await knex.transaction(async (trx) => {
      const funcionario = await trx('funcionarios')
        .where({ qr_token: String(token) })
        .first('id', 'nome', 'status', 'filial_id');
      if (!funcionario) throw new ErroDeNegocio(404, 'QR code não reconhecido');
      try {
        exigirAptoParaReceber(req, funcionario);
      } catch (e) {
        // Crachá de outra filial: mesma resposta de QR desconhecido
        if (e.status === 404) throw new ErroDeNegocio(404, 'QR code não reconhecido');
        throw e;
      }

      // Trava a linha do EPI até o fim da transação: duas entregas
      // simultâneas do mesmo EPI não conseguem usar o mesmo saldo.
      const epi = await trx('epis').where({ id: epi_id }).forUpdate().first();
      if (!epi || !epi.ativo) throw new ErroDeNegocio(404, 'EPI não encontrado ou inativo');

      const saldo = await saldoDoEpi(trx, epi.id);
      if (saldo < quantidade) {
        throw new ErroDeNegocio(409, `Saldo insuficiente de ${epi.nome}: disponível ${saldo}, solicitado ${quantidade}`);
      }

      const data_entrega = hoje();
      const data_proxima_troca = somarDias(data_entrega, epi.validade_dias);

      const [entrega] = await trx('entregas').insert({
        funcionario_id: funcionario.id,
        epi_id: epi.id,
        data_entrega,
        data_proxima_troca,
        assinatura_status: 'Confirmada via QR'
      }).returning('*');

      await trx('estoque_movimentacao').insert({
        epi_id: epi.id,
        tipo: 'Saída',
        quantidade,
        observacao: `Entrega via QR para ${funcionario.nome}`
      });
      await auditar(trx, req, {
        acao: 'entregar_qr', tabela: 'entregas', registro_id: entrega.id,
        filial_id: funcionario.filial_id, depois: { ...entrega, quantidade }
      });

      return {
        funcionario: funcionario.nome,
        epi: epi.nome,
        quantidade,
        data_entrega,
        data_proxima_troca,
        saldo_restante: saldo - quantidade
      };
    });

    return res.status(201).json({ message: 'Entrega registrada com sucesso!', ...resultado });
  },

  saldoDoEpi
};

// Saldo = soma das Entradas - soma das Saídas (aceita "Saida" sem acento).
// Etapa 2: o saldo passa a ser por filial e por lote.
async function saldoDoEpi(trx, epiId) {
  const linhas = await trx('estoque_movimentacao')
    .where({ epi_id: epiId })
    .select('tipo')
    .sum({ total: 'quantidade' })
    .groupBy('tipo');

  return linhas.reduce((saldo, { tipo, total }) => {
    const t = String(tipo || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (t === 'entrada') return saldo + Number(total);
    if (t === 'saida') return saldo - Number(total);
    return saldo;
  }, 0);
}
