const knex = require('../database/db');
const { hoje, somarDias, dataValida } = require('../utils/datas');

module.exports = {
  // Listar todas as entregas realizadas
  // Aqui usamos um "join" para mostrar nomes em vez de apenas IDs
  async index(req, res) {
    try {
      const entregas = await knex('entregas')
        .join('funcionarios', 'funcionarios.id', '=', 'entregas.funcionario_id')
        .join('epis', 'epis.id', '=', 'entregas.epi_id')
        .select(
          'entregas.id',
          'funcionarios.nome as funcionario',
          'epis.nome as epi',
          'entregas.data_entrega'
        );
      
      return res.json(entregas);
    } catch (error) {
      return res.status(500).json({ error: 'Erro ao listar entregas' });
    }
  },

  // Registrar uma nova entrega de EPI
  async create(req, res) {
    try {
      const { funcionario_id, epi_id } = req.body;
      const data_entrega = req.body.data_entrega || hoje();

      if (!funcionario_id || !epi_id) {
        return res.status(400).json({ error: 'funcionario_id e epi_id são obrigatórios' });
      }
      if (!dataValida(data_entrega)) {
        return res.status(400).json({ error: 'data_entrega deve estar no formato AAAA-MM-DD' });
      }

      const epi = await knex('epis').where({ id: epi_id }).first();
      if (!epi) {
        return res.status(404).json({ error: 'EPI não encontrado' });
      }

      // data_proxima_troca = data_entrega + validade do EPI
      const data_proxima_troca = somarDias(data_entrega, epi.validade_dias);

      await knex('entregas').insert({
        funcionario_id,
        epi_id,
        data_entrega,
        data_proxima_troca
      });

      return res.status(201).json({ message: 'Entrega registrada com sucesso!', data_entrega, data_proxima_troca });
    } catch (error) {
      console.error(error);
      return res.status(400).json({ error: 'Erro ao registrar entrega' });
    }
  },

  // Entrega pela leitura do QR do crachá: { token, epi_id, quantidade }
  async createPorQr(req, res) {
    const { token, epi_id } = req.body;
    const quantidade = Number(req.body.quantidade ?? 1);

    if (!token || !epi_id) {
      return res.status(400).json({ error: 'token e epi_id são obrigatórios' });
    }
    if (!Number.isInteger(quantidade) || quantidade < 1) {
      return res.status(400).json({ error: 'quantidade deve ser um número inteiro maior que zero' });
    }

    try {
      const resultado = await knex.transaction(async (trx) => {
        const funcionario = await trx('funcionarios')
          .where({ qr_token: token })
          .first('id', 'nome', 'status');
        if (!funcionario) throw new ErroDeNegocio(404, 'QR code não reconhecido');
        if (funcionario.status !== 'Ativo') {
          throw new ErroDeNegocio(409, `Funcionário com status "${funcionario.status}" não pode receber EPI`);
        }

        // Trava a linha do EPI até o fim da transação: duas entregas
        // simultâneas do mesmo EPI não conseguem usar o mesmo saldo.
        const epi = await trx('epis').where({ id: epi_id }).forUpdate().first();
        if (!epi) throw new ErroDeNegocio(404, 'EPI não encontrado');

        const saldo = await saldoDoEpi(trx, epi.id);
        if (saldo < quantidade) {
          throw new ErroDeNegocio(409, `Saldo insuficiente de ${epi.nome}: disponível ${saldo}, solicitado ${quantidade}`);
        }

        const data_entrega = hoje();
        const data_proxima_troca = somarDias(data_entrega, epi.validade_dias);

        await trx('entregas').insert({
          funcionario_id: funcionario.id,
          epi_id: epi.id,
          data_entrega,
          data_proxima_troca,
          assinatura_status: 'Confirmada via QR'
        });

        await trx('estoque_movimentacao').insert({
          epi_id: epi.id,
          tipo: 'Saída',
          quantidade,
          observacao: `Entrega via QR para ${funcionario.nome}`
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
    } catch (error) {
      if (error instanceof ErroDeNegocio) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error(error);
      return res.status(500).json({ error: 'Erro ao registrar entrega' });
    }
  }
};

// Erro esperado (regra de negócio): desfaz a transação e vira resposta 4xx
class ErroDeNegocio extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Saldo = soma das Entradas - soma das Saídas (aceita "Saida" sem acento)
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