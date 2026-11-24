// Painel de conformidade (semáforo) e relatórios em PDF/Excel, hoje ou "como estava" numa data-base.
// Cada relatório emitido fica registrado com código de verificação, SHA-256 do conteúdo e do arquivo.
const crypto = require('crypto');
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { ehAdmin, noEscopo } = require('../utils/escopo');
const { hoje } = require('../utils/datas');
const { idValido } = require('../utils/validacao');
const { gerarCodigo } = require('../utils/codigo');
const { lerDataBase, lerDias } = require('../services/historico');
const { painelConformidade, consolidar } = require('../services/conformidade');
const { DIAS_EQUIPAMENTO, DIAS_ALVARA } = require('../services/ppci');
const { RELATORIOS, rotulo, CORES } = require('../relatorios/definicoes');
const { gerarPdf, gerarExcel } = require('../relatorios/relatorioArquivo');

const FORMATOS = {
  pdf: { mime: 'application/pdf', gerar: gerarPdf },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', gerar: gerarExcel }
};
const sha256 = (dados) => crypto.createHash('sha256').update(dados).digest('hex');

// Filiais do relatório: a pedida (se o usuário enxerga) ou todas as do seu escopo
async function filiaisDoRelatorio(req) {
  const q = noEscopo(knex('filiais'), req, 'id').where('ativa', true).orderBy('nome').select('id', 'nome');
  if (req.query.filial_id !== undefined) {
    if (!idValido(req.query.filial_id)) throw new ErroDeNegocio(404, 'Filial não encontrada');
    q.where('id', Number(req.query.filial_id));
  }
  const filiais = await q;
  if (req.query.filial_id !== undefined && !filiais.length) throw new ErroDeNegocio(404, 'Filial não encontrada');
  return filiais;
}

function opcoes(req) {
  return {
    dias: lerDias(req.query, 'dias', 30),
    diasAlvara: lerDias(req.query, 'dias_alvara', DIAS_ALVARA),
    diasEquipamento: lerDias(req.query, 'dias_equipamento', DIAS_EQUIPAMENTO),
    dataBase: lerDataBase(req.query).dataBase
  };
}

async function idDoEscopo(req, campo, tabela, nome) {
  if (req.query[campo] === undefined) return null;
  const r = idValido(req.query[campo]) && await knex(tabela).where({ id: Number(req.query[campo]) }).first('id', 'nome', 'filial_id');
  if (!r || !(ehAdmin(req) || req.usuario.filiais.includes(r.filial_id))) throw new ErroDeNegocio(404, `${nome} não encontrado`);
  return r;
}

// Calcula o conteúdo do relatório: { itens, resumo, parametros (texto para o cabeçalho) }
async function montar(req, tipo, filiais, o) {
  const definicao = RELATORIOS[tipo];
  const textos = [];
  if (tipo === 'conformidade') {
    const painel = await painelConformidade(knex, req, filiais, o);
    const itens = [];
    for (const f of painel.filiais) {
      for (const m of Object.values(f.modulos)) itens.push({ filial: f.filial, modulo: m.nome, ...m });
      itens.push({ filial: f.filial, modulo: 'Geral da filial', cor: f.cor, total: f.total, em_dia: f.em_dia, amarelo: f.amarelo, vermelho: f.vermelho, percentual: f.percentual });
    }
    if (painel.filiais.length > 1) {
      for (const m of Object.values(painel.geral.modulos)) itens.push({ filial: 'Todas as filiais', modulo: m.nome, ...m });
    }
    const g = painel.geral;
    const resumo = {
      'Semáforo geral': CORES[g.cor], 'Itens verificados': g.total, 'Em dia': g.em_dia, 'Atenção': g.amarelo, 'Crítico': g.vermelho,
      '% em dia': g.percentual === null ? '—' : `${String(g.percentual).replace('.', ',')}%`
    };
    textos.push(`Aviso de vencimento: treinamentos/ASO ${o.dias} dias, equipamentos ${o.diasEquipamento} dias, alvará ${o.diasAlvara} dias`);
    return { itens, resumo, textos, gravidade: definicao.gravidade };
  }

  const setor = await idDoEscopo(req, 'setor_id', 'setores', 'Setor');
  const predio = await idDoEscopo(req, 'predio_id', 'predios', 'Prédio');
  const filtros = { filial_id: filiais.length === 1 ? filiais[0].id : undefined, setor_id: setor && setor.id, predio_id: predio && predio.id };
  if (!filiais.length) filtros.filial_id = -1; // usuário sem filial: nada a listar
  const modulo = definicao.modulo;
  const calculado = await modulo.calcular(knex, req, filtros, tipo === 'ppci'
    ? { dias: o.diasEquipamento, diasAlvara: o.diasAlvara, dataBase: o.dataBase }
    : { dias: o.dias, dataBase: o.dataBase });
  const todas = req.query.todas === 'true';
  const ids = new Set(filiais.map((f) => f.id)); // só filiais ativas do relatório
  const doRelatorio = calculado.itens.filter((i) => ids.has(i.filial_id));
  const itens = todas ? doRelatorio : doRelatorio.filter((i) => modulo.gravidade(i));
  const totais = consolidar(modulo, doRelatorio, calculado.unidades.filter((u) => ids.has(u.filial_id)));
  const resumo = { 'Verificados': totais.total, 'Em dia': totais.em_dia, 'Atenção': totais.amarelo, 'Crítico': totais.vermelho };
  for (const i of itens) resumo[rotulo(i.situacao)] = (resumo[rotulo(i.situacao)] || 0) + 1;

  if (setor) textos.push(`Setor: ${setor.nome}`);
  if (predio) textos.push(`Prédio: ${predio.nome}`);
  textos.push(todas ? 'Todos os itens (inclusive em dia)' : 'Somente o que precisa de ação');
  textos.push(tipo === 'ppci' ? `Aviso: equipamentos ${o.diasEquipamento} dias, alvará ${o.diasAlvara} dias` : `Aviso de vencimento: ${o.dias} dias`);
  return { itens, resumo, textos, gravidade: (i) => modulo.gravidade(i) };
}

