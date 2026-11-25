// GET /verificar/:codigo — público. Confirma que um registro existe (entrega, presença ou certificado),
// mostrando o mínimo de dados pessoais (só as iniciais do funcionário).
const knex = require('../database/db');

const iniciais = (nome) => String(nome || '').split(/\s+/).filter(Boolean).map((p) => `${p[0].toUpperCase()}.`).join(' ');

async function entrega(codigo) {
  const e = await knex('entregas')
    .join('funcionarios as f', 'f.id', 'entregas.funcionario_id')
    .join('epis', 'epis.id', 'entregas.epi_id')
    .leftJoin('epi_itens as i', 'i.id', 'entregas.item_id')
    .leftJoin('filiais as fi', 'fi.id', 'entregas.filial_id')
    .leftJoin('entrega_estornos as est', 'est.entrega_id', 'entregas.id')
    .where('entregas.codigo_verificacao', codigo)
    .first('entregas.data_hora', 'entregas.quantidade', 'entregas.ca_numero', 'entregas.metodo_assinatura',
      'epis.nome as epi', 'i.tamanho', 'fi.nome as filial', 'f.nome as funcionario', 'est.created_at as estornada_em');
  if (!e) return null;
  return {
    tipo: 'entrega_epi',
    data_hora: e.data_hora,
    epi: e.tamanho && e.tamanho !== 'Único' ? `${e.epi} (${e.tamanho})` : e.epi,
    quantidade: e.quantidade,
    ca: e.ca_numero,
    filial: e.filial,
    funcionario: iniciais(e.funcionario),
    assinatura: e.metodo_assinatura === 'qr_pin' ? 'Crachá QR + PIN pessoal' : 'Registro manual',
    estornada: !!e.estornada_em
  };
}

async function presenca(codigo) {
  const p = await knex('turma_presencas as p')
    .join('funcionarios as f', 'f.id', 'p.funcionario_id')
    .join('turmas as t', 't.id', 'p.turma_id')
    .join('treinamentos as tr', 'tr.id', 't.treinamento_id')
    .join('filiais as fi', 'fi.id', 't.filial_id')
    .leftJoin('presenca_anulacoes as a', 'a.presenca_id', 'p.id')
    .where('p.codigo_verificacao', codigo)
    .first('p.assinado_em', 'p.data_presenca', 'p.metodo_assinatura', 'tr.nome_treinamento', 'tr.nr_referencia',
      'fi.nome as filial', 'f.nome as funcionario', 'a.created_at as anulada_em');
  if (!p) return null;
  return {
    tipo: 'presenca_treinamento',
    data_hora: p.assinado_em,
    data_presenca: p.data_presenca,
    treinamento: p.nr_referencia ? `${p.nome_treinamento} (${p.nr_referencia})` : p.nome_treinamento,
    filial: p.filial,
    funcionario: iniciais(p.funcionario),
    assinatura: p.metodo_assinatura === 'qr_pin' ? 'Crachá QR + PIN pessoal' : 'Registro manual',
    anulada: !!p.anulada_em
  };
}

async function certificado(codigo) {
  const c = await knex('certificados_treinamentos as c')
    .join('funcionarios as f', 'f.id', 'c.funcionario_id')
    .join('treinamentos as tr', 'tr.id', 'c.treinamento_id')
    .leftJoin('certificado_anulacoes as a', 'a.certificado_id', 'c.id')
    .where('c.codigo_verificacao', codigo)
    .first('c.data_realizacao', 'c.data_vencimento', 'c.status', 'c.carga_horaria', 'c.origem',
      'tr.nome_treinamento', 'tr.nr_referencia', 'f.nome as funcionario', 'a.created_at as anulado_em');
  if (!c) return null;
  return {
    tipo: 'certificado_treinamento',
    treinamento: c.nr_referencia ? `${c.nome_treinamento} (${c.nr_referencia})` : c.nome_treinamento,
    funcionario: iniciais(c.funcionario),
    resultado: c.status,
    carga_horaria: c.carga_horaria,
    data_realizacao: c.data_realizacao,
    valido_ate: c.data_vencimento,
    origem: c.origem === 'turma' ? 'Turma interna' : 'Certificado externo',
    anulado: !!c.anulado_em
  };
}

