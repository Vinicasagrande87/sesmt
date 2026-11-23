// Entrega de EPI com comprovação: QR do crachá + PIN pessoal (+ foto opcional), CA vigente copiado,
// técnico, IP, aparelho, hora do servidor e código de verificação. Baixa no estoque por PEPS.
// A entrega nunca é editada nem apagada: erro se corrige com estorno.
const crypto = require('crypto');
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { noEscopo, ehAdmin, podeAcessarFilial, exigirFilial } = require('../utils/escopo');
const { hoje, somarDias } = require('../utils/datas');
const { idValido } = require('../utils/validacao');
const { salvarArquivo } = require('../utils/arquivos');
const { caVigente, itemAtivo } = require('../services/epi');
const { conferirPin } = require('../services/pin');
const estoque = require('../services/estoque');
const { buscarNoEscopo } = require('./FuncionarioController');

const MOTIVOS = {
  primeira_entrega: 'Primeira entrega',
  troca_periodica: 'Troca periódica',
  desgaste: 'Desgaste/dano',
  perda: 'Perda/extravio',
  outro: 'Outro'
};
const FOTO_MAX_BYTES = 2 * 1024 * 1024;
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O e 1/I/L, para não confundir

function gerarCodigo() {
  let codigo = '';
  for (let i = 0; i < 8; i++) codigo += ALFABETO[crypto.randomInt(ALFABETO.length)];
  return codigo;
}

function validarPedido(body) {
  if (!idValido(body.item_id)) throw new ErroDeNegocio(400, 'item_id é obrigatório');
  const quantidade = Number(body.quantidade ?? 1);
  if (!Number.isInteger(quantidade) || quantidade < 1) throw new ErroDeNegocio(400, 'quantidade deve ser um número inteiro maior que zero');
  const motivo = body.motivo || 'troca_periodica';
  if (!MOTIVOS[motivo]) throw new ErroDeNegocio(400, `motivo deve ser: ${Object.keys(MOTIVOS).join(', ')}`);
  if (motivo === 'outro' && !body.observacao) throw new ErroDeNegocio(400, 'Para motivo "outro", descreva na observação');
  return { item_id: Number(body.item_id), quantidade, motivo };
}

// Grava a entrega + baixa PEPS + auditoria. Usado pelo QR e pelo registro manual.
async function registrarEntrega(trx, req, { funcionario, item_id, quantidade, motivo, metodo, pinValidado, fotoBase64, observacao }) {
  if (funcionario.status !== 'Ativo') {
    throw new ErroDeNegocio(409, `Funcionário com status "${funcionario.status}" não pode receber EPI`);
  }
  if (!funcionario.filial_id) throw new ErroDeNegocio(409, 'Funcionário sem filial: atualize o cadastro antes de entregar');

  const item = await itemAtivo(trx, item_id);
  const ca = await caVigente(trx, item.epi_id);

  let foto = null;
  if (fotoBase64) {
    foto = await salvarArquivo(trx, req, {
      base64: fotoBase64, contexto: 'foto_entrega', tipos: ['image/jpeg', 'image/png', 'image/webp'],
      maxBytes: FOTO_MAX_BYTES, filial_id: funcionario.filial_id, funcionario_id: funcionario.id
    });
  }

  const data_entrega = hoje();
  const [entrega] = await trx('entregas').insert({
    funcionario_id: funcionario.id,
    epi_id: item.epi_id,
    item_id: item.id,
    filial_id: funcionario.filial_id,
    setor_id: funcionario.setor_id,
    funcao_id: funcionario.funcao_id,
    quantidade,
    motivo,
    ca_numero: ca.numero,
    ca_validade: ca.validade,
    data_entrega,
    data_hora: trx.fn.now(),
    data_proxima_troca: somarDias(data_entrega, item.validade_dias),
    usuario_id: req.usuario.id,
    metodo_assinatura: metodo,
    assinatura_status: metodo === 'qr_pin' ? 'Confirmada via QR + PIN' : 'Registro manual',
    pin_validado: pinValidado,
    termo_adesao_vigente: !!funcionario.termo_adesao_data,
    foto_arquivo_id: foto ? foto.id : null,
    ip: req.ip || null,
    user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
    codigo_verificacao: gerarCodigo(),
    observacao: observacao || null
  }).returning('*');

  const { custo_total } = await estoque.consumirPEPS(trx, {
    filial_id: funcionario.filial_id, item_id: item.id, quantidade, tipo: 'entrega',
    usuario_id: req.usuario.id, entrega_id: entrega.id, motivo: `Entrega #${entrega.id}`
  });
  // Ainda dentro da mesma transação da criação: completa o custo calculado pelo PEPS
  await trx('entregas').where({ id: entrega.id }).update({ custo_total });

  await auditar(trx, req, {
    acao: metodo === 'qr_pin' ? 'entregar_qr' : 'entregar_manual', tabela: 'entregas',
    registro_id: entrega.id, filial_id: funcionario.filial_id, depois: { ...entrega, custo_total }
  });

  return {
    id: entrega.id,
    codigo_verificacao: entrega.codigo_verificacao,
    funcionario: funcionario.nome,
    epi: item.nome,
    tamanho: item.tamanho,
    quantidade,
    motivo,
    ca: { numero: ca.numero, validade: ca.validade },
    data_entrega,
    data_proxima_troca: entrega.data_proxima_troca,
    termo_adesao_vigente: entrega.termo_adesao_vigente,
    foto: !!foto,
    custo_total
  };
}

