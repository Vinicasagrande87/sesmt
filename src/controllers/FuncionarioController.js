const crypto = require('crypto');
const QRCode = require('qrcode');
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { ehAdmin, noEscopo, exigirFilial, podeAcessarFilial } = require('../utils/escopo');
const { hoje, somarDias, dataValida } = require('../utils/datas');
const { somenteDigitos, cpfValido, pegar, exigirCampos, idValido } = require('../utils/validacao');
const { salvarArquivo } = require('../utils/arquivos');
const { gerarHash } = require('../services/pin');
const { gerarFichaEpi } = require('../relatorios/fichaEpi');

const STATUS = ['Ativo', 'Afastado', 'Desligado'];
const DADOS_PESSOAIS = ['matricula', 'nome', 'cpf', 'data_nascimento', 'data_admissao'];
const LOTACAO = ['filial_id', 'setor_id', 'funcao_id'];

// Consulta base: funcionário com nomes da filial, setor e função atuais
function consultaBase() {
  return knex('funcionarios')
    .leftJoin('filiais', 'filiais.id', 'funcionarios.filial_id')
    .leftJoin('setores', 'setores.id', 'funcionarios.setor_id')
    .leftJoin('funcoes', 'funcoes.id', 'funcionarios.funcao_id')
    .select(
      'funcionarios.id', 'funcionarios.matricula', 'funcionarios.nome', 'funcionarios.cpf',
      'funcionarios.data_nascimento', 'funcionarios.data_admissao', 'funcionarios.data_demissao',
      'funcionarios.status', 'funcionarios.filial_id', 'funcionarios.setor_id', 'funcionarios.funcao_id',
      'filiais.nome as filial',
      knex.raw('coalesce(setores.nome, funcionarios.setor) as setor'),
      knex.raw('coalesce(funcoes.nome, funcionarios.cargo) as funcao')
    );
}

// CPF completo só para quem administra cadastro (admin, gestor e saúde)
function protegerCpf(req, funcionario) {
  if (['admin', 'gestor', 'saude'].includes(req.usuario.perfil) || !funcionario.cpf) return funcionario;
  const d = funcionario.cpf;
  return { ...funcionario, cpf: `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` };
}

function validarDados(dados) {
  if (dados.cpf !== undefined) {
    dados.cpf = somenteDigitos(dados.cpf);
    if (!cpfValido(dados.cpf)) throw new ErroDeNegocio(400, 'CPF inválido');
  }
  for (const campo of ['data_nascimento', 'data_admissao']) {
    if (dados[campo] !== undefined && !dataValida(dados[campo])) {
      throw new ErroDeNegocio(400, `${campo} deve estar no formato AAAA-MM-DD`);
    }
  }
  return dados;
}

// Confere filial (ativa e acessível), setor (da mesma filial) e função (ativa)
async function validarLotacao(trx, req, { filial_id, setor_id, funcao_id }) {
  for (const [campo, valor] of Object.entries({ filial_id, setor_id, funcao_id })) {
    if (!idValido(valor)) throw new ErroDeNegocio(400, `${campo} inválido`);
  }
  exigirFilial(req, filial_id);

  const filial = await trx('filiais').where({ id: filial_id }).first('id', 'ativa');
  if (!filial || !filial.ativa) throw new ErroDeNegocio(400, 'Filial não encontrada ou inativa');

  const setor = await trx('setores').where({ id: setor_id }).first('filial_id', 'ativo');
  if (!setor || !setor.ativo || setor.filial_id !== Number(filial_id)) {
    throw new ErroDeNegocio(400, 'Setor não encontrado, inativo ou de outra filial');
  }

  const funcao = await trx('funcoes').where({ id: funcao_id }).first('ativa');
  if (!funcao || !funcao.ativa) throw new ErroDeNegocio(400, 'Função não encontrada ou inativa');
}

