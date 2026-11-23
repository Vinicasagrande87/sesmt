const crypto = require('crypto');
const QRCode = require('qrcode');
const knex = require('../database/db');
const { hoje, paraISO } = require('../utils/datas');

const CAMPOS_OBRIGATORIOS = ['matricula', 'nome', 'cpf', 'data_nascimento', 'cargo', 'setor', 'data_admissao'];

module.exports = {
  // Listar todos os funcionários
  async index(req, res) {
    try {
      const funcionarios = await knex('funcionarios').select('*');
      return res.json(funcionarios);
    } catch (error) {
      return res.status(500).json({ error: 'Erro ao buscar funcionários' });
    }
  },

  // Cadastrar um novo funcionário
  async create(req, res) {
    try {
      const { matricula, nome, cpf, data_nascimento, cargo, setor, data_admissao, status } = req.body;

      const faltando = CAMPOS_OBRIGATORIOS.filter((campo) => !req.body[campo]);
      if (faltando.length) {
        return res.status(400).json({ error: 'Campos obrigatórios ausentes', campos: faltando });
      }

      // Chave aleatória do crachá: não contém CPF nem id
      const qr_token = crypto.randomUUID();

      await knex('funcionarios').insert({
        matricula,
        nome,
        cpf,
        data_nascimento,
        cargo,
        setor,
        data_admissao,
        status: status || 'Ativo',
        qr_token
      });

      return res.status(201).json({ message: 'Funcionário cadastrado com sucesso!', qr_token });
    } catch (error) {
      console.error(error);
      return res.status(400).json({ error: 'Erro ao cadastrar funcionário' });
    }
  },

  // PNG do QR code para imprimir no crachá (conteúdo: apenas o qr_token)
  async qrcode(req, res) {
    try {
      const funcionario = await knex('funcionarios')
        .where({ id: req.params.id })
        .first('qr_token');

      if (!funcionario) {
        return res.status(404).json({ error: 'Funcionário não encontrado' });
      }

      const png = await QRCode.toBuffer(funcionario.qr_token, {
        type: 'png',
        width: 400,
        margin: 2,
        errorCorrectionLevel: 'M'
      });

      return res.type('png').send(png);
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Erro ao gerar QR code' });
    }
  },

  // Dados do funcionário a partir do QR + entregas, marcando trocas vencidas
  async buscarPorToken(req, res) {
    try {
      const funcionario = await knex('funcionarios')
        .where({ qr_token: req.params.token })
        .first('id', 'matricula', 'nome', 'cargo', 'setor', 'status'); // sem CPF

      if (!funcionario) {
        return res.status(404).json({ error: 'QR code não reconhecido' });
      }

      const linhas = await knex('entregas')
        .join('epis', 'epis.id', 'entregas.epi_id')
        .where('entregas.funcionario_id', funcionario.id)
        .select(
          'entregas.id',
          'entregas.epi_id',
          'epis.nome as epi',
          'epis.ca',
          'entregas.data_entrega',
          'entregas.data_proxima_troca',
          'entregas.assinatura_status'
        )
        .orderBy([{ column: 'entregas.data_entrega', order: 'desc' }, { column: 'entregas.id', order: 'desc' }]);

      // Só a entrega mais recente de cada EPI conta: se ele já recebeu
      // um novo, a entrega antiga não está mais "vencida".
      const dataHoje = hoje();
      const vistos = new Set();
      const entregas = linhas.map((e) => {
        const data_entrega = paraISO(e.data_entrega);
        const data_proxima_troca = paraISO(e.data_proxima_troca);
        const atual = !vistos.has(e.epi_id);
        vistos.add(e.epi_id);
        return {
          ...e,
          data_entrega,
          data_proxima_troca,
          atual,
          vencida: atual && data_proxima_troca < dataHoje
        };
      });

      const epis_vencidos = entregas
        .filter((e) => e.vencida)
        .map(({ epi_id, epi, data_proxima_troca }) => ({ epi_id, epi, data_proxima_troca }));

      // Não devolvemos o id interno para quem leu o QR
      const { id, ...dados } = funcionario;
      return res.json({ funcionario: dados, entregas, epis_vencidos });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Erro ao buscar funcionário' });
    }
  },

  // Deletar um funcionário pelo ID
  async delete(req, res) {
    try {
      const { id } = req.params;

      await knex('funcionarios')
        .where({ id })
        .del();

      return res.status(204).send();
    } catch (error) {
      return res.status(400).json({ error: 'Erro ao deletar funcionário' });
    }
  }
};