async function cienciaOs(codigo) {
  const c = await knex('os_ciencias as c')
    .join('funcionarios as f', 'f.id', 'c.funcionario_id')
    .join('ordens_servico as os', 'os.id', 'c.ordem_servico_id')
    .leftJoin('os_ciencia_anulacoes as a', 'a.ciencia_id', 'c.id')
    .where('c.codigo_verificacao', codigo)
    .first('c.assinado_em', 'c.data_ciencia', 'c.metodo_assinatura', 'os.id as ordem_servico', 'os.hash',
      knex.raw("os.conteudo->>'setor' as setor"), knex.raw("os.conteudo->>'atividade' as atividade"),
      'f.nome as funcionario', 'a.created_at as anulada_em');
  if (!c) return null;
  return {
    tipo: 'ciencia_ordem_servico',
    data_hora: c.assinado_em,
    data_ciencia: c.data_ciencia,
    ordem_servico: c.ordem_servico,
    setor: c.setor,
    atividade: c.atividade,
    hash_conteudo: c.hash,
    funcionario: iniciais(c.funcionario),
    assinatura: c.metodo_assinatura === 'qr_pin' ? 'Crachá QR + PIN pessoal' : 'Registro manual (OS em papel)',
    anulada: !!c.anulada_em
  };
}

async function inspecaoIncendio(codigo) {
  const i = await knex('equipamento_inspecoes as i')
    .join('equipamentos_incendio as e', 'e.id', 'i.equipamento_id')
    .join('predios as p', 'p.id', 'i.predio_id')
    .join('filiais as fi', 'fi.id', 'i.filial_id')
    .join('usuarios as u', 'u.id', 'i.usuario_id')
    .leftJoin('inspecao_anulacoes as a', 'a.inspecao_id', 'i.id')
    .where('i.codigo_verificacao', codigo)
    .first('i.data_hora', 'i.metodo', 'i.conforme', 'i.localizacao', 'e.identificacao', 'e.tipo', 'p.nome as predio',
      'fi.nome as filial', 'u.nome as inspetor', 'a.created_at as anulada_em');
  if (!i) return null;
  return {
    tipo: 'inspecao_equipamento_incendio',
    data_hora: i.data_hora,
    equipamento: `${i.identificacao} (${i.tipo})`,
    predio: i.predio,
    localizacao: i.localizacao,
    filial: i.filial,
    resultado: i.conforme ? 'conforme' : 'não conforme',
    inspetor: iniciais(i.inspetor),
    leitura: i.metodo === 'qr' ? 'QR lido no equipamento' : 'Registro manual (sem leitura do QR)',
    anulada: !!i.anulada_em
  };
}

// Relatório emitido: só o resumo (contagens), nunca a lista de pessoas
async function relatorio(codigo) {
  const r = await knex('relatorios_emitidos as r').join('usuarios as u', 'u.id', 'r.emitido_por')
    .where('r.codigo_verificacao', codigo)
    .first('r.tipo', 'r.formato', 'r.data_base', 'r.resumo', 'r.total_itens', 'r.hash_conteudo', 'r.hash_arquivo', 'r.emitido_em',
      'r.filial_ids', knex.raw("r.conteudo->>'titulo' as titulo"), 'u.nome as emitido_por');
  if (!r) return null;
  const filiais = await knex('filiais').whereIn('id', r.filial_ids).orderBy('nome').pluck('nome');
  return {
    tipo: 'relatorio',
    relatorio: r.titulo,
    formato: r.formato,
    situacao_em: r.data_base,
    data_hora: r.emitido_em,
    emitido_por: iniciais(r.emitido_por),
    filiais,
    total_itens: r.total_itens,
    resumo: r.resumo,
    sha256_conteudo: r.hash_conteudo,
    sha256_arquivo: r.hash_arquivo
  };
}