// Busca o funcionário garantindo que o usuário pode vê-lo (404 se não puder: não revela que existe)
async function buscarNoEscopo(req, id, trx = knex) {
  if (!idValido(id)) throw new ErroDeNegocio(404, 'Funcionário não encontrado');
  const funcionario = await trx('funcionarios').where({ id }).first();
  if (!funcionario) throw new ErroDeNegocio(404, 'Funcionário não encontrado');
  const visivel = funcionario.filial_id ? podeAcessarFilial(req, funcionario.filial_id) : ehAdmin(req);
  if (!visivel) throw new ErroDeNegocio(404, 'Funcionário não encontrado');
  return funcionario;
}

module.exports = {
  // Filtros: ?filial_id=1&setor_id=2&status=Ativo&busca=nome ou matrícula
  async index(req, res) {
    const query = noEscopo(consultaBase(), req, 'funcionarios.filial_id').orderBy('funcionarios.nome');
    for (const filtro of ['filial_id', 'setor_id', 'funcao_id', 'status']) {
      if (req.query[filtro]) query.where(`funcionarios.${filtro}`, req.query[filtro]);
    }
    if (req.query.busca) {
      const termo = `%${req.query.busca}%`;
      query.where((q) => q.whereILike('funcionarios.nome', termo).orWhereILike('funcionarios.matricula', termo));
    }
    const funcionarios = await query;
    return res.json(funcionarios.map((f) => protegerCpf(req, f)));
  },

  async show(req, res) {
    const { id } = await buscarNoEscopo(req, req.params.id);
    const funcionario = await consultaBase().where('funcionarios.id', id).first();
    return res.json(protegerCpf(req, funcionario));
  },

  // Cadastro com lotação inicial (filial = CNPJ empregador, setor e função)
  async create(req, res) {
    exigirCampos(req.body, [...DADOS_PESSOAIS, ...LOTACAO]);
    const dados = validarDados(pegar(req.body, DADOS_PESSOAIS));
    const lotacao = pegar(req.body, LOTACAO);

    const funcionario = await knex.transaction(async (trx) => {
      await validarLotacao(trx, req, lotacao);

      const [novo] = await trx('funcionarios').insert({
        ...dados,
        ...lotacao,
        status: 'Ativo',
        qr_token: crypto.randomUUID() // chave do crachá: não contém CPF nem id
      }).returning('*');

      await trx('funcionario_lotacoes').insert({
        funcionario_id: novo.id, ...lotacao, inicio: novo.data_admissao, registrado_por: req.usuario.id
      });
      await auditar(trx, req, { acao: 'criar', tabela: 'funcionarios', registro_id: novo.id, filial_id: novo.filial_id, depois: novo });
      return novo;
    });

    return res.status(201).json({
      message: 'Funcionário cadastrado com sucesso!',
      id: funcionario.id,
      qr_token: funcionario.qr_token
    });
  },

  // Altera dados pessoais, status e/ou lotação.
  // Mudança de filial/setor/função fecha a lotação atual e abre outra a partir de data_mudanca (padrão: hoje).
  // Desligamento: { status: 'Desligado', data_demissao }. O funcionário nunca é apagado.
  async update(req, res) {
    const dados = validarDados(pegar(req.body, DADOS_PESSOAIS));
    const novaLotacao = pegar(req.body, LOTACAO);
    const { status, data_demissao } = req.body;
    const dataMudanca = req.body.data_mudanca || hoje();

    if (status !== undefined && !STATUS.includes(status)) {
      throw new ErroDeNegocio(400, `status deve ser: ${STATUS.join(', ')}`);
    }
    if (!dataValida(dataMudanca)) throw new ErroDeNegocio(400, 'data_mudanca deve estar no formato AAAA-MM-DD');

    const resultado = await knex.transaction(async (trx) => {
      const antes = await buscarNoEscopo(req, req.params.id, trx);
      await trx('funcionarios').where({ id: antes.id }).forUpdate().first('id');
      const alteracoes = { ...dados };

      // Status / desligamento
      if (status !== undefined) {
        alteracoes.status = status;
        if (status === 'Desligado') {
          const dataDemissao = data_demissao || hoje();
          if (!dataValida(dataDemissao)) throw new ErroDeNegocio(400, 'data_demissao deve estar no formato AAAA-MM-DD');
          alteracoes.data_demissao = dataDemissao;
          // Encerra a lotação atual na data do desligamento
          await trx('funcionario_lotacoes')
            .where({ funcionario_id: antes.id }).whereNull('fim')
            .update({ fim: dataDemissao });
        } else {
          alteracoes.data_demissao = null;
        }
      }

      // Lotação: só se algum dos três foi enviado e mudou
      const lotacao = {
        filial_id: Number(novaLotacao.filial_id ?? antes.filial_id),
        setor_id: Number(novaLotacao.setor_id ?? antes.setor_id),
        funcao_id: Number(novaLotacao.funcao_id ?? antes.funcao_id)
      };
      const mudouLotacao = Object.keys(novaLotacao).length > 0 && LOTACAO.some((c) => lotacao[c] !== antes[c]);
      if (mudouLotacao) {
        if (status === 'Desligado') throw new ErroDeNegocio(400, 'Não é possível desligar e mudar a lotação ao mesmo tempo');
        await validarLotacao(trx, req, lotacao); // inclui acesso à filial de destino

        const atual = await trx('funcionario_lotacoes')
          .where({ funcionario_id: antes.id }).whereNull('fim').forUpdate().first();
        if (atual) {
          if (dataMudanca <= atual.inicio) {
            throw new ErroDeNegocio(400, `data_mudanca deve ser posterior ao início da lotação atual (${atual.inicio})`);
          }
          await trx('funcionario_lotacoes').where({ id: atual.id }).update({ fim: somarDias(dataMudanca, -1) });
        }
        await trx('funcionario_lotacoes').insert({
          funcionario_id: antes.id, ...lotacao, inicio: dataMudanca, registrado_por: req.usuario.id
        });
        Object.assign(alteracoes, lotacao);
      } else if (status && status !== 'Desligado' && antes.status === 'Desligado' && antes.filial_id) {
        // Readmissão na mesma lotação: abre um novo período
        await trx('funcionario_lotacoes').insert({
          funcionario_id: antes.id, filial_id: antes.filial_id, setor_id: antes.setor_id,
          funcao_id: antes.funcao_id, inicio: dataMudanca, registrado_por: req.usuario.id
        });
      }

      if (!Object.keys(alteracoes).length) throw new ErroDeNegocio(400, 'Nenhum campo para alterar');

      const [depois] = await trx('funcionarios').where({ id: antes.id })
        .update({ ...alteracoes, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, {
        acao: status === 'Desligado' ? 'desligar' : 'alterar',
        tabela: 'funcionarios', registro_id: antes.id, filial_id: depois.filial_id, antes, depois
      });
      return depois;
    });

    const funcionario = await consultaBase().where('funcionarios.id', resultado.id).first();
    return res.json(protegerCpf(req, funcionario));
  },

  // Histórico de filial/setor/função (prova de qual era a função em cada data)
  async lotacoes(req, res) {
    const funcionario = await buscarNoEscopo(req, req.params.id);
    const historico = await knex('funcionario_lotacoes as l')
      .join('filiais', 'filiais.id', 'l.filial_id')
      .join('setores', 'setores.id', 'l.setor_id')
      .join('funcoes', 'funcoes.id', 'l.funcao_id')
      .leftJoin('usuarios', 'usuarios.id', 'l.registrado_por')
      .where('l.funcionario_id', funcionario.id)
      .orderBy('l.inicio', 'desc')
      .select('l.id', 'l.inicio', 'l.fim', 'filiais.nome as filial', 'filiais.cnpj',
        'setores.nome as setor', 'funcoes.nome as funcao', 'usuarios.nome as registrado_por');
    return res.json(historico);
  },

  // PNG do QR code para imprimir no crachá (conteúdo: apenas o qr_token)
  async qrcode(req, res) {
    const funcionario = await buscarNoEscopo(req, req.params.id);
    const png = await QRCode.toBuffer(funcionario.qr_token, {
      type: 'png',
      width: 400,
      margin: 2,
      errorCorrectionLevel: 'M'
    });
    return res.type('png').send(png);
  },

  // Dados do funcionário a partir do QR + entregas, marcando trocas vencidas
  async buscarPorToken(req, res) {
    const funcionario = await noEscopo(consultaBase(), req, 'funcionarios.filial_id')
      .where('funcionarios.qr_token', req.params.token)
      .select('funcionarios.pin_hash', 'funcionarios.pin_bloqueado_ate', 'funcionarios.termo_adesao_data')
      .first();
    if (!funcionario) throw new ErroDeNegocio(404, 'QR code não reconhecido');

    const linhas = await knex('entregas')
      .join('epis', 'epis.id', 'entregas.epi_id')
      .leftJoin('epi_itens', 'epi_itens.id', 'entregas.item_id')
      .leftJoin('entrega_estornos as est', 'est.entrega_id', 'entregas.id')
      .where('entregas.funcionario_id', funcionario.id)
      .whereNull('est.id') // entrega estornada não conta
      .select(
        'entregas.id',
        'entregas.epi_id',
        'epis.nome as epi',
        'epi_itens.tamanho',
        'entregas.quantidade',
        'entregas.ca_numero',
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
      const atual = !vistos.has(e.epi_id);
      vistos.add(e.epi_id);
      return { ...e, atual, vencida: atual && e.data_proxima_troca < dataHoje };
    });

    const epis_vencidos = entregas
      .filter((e) => e.vencida)
      .map(({ epi_id, epi, data_proxima_troca }) => ({ epi_id, epi, data_proxima_troca }));

    // Para quem leu o QR: sem CPF e sem id interno
    return res.json({
      funcionario: {
        matricula: funcionario.matricula,
        nome: funcionario.nome,
        filial: funcionario.filial,
        setor: funcionario.setor,
        cargo: funcionario.funcao,
        status: funcionario.status,
        filial_id: funcionario.filial_id,
        tem_pin: !!funcionario.pin_hash,
        pin_bloqueado: !!funcionario.pin_bloqueado_ate && new Date(funcionario.pin_bloqueado_ate) > new Date(),
        termo_adesao_data: funcionario.termo_adesao_data
      },
      entregas,
      epis_vencidos
    });
  },

  // POST /funcionarios/qr/:token/pin { pin } — o próprio funcionário cadastra o PIN no aparelho do técnico.
  // Só funciona se ainda não houver PIN: para trocar, a gestão reseta antes.
  async cadastrarPinPorQr(req, res) {
    const hash = await gerarHash(req.body && req.body.pin);
    await knex.transaction(async (trx) => {
      const funcionario = await trx('funcionarios').where({ qr_token: String(req.params.token) }).forUpdate().first('id', 'filial_id', 'pin_hash');
      const visivel = funcionario && (funcionario.filial_id ? podeAcessarFilial(req, funcionario.filial_id) : ehAdmin(req));
      if (!visivel) throw new ErroDeNegocio(404, 'QR code não reconhecido');
      if (funcionario.pin_hash) throw new ErroDeNegocio(409, 'Este funcionário já tem PIN. Para trocar, peça à gestão para resetar.');
      await trx('funcionarios').where({ id: funcionario.id })
        .update({ pin_hash: hash, pin_definido_em: trx.fn.now(), pin_falhas: 0, pin_bloqueado_ate: null });
      await auditar(trx, req, { acao: 'cadastrar_pin', tabela: 'funcionarios', registro_id: funcionario.id, filial_id: funcionario.filial_id });
    });
    return res.status(201).json({ message: 'PIN cadastrado' });
  },

  // DELETE /funcionarios/:id/pin — gestão reseta (esqueceu o PIN / suspeita de que outra pessoa sabe)
  async resetarPin(req, res) {
    await knex.transaction(async (trx) => {
      const funcionario = await buscarNoEscopo(req, req.params.id, trx);
      await trx('funcionarios').where({ id: funcionario.id })
        .update({ pin_hash: null, pin_definido_em: null, pin_falhas: 0, pin_bloqueado_ate: null });
      await auditar(trx, req, { acao: 'resetar_pin', tabela: 'funcionarios', registro_id: funcionario.id, filial_id: funcionario.filial_id });
    });
    return res.status(204).send();
  },

  // POST /funcionarios/:id/termo { data: 'AAAA-MM-DD', arquivo: base64 (PDF ou foto do termo assinado) }
  async registrarTermo(req, res) {
    const { data, arquivo } = req.body || {};
    if (!data || !dataValida(data)) throw new ErroDeNegocio(400, 'data deve estar no formato AAAA-MM-DD');
    if (data > hoje()) throw new ErroDeNegocio(400, 'data do termo não pode ser futura');
    if (!arquivo) throw new ErroDeNegocio(400, 'Envie o termo assinado (PDF ou imagem) em arquivo');

    const resultado = await knex.transaction(async (trx) => {
      const funcionario = await buscarNoEscopo(req, req.params.id, trx);
      const salvo = await salvarArquivo(trx, req, {
        base64: arquivo, contexto: 'termo_adesao', tipos: ['application/pdf', 'image/jpeg', 'image/png'],
        maxBytes: 10 * 1024 * 1024, filial_id: funcionario.filial_id, funcionario_id: funcionario.id,
        nome: `termo-adesao-${funcionario.matricula}.${salvo_ext(arquivo)}`
      });
      await trx('funcionarios').where({ id: funcionario.id })
        .update({ termo_adesao_data: data, termo_adesao_arquivo_id: salvo.id, updated_at: trx.fn.now() });
      await auditar(trx, req, {
        acao: 'registrar_termo', tabela: 'funcionarios', registro_id: funcionario.id, filial_id: funcionario.filial_id,
        antes: { termo_adesao_data: funcionario.termo_adesao_data, termo_adesao_arquivo_id: funcionario.termo_adesao_arquivo_id },
        depois: { termo_adesao_data: data, termo_adesao_arquivo_id: salvo.id, sha256: salvo.sha256 }
      });
      return { termo_adesao_data: data, arquivo_id: salvo.id, sha256: salvo.sha256 };
    });
    return res.status(201).json(resultado);
  },

  // GET /funcionarios/:id/ficha-epi — PDF da ficha de EPI (NR-6)
  async fichaEpi(req, res) {
    const base = await buscarNoEscopo(req, req.params.id);
    const funcionario = await consultaBase().where('funcionarios.id', base.id)
      .select('funcionarios.termo_adesao_data').first();

    // Empregador = filial (CNPJ) atual; funcionário antigo sem filial usa dados genéricos
    const empregador = base.filial_id
      ? await knex('filiais').where({ id: base.filial_id }).first()
      : { nome: 'Não informado', cnpj: '', cidade: '', uf: '' };

    const entregas = await knex('entregas')
      .join('epis', 'epis.id', 'entregas.epi_id')
      .leftJoin('epi_itens', 'epi_itens.id', 'entregas.item_id')
      .leftJoin('entrega_estornos as est', 'est.entrega_id', 'entregas.id')
      .where('entregas.funcionario_id', base.id)
      .orderBy([{ column: 'entregas.data_entrega' }, { column: 'entregas.id' }])
      .select('entregas.*', 'epis.nome as epi', 'epi_itens.tamanho', knex.raw('(est.id is not null) as estornada'));

    const pdf = gerarFichaEpi({
      empregador,
      funcionario: { ...funcionario, cpf: base.cpf },
      entregas,
      emitidoPor: req.usuario.nome,
      mostrarCpfCompleto: ['admin', 'gestor', 'saude'].includes(req.usuario.perfil),
      urlVerificacao: `${req.protocol}://${req.get('host')}/verificar/`
    });
    await auditar(knex, req, { acao: 'emitir_ficha_epi', tabela: 'funcionarios', registro_id: base.id, filial_id: base.filial_id });

    res.type('application/pdf');
    res.set('Content-Disposition', `inline; filename="ficha-epi-${base.matricula}.pdf"`);
    pdf.pipe(res);
  },

  buscarNoEscopo
};

// Extensão do arquivo pelo prefixo data: (só para o nome do arquivo)
function salvo_ext(base64) {
  const m = /^data:([^;]+);/.exec(base64 || '');
  if (!m) return 'bin';
  return { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }[m[1]] || 'bin';
}