module.exports = {
  // GET /painel/conformidade?filial_id=&data_base=&dias=30&dias_equipamento=30&dias_alvara=90
  async painel(req, res) {
    const filiais = await filiaisDoRelatorio(req);
    const o = opcoes(req);
    const painel = await painelConformidade(knex, req, filiais, o);
    return res.json({ data_base: o.dataBase || hoje(), atual: !o.dataBase, ...painel });
  },

  // GET /relatorios/:tipo?formato=pdf|xlsx&filial_id=&setor_id=&predio_id=&data_base=&todas=true&dias=
  async emitir(req, res) {
    const tipo = req.params.tipo;
    if (!RELATORIOS[tipo]) throw new ErroDeNegocio(404, `Relatório desconhecido. Tipos: ${Object.keys(RELATORIOS).join(', ')}`);
    const formato = req.query.formato || 'pdf';
    if (!FORMATOS[formato]) throw new ErroDeNegocio(400, 'formato deve ser pdf ou xlsx');
    const o = opcoes(req);
    const filiais = await filiaisDoRelatorio(req);
    const dataBase = o.dataBase || hoje();

    const { itens, resumo, textos, gravidade } = await montar(req, tipo, filiais, o);
    const parametros = Object.fromEntries(['filial_id', 'setor_id', 'predio_id', 'todas', 'dias', 'dias_alvara', 'dias_equipamento']
      .filter((k) => req.query[k] !== undefined).map((k) => [k, req.query[k]]));
    const definicao = RELATORIOS[tipo];
    const conteudo = { tipo, titulo: definicao.titulo, data_base: dataBase, atual: !o.dataBase, filiais: filiais.map((f) => f.nome), parametros, resumo, itens };
    const hashConteudo = sha256(JSON.stringify(conteudo));
    const codigo = gerarCodigo();
    const emitidoEm = new Date();
    const url = `${req.protocol}://${req.get('host')}/verificar/${codigo}`;

    const arquivo = await FORMATOS[formato].gerar({
      definicao, itens, gravidade, resumo,
      meta: { titulo: definicao.titulo, filiais: conteudo.filiais, dataBase, ehHoje: !o.dataBase, emitidoEm, emitidoPor: req.usuario.nome, codigo, hashConteudo, url, parametros: textos }
    });
    const hashArquivo = sha256(arquivo);

    await knex.transaction(async (trx) => {
      const [registro] = await trx('relatorios_emitidos').insert({
        codigo_verificacao: codigo, tipo, formato, data_base: dataBase, parametros: JSON.stringify(parametros),
        filial_ids: JSON.stringify(filiais.map((f) => f.id)), resumo: JSON.stringify(resumo), conteudo: JSON.stringify(conteudo),
        total_itens: itens.length, hash_conteudo: hashConteudo, hash_arquivo: hashArquivo,
        emitido_por: req.usuario.id, emitido_em: emitidoEm, ip: req.ip || null, user_agent: String(req.headers['user-agent'] || '').slice(0, 300)
      }).returning(['id']);
      await auditar(trx, req, { acao: 'emitir_relatorio', tabela: 'relatorios_emitidos', registro_id: registro.id,
        filial_id: filiais.length === 1 ? filiais[0].id : null, depois: { tipo, formato, data_base: dataBase, codigo, hash_arquivo: hashArquivo } });
    });

    res.set('X-Codigo-Verificacao', codigo);
    res.set('X-Conteudo-SHA256', hashConteudo);
    res.set('X-Arquivo-SHA256', hashArquivo);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Disposition', `attachment; filename="relatorio-${tipo}-${dataBase}-${codigo}.${formato}"`);
    return res.type(FORMATOS[formato].mime).send(arquivo);
  },

  // GET /relatorios-emitidos?tipo= — os últimos 200 relatórios das filiais do usuário
  async emitidos(req, res) {
    const q = knex('relatorios_emitidos as r').join('usuarios as u', 'u.id', 'r.emitido_por')
      .orderBy('r.emitido_em', 'desc').limit(200)
      .select('r.id', 'r.codigo_verificacao', 'r.tipo', 'r.formato', 'r.data_base', 'r.parametros', 'r.filial_ids', 'r.resumo',
        'r.total_itens', 'r.hash_conteudo', 'r.hash_arquivo', 'r.emitido_em', 'u.nome as emitido_por');
    if (!ehAdmin(req)) q.whereRaw('r.filial_ids <@ ?::jsonb', [JSON.stringify(req.usuario.filiais)]);
    if (req.query.tipo) q.where('r.tipo', req.query.tipo);
    return res.json(await q);
  }
};