// Fechamento mensal: competência, filial, semáforo e quantidades (sem pessoas)
async function fechamento(codigo) {
  const f = await knex('fechamentos as f').join('filiais as fi', 'fi.id', 'f.filial_id').join('usuarios as u', 'u.id', 'f.fechado_por')
    .where('f.codigo_verificacao', codigo)
    .first('f.competencia', 'f.data_base', 'f.resumo', 'f.hash', 'f.hash_anterior', 'f.fechado_em', 'fi.nome as filial', 'u.nome as fechado_por');
  if (!f) return null;
  return {
    tipo: 'fechamento_mensal',
    competencia: f.competencia,
    situacao_em: f.data_base,
    filial: f.filial,
    data_hora: f.fechado_em,
    fechado_por: iniciais(f.fechado_por),
    resumo: f.resumo,
    sha256: f.hash,
    sha256_anterior: f.hash_anterior
  };
}

// Permissão de trabalho: está válida agora? (quem está no local confere pelo QR do PDF afixado)
async function permissaoTrabalho(codigo) {
  const p = await knex('permissoes_trabalho as p').join('filiais as fi', 'fi.id', 'p.filial_id').leftJoin('predios as pr', 'pr.id', 'p.predio_id')
    .where('p.codigo_verificacao', codigo).first('p.id', 'p.ano', 'p.sequencial', 'p.tipo', 'p.local_descricao', 'p.inicio', 'p.fim', 'p.status', 'fi.nome as filial', 'pr.nome as predio');
  if (!p) return null;
  const { TIPOS, numero } = require('../services/permissoes');
  const participantes = await knex('pt_participantes as x').leftJoin('funcionarios as f', 'f.id', 'x.funcionario_id')
    .leftJoin('terceiro_trabalhadores as t', 't.id', 'x.terceiro_trabalhador_id')
    .leftJoin('pt_assinaturas as s', 's.participante_id', 'x.id').where('x.pt_id', p.id).orderBy('x.id')
    .select(knex.raw('coalesce(f.nome, t.nome) as nome'), 'x.papel', 's.id as assinatura');
  const agora = new Date();
  let situacao = p.status;
  if (['aguardando_assinaturas', 'liberada'].includes(p.status)) {
    if (new Date(p.fim) < agora) situacao = 'vencida';
    else if (new Date(p.inicio) > agora) situacao = 'programada';
  }
  return {
    tipo: 'permissao_trabalho',
    numero: numero(p),
    trabalho: TIPOS[p.tipo].nome,
    filial: p.filial,
    local: [p.predio, p.local_descricao].filter(Boolean).join(' · '),
    inicio: p.inicio,
    fim: p.fim,
    situacao,
    pode_trabalhar: situacao === 'liberada',
    participantes: participantes.map((x) => ({ iniciais: iniciais(x.nome), papel: x.papel, assinou: !!x.assinatura }))
  };
}

async function presencaDds(codigo) {
  const p = await knex('dds_presencas as p').join('dds as d', 'd.id', 'p.dds_id').join('funcionarios as f', 'f.id', 'p.funcionario_id')
    .join('filiais as fi', 'fi.id', 'd.filial_id').leftJoin('dds_presenca_anulacoes as n', 'n.presenca_id', 'p.id')
    .where('p.codigo_verificacao', codigo).first('p.assinado_em', 'p.metodo', 'd.data', 'd.tema', 'fi.nome as filial', 'f.nome as funcionario', 'n.created_at as anulada_em');
  if (!p) return null;
  return {
    tipo: 'presenca_dds', data_hora: p.assinado_em, data: p.data, tema: p.tema, filial: p.filial, funcionario: iniciais(p.funcionario),
    assinatura: p.metodo === 'qr_pin' ? 'Crachá QR + PIN pessoal' : 'Registro manual (lista em papel)', anulada: !!p.anulada_em
  };
}

module.exports = {
  async verificar(req, res) {
    const codigo = String(req.params.codigo || '').toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(codigo)) return res.status(404).json({ valida: false });
    const achado = (await entrega(codigo)) || (await presenca(codigo)) || (await certificado(codigo)) || (await cienciaOs(codigo)) ||
      (await inspecaoIncendio(codigo)) || (await relatorio(codigo)) || (await fechamento(codigo)) || (await permissaoTrabalho(codigo)) || (await presencaDds(codigo));
    if (!achado) return res.status(404).json({ valida: false });
    return res.json({ valida: true, codigo, ...achado });
  }
};