module.exports = {
  MOTIVOS,

  // GET /entregas?filial_id=&funcionario_id=&de=&ate=&incluir_estornadas=true
  async index(req, res) {
    const filialDaEntrega = knex.raw('coalesce(entregas.filial_id, funcionarios.filial_id)');
    const query = knex('entregas')
      .join('funcionarios', 'funcionarios.id', 'entregas.funcionario_id')
      .join('epis', 'epis.id', 'entregas.epi_id')
      .leftJoin('epi_itens', 'epi_itens.id', 'entregas.item_id')
      .leftJoin('filiais', 'filiais.id', filialDaEntrega)
      .leftJoin('usuarios', 'usuarios.id', 'entregas.usuario_id')
      .leftJoin('entrega_estornos as est', 'est.entrega_id', 'entregas.id')
      .select(
        'entregas.id', 'entregas.funcionario_id', 'funcionarios.nome as funcionario', 'funcionarios.matricula',
        'filiais.nome as filial', 'entregas.epi_id', 'epis.nome as epi', 'epi_itens.tamanho',
        'entregas.quantidade', 'entregas.motivo', 'entregas.ca_numero', 'entregas.ca_validade',
        'entregas.data_entrega', 'entregas.data_hora', 'entregas.data_proxima_troca',
        'entregas.metodo_assinatura', 'entregas.assinatura_status', 'entregas.codigo_verificacao',
        'entregas.custo_total', 'usuarios.nome as entregue_por',
        knex.raw('(est.id is not null) as estornada'), 'est.motivo as estorno_motivo'
      )
      .orderBy([{ column: 'entregas.data_entrega', order: 'desc' }, { column: 'entregas.id', order: 'desc' }]);
    if (!ehAdmin(req)) query.whereIn(filialDaEntrega, req.usuario.filiais);
    if (req.query.filial_id) query.where(filialDaEntrega, req.query.filial_id);
    if (req.query.funcionario_id) query.where('entregas.funcionario_id', req.query.funcionario_id);
    if (req.query.de) query.where('entregas.data_entrega', '>=', req.query.de);
    if (req.query.ate) query.where('entregas.data_entrega', '<=', req.query.ate);
    if (req.query.incluir_estornadas !== 'true') query.whereNull('est.id');
    return res.json(await query);
  },

  // POST /entregas/qr { token, pin, item_id, quantidade?, motivo?, foto?, observacao? }
  async createPorQr(req, res) {
    const { token, pin, foto, observacao } = req.body || {};
    if (!token) throw new ErroDeNegocio(400, 'token é obrigatório');
    const pedido = validarPedido(req.body);

    const funcionario = await knex('funcionarios').where({ qr_token: String(token) }).first();
    const visivel = funcionario && (funcionario.filial_id ? podeAcessarFilial(req, funcionario.filial_id) : ehAdmin(req));
    if (!visivel) throw new ErroDeNegocio(404, 'QR code não reconhecido'); // crachá de outra filial = desconhecido

    await conferirPin(funcionario.id, pin);

    const resultado = await knex.transaction(async (trx) => {
      const atual = await trx('funcionarios').where({ id: funcionario.id }).forUpdate().first();
      return registrarEntrega(trx, req, {
        funcionario: atual, ...pedido, metodo: 'qr_pin', pinValidado: true, fotoBase64: foto, observacao
      });
    });
    return res.status(201).json({ message: 'Entrega registrada com sucesso!', ...resultado });
  },

  // POST /entregas { funcionario_id, item_id, quantidade?, motivo?, observacao } — sem QR/PIN (gestão), exige justificativa
  async create(req, res) {
    const { funcionario_id, observacao, foto } = req.body || {};
    if (!observacao || String(observacao).trim().length < 10) {
      throw new ErroDeNegocio(400, 'Entrega sem QR/PIN exige justificativa na observação (pelo menos 10 caracteres)');
    }
    const pedido = validarPedido(req.body);
    const resultado = await knex.transaction(async (trx) => {
      const funcionario = await buscarNoEscopo(req, funcionario_id, trx);
      await trx('funcionarios').where({ id: funcionario.id }).forUpdate().first('id');
      return registrarEntrega(trx, req, {
        funcionario, ...pedido, metodo: 'manual', pinValidado: false, fotoBase64: foto, observacao: String(observacao).trim()
      });
    });
    return res.status(201).json({ message: 'Entrega registrada (manual)', ...resultado });
  },

  // POST /entregas/:id/estorno { motivo } — o EPI volta para os mesmos lotes, com o mesmo custo
  async estornar(req, res) {
    const motivo = req.body && req.body.motivo;
    if (!motivo || String(motivo).trim().length < 5) throw new ErroDeNegocio(400, 'Informe o motivo do estorno (pelo menos 5 caracteres)');

    const resultado = await knex.transaction(async (trx) => {
      const entrega = await trx('entregas').where({ id: req.params.id }).forUpdate().first();
      if (!entrega) throw new ErroDeNegocio(404, 'Entrega não encontrada');
      if (!entrega.filial_id) throw new ErroDeNegocio(409, 'Entrega antiga (sem estoque por filial) não pode ser estornada');
      exigirFilial(req, entrega.filial_id);
      if (await trx('entrega_estornos').where({ entrega_id: entrega.id }).first('id')) {
        throw new ErroDeNegocio(409, 'Esta entrega já foi estornada');
      }

      const movimentos = await trx('movimentacoes').where({ entrega_id: entrega.id, tipo: 'entrega' });
      await estoque.estornar(trx, movimentos, { usuario_id: req.usuario.id, motivo: `Estorno da entrega #${entrega.id}: ${motivo}` });
      const [estorno] = await trx('entrega_estornos')
        .insert({ entrega_id: entrega.id, motivo: String(motivo).trim(), usuario_id: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'estornar', tabela: 'entregas', registro_id: entrega.id, filial_id: entrega.filial_id, antes: entrega, depois: estorno });
      return estorno;
    });
    return res.status(201).json(resultado);
  },

  // GET /entregas/:id/foto
  async foto(req, res) {
    const entrega = await knex('entregas').where({ id: req.params.id }).first('filial_id', 'foto_arquivo_id');
    if (!entrega || !entrega.foto_arquivo_id || !entrega.filial_id || !podeAcessarFilial(req, entrega.filial_id)) {
      throw new ErroDeNegocio(404, 'Foto não encontrada');
    }
    const arquivo = await knex('arquivos').where({ id: entrega.foto_arquivo_id }).first('tipo_mime', 'conteudo', 'sha256');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Arquivo-SHA256', arquivo.sha256);
    return res.type(arquivo.tipo_mime).send(arquivo.conteudo);
  },

  // GET /verificar/:codigo — público: confirma que uma entrega existe, com o mínimo de dados pessoais
  async verificar(req, res) {
    const codigo = String(req.params.codigo || '').toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(codigo)) return res.status(404).json({ valida: false });
    const e = await knex('entregas')
      .join('funcionarios as f', 'f.id', 'entregas.funcionario_id')
      .join('epis', 'epis.id', 'entregas.epi_id')
      .leftJoin('epi_itens as i', 'i.id', 'entregas.item_id')
      .leftJoin('filiais as fi', 'fi.id', 'entregas.filial_id')
      .leftJoin('entrega_estornos as est', 'est.entrega_id', 'entregas.id')
      .where('entregas.codigo_verificacao', codigo)
      .first('entregas.data_hora', 'entregas.quantidade', 'entregas.ca_numero', 'entregas.metodo_assinatura',
        'epis.nome as epi', 'i.tamanho', 'fi.nome as filial', 'f.nome as funcionario', 'est.created_at as estornada_em');
    if (!e) return res.status(404).json({ valida: false });

    const iniciais = e.funcionario.split(/\s+/).filter(Boolean).map((p) => `${p[0].toUpperCase()}.`).join(' ');
    return res.json({
      valida: true,
      codigo,
      data_hora: e.data_hora,
      epi: e.tamanho && e.tamanho !== 'Único' ? `${e.epi} (${e.tamanho})` : e.epi,
      quantidade: e.quantidade,
      ca: e.ca_numero,
      filial: e.filial,
      funcionario: iniciais,
      assinatura: e.metodo_assinatura === 'qr_pin' ? 'Crachá QR + PIN pessoal' : 'Registro manual',
      estornada: !!e.estornada_em
    });
  }
};
