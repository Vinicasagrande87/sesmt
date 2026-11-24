// Avisos de vencimento por e-mail, com 1 mês de antecedência.
// Quem recebe: todos os admins ativos (todas as filiais) + os destinatários extras cadastrados pela matriz
// (cada um com todas as filiais ou só algumas). Os endereços ficam só no banco, nunca no código.
// O que entra: treinamentos, ASOs, alvarás, recarga/teste/manutenção e inspeção de equipamentos,
// vigência do PGR, CA de EPI e lotes em estoque com validade — o que já venceu e o que vence até a data-limite.
const { hoje, somarDias, somarMeses, diasEntre } = require('../utils/datas');
const { dataBR, dataHoraBR } = require('../relatorios/formatos');
const { rotulo } = require('../relatorios/definicoes');
const { situacaoTreinamentos } = require('./treinamentos');
const { situacaoAsos } = require('./asos');
const { situacaoPpci, EQUIPAMENTOS } = require('./ppci');
const { enviarEmail, emailAtivo } = require('./email');
const { situacaoOcorrencias, TIPOS: TIPOS_OCORRENCIA } = require('./ocorrencias');
const { situacaoAcoes } = require('./acoes');

const COMO_MATRIZ = { usuario: { perfil: 'admin', filiais: null } }; // os avisos olham todas as filiais
const MANUTENCOES = { recarga: 'Recarga', teste_hidrostatico: 'Teste hidrostático', manutencao: 'Manutenção' };

// Data-limite = hoje + 1 mês (24/11 -> 24/12), e quantos dias isso dá
function janela(dataHoje = hoje()) {
  const limite = somarMeses(dataHoje, 1);
  return { dataHoje, limite, dias: diasEntre(dataHoje, limite) - 1 };
}

async function montarAvisos(db, { dataHoje = hoje() } = {}) {
  const { limite, dias } = janela(dataHoje);
  const itens = [];
  const add = (i) => { if (i.data && i.data <= limite) itens.push({ ...i, vencido: i.data < dataHoje }); };

  for (const t of await situacaoTreinamentos(db, COMO_MATRIZ, {}, { dias })) {
    if (['vencido', 'vencendo'].includes(t.situacao)) {
      add({ modulo: 'Treinamento', filial_id: t.filial_id, filial: t.filial, data: t.vencimento,
        descricao: `${t.funcionario} (matr. ${t.matricula}) — ${t.treinamento}${t.nr ? ` (${t.nr})` : ''}` });
    }
  }
  for (const a of await situacaoAsos(db, COMO_MATRIZ, {}, { dias })) {
    if (['vencido', 'vencendo', 'demissional_pendente'].includes(a.situacao)) {
      add({ modulo: 'ASO', filial_id: a.filial_id, filial: a.filial, data: a.vencimento,
        descricao: a.situacao === 'demissional_pendente' ? `${a.funcionario} (matr. ${a.matricula}) — prazo do exame demissional` : `${a.funcionario} (matr. ${a.matricula}) — ASO periódico` });
    }
  }
  const { itens: ppci } = await situacaoPpci(db, COMO_MATRIZ, {}, { dias, diasAlvara: dias });
  for (const p of ppci) {
    if (p.situacao === 'alvara_vencido' || p.situacao === 'alvara_vencendo') {
      add({ modulo: 'Alvará', filial_id: p.filial_id, filial: p.filial, data: p.data_validade, descricao: `${p.predio} — alvará do Corpo de Bombeiros` });
    } else if (/_(vencida|vencendo)$/.test(p.situacao) || p.situacao === 'inspecao_atrasada') {
      const tipo = p.situacao === 'inspecao_atrasada' ? 'Inspeção mensal' : MANUTENCOES[p.situacao.replace(/_(vencida|vencendo)$/, '')] || rotulo(p.situacao);
      const nome = EQUIPAMENTOS[p.tipo] ? EQUIPAMENTOS[p.tipo].nome : p.tipo;
      add({ modulo: 'Equipamento de incêndio', filial_id: p.filial_id, filial: p.filial, data: p.data_limite || dataHoje,
        descricao: `${p.predio} — ${p.identificacao} (${nome}, ${p.localizacao}) — ${tipo}` });
    }
  }

  const pgrs = await db('pgrs as p').join('pgr_filiais as pf', 'pf.pgr_id', 'p.id').join('filiais as f', 'f.id', 'pf.filial_id')
    .where('p.status', 'vigente').where('p.data_fim', '<=', limite).select('p.titulo', 'p.data_fim', 'f.id as filial_id', 'f.nome as filial');
  for (const p of pgrs) add({ modulo: 'PGR', filial_id: p.filial_id, filial: p.filial, data: p.data_fim, descricao: `${p.titulo} — fim da vigência` });

  // CA vigente de cada EPI ativo (catálogo da matriz: vale para todas as filiais)
  const cas = await db('epi_cas as c').join('epis as e', 'e.id', 'c.epi_id').where('e.ativo', true)
    .distinctOn('c.epi_id').orderBy([{ column: 'c.epi_id' }, { column: 'c.created_at', order: 'desc' }, { column: 'c.id', order: 'desc' }])
    .select('c.numero', 'c.validade', 'e.nome');
  for (const c of cas) {
    if (c.validade) add({ modulo: 'CA de EPI', filial_id: null, filial: 'Catálogo da matriz', data: c.validade, descricao: `${c.nome} — CA ${c.numero}` });
  }

  // Lotes em estoque (com saldo) perto da validade
  const lotes = await db('lotes as l').join('epi_itens as i', 'i.id', 'l.item_id').join('epis as e', 'e.id', 'i.epi_id')
    .join('filiais as f', 'f.id', 'l.filial_id').join('movimentacoes as m', 'm.lote_id', 'l.id')
    .whereNotNull('l.data_validade').where('l.data_validade', '<=', limite)
    .groupBy('l.id', 'e.nome', 'i.tamanho', 'f.id', 'f.nome').havingRaw('sum(m.quantidade) > 0')
    .select('l.id', 'l.data_validade', 'e.nome', 'i.tamanho', 'f.id as filial_id', 'f.nome as filial', db.raw('sum(m.quantidade)::int as saldo'));
  for (const l of lotes) {
    add({ modulo: 'Estoque de EPI', filial_id: l.filial_id, filial: l.filial, data: l.data_validade,
      descricao: `${l.nome}${l.tamanho && l.tamanho !== 'Único' ? ` (${l.tamanho})` : ''} — lote ${l.id}, ${l.saldo} em estoque` });
  }

  // Ocorrências: CAT a emitir/atrasada e investigação com prazo
  for (const o of await situacaoOcorrencias(db, COMO_MATRIZ, {})) {
    if (['cat_pendente', 'cat_a_emitir'].includes(o.situacao) || o.cat_pendente_de.length) {
      add({ modulo: 'CAT', filial_id: o.filial_id, filial: o.filial, data: o.prazo_cat,
        descricao: `Ocorrência ${o.numero} (${TIPOS_OCORRENCIA[o.tipo]}) — CAT de ${o.cat_pendente_de.join(', ')}` });
    }
    if (o.prazo_investigacao) {
      add({ modulo: 'Investigação de ocorrência', filial_id: o.filial_id, filial: o.filial, data: o.prazo_investigacao,
        descricao: `Ocorrência ${o.numero} (${TIPOS_OCORRENCIA[o.tipo]}) — concluir a investigação` });
    }
  }

  // Plano de ação: abertas com prazo até a data-limite (o responsável também recebe as suas)
  for (const a of await situacaoAcoes(db, COMO_MATRIZ, {}, { dias })) {
    if (!['atrasada', 'vence_em_breve'].includes(a.situacao)) continue;
    add({ modulo: 'Plano de ação', filial_id: a.filial_id, filial: a.filial, data: a.prazo, responsavel_id: a.responsavel_id,
      descricao: `Ação ${a.numero}: ${a.titulo} — responsável: ${a.responsavel}${a.reprogramacoes ? ` (prazo reprogramado ${a.reprogramacoes}x)` : ''}` });
  }

  itens.sort((a, b) => a.data.localeCompare(b.data) || a.filial.localeCompare(b.filial) || a.descricao.localeCompare(b.descricao));
  return { dataHoje, limite, itens };
}

// Quem recebe esta rodada: admins + destinatários + responsáveis por ações (só as suas, se não estiverem na lista)
async function destinatariosDaRodada(db, itens) {
  const lista = await destinatarios(db);
  const ja = new Set(lista.map((d) => d.email));
  const ids = [...new Set(itens.filter((i) => i.responsavel_id).map((i) => i.responsavel_id))];
  if (ids.length) {
    for (const u of await db('usuarios').whereIn('id', ids).where('ativo', true).select('id', 'nome', 'email')) {
      const email = u.email.toLowerCase();
      if (!ja.has(email)) lista.push({ nome: u.nome, email, origem: 'responsavel', filial_ids: null, somente_responsavel_id: u.id });
    }
  }
  return lista;
}

// E-mail ao responsável quando recebe uma ação
async function notificarResponsavel(db, acao, usuario) {
  if (!emailAtivo() || !usuario || !usuario.email) return { enviado: false };
  await enviarEmail({
    para: usuario.email,
    assunto: `SESMT — ação ${acao.numero} sob sua responsabilidade (prazo ${dataBR(acao.prazo)})`,
    texto: [`Olá, ${usuario.nome}.`, '', `Você é o responsável pela ação ${acao.numero} do plano de ação da ${acao.filial}:`, '',
      acao.titulo, acao.descricao || '', '', `Origem: ${acao.origem_descricao}`, `Prazo: ${dataBR(acao.prazo)}`, `Prioridade: ${acao.prioridade}`, '',
      'Registre o andamento e a conclusão (com a evidência) no sistema.'].join('\n')
  });
  return { enviado: true };
}

// Aviso imediato ao registrar acidente/doença com empregado (prazo da CAT) ou ocorrência grave/fatal
async function notificarOcorrencia(db, o) {
  if (!emailAtivo()) return { enviado: false, motivo: 'email_nao_configurado' };
  const comCat = o.prazo_cat && o.vitimas.some((v) => v.vinculo === 'empregado' && (v.houve_lesao || v.obito));
  if (!comCat && !['grave', 'fatal'].includes(o.gravidade)) return { enviado: false, motivo: 'sem_urgencia' };
  const pessoas = o.vitimas.map((v) => `${v.nome_vitima} (${v.vinculo})`).join(', ') || 'sem vítima';
  const assunto = `SESMT — ${TIPOS_OCORRENCIA[o.tipo]} na ${o.filial}${comCat ? `: CAT até ${dataBR(o.prazo_cat)}` : ''}`;
  const texto = [
    `${TIPOS_OCORRENCIA[o.tipo]} nº ${o.numero} registrado(a) no sistema.`, '',
    `Filial: ${o.filial}`, `Data: ${dataHoraBR(o.data_hora)}`,
    `Local: ${o.local_descricao}`, `Gravidade: ${o.gravidade || o.gravidade_potencial || '—'}`, `Pessoas: ${pessoas}`, '',
    comCat ? `A CAT deve ser emitida até ${dataBR(o.prazo_cat)} (Lei 8.213, art. 22). Registre o número no sistema.` : '',
    `A investigação deve ser concluída em até 30 dias.`
  ].filter((l) => l !== null).join('\n');
  const resultado = [];
  for (const dest of await destinatarios(db)) {
    if (dest.filial_ids && !dest.filial_ids.includes(o.filial_id)) continue;
    try {
      await enviarEmail({ para: dest.email, assunto, texto: `Olá, ${dest.nome}.\n\n${texto}\n` });
      resultado.push({ email: dest.email, enviado: true });
    } catch (erro) {
      resultado.push({ email: dest.email, enviado: false, erro: erro.message });
    }
  }
  return { enviado: true, resultado };
}

// Admins ativos + destinatários extras ativos (mesmo e-mail nos dois: vale o de todas as filiais)
async function destinatarios(db) {
  const lista = new Map();
  for (const u of await db('usuarios').where({ perfil: 'admin', ativo: true }).select('nome', 'email')) {
    lista.set(u.email.toLowerCase(), { nome: u.nome, email: u.email.toLowerCase(), origem: 'admin', filial_ids: null });
  }
  for (const d of await db('aviso_destinatarios').where({ ativo: true }).select('nome', 'email', 'filial_ids')) {
    const email = d.email.toLowerCase();
    if (!lista.has(email)) lista.set(email, { nome: d.nome, email, origem: 'destinatario', filial_ids: d.filial_ids });
  }
  return [...lista.values()];
}

// Só as filiais do destinatário (CA do catálogo vai para quem recebe todas); responsável: só as próprias ações
function itensDe(dest, itens) {
  if (dest.somente_responsavel_id) return itens.filter((i) => i.responsavel_id === dest.somente_responsavel_id);
  return dest.filial_ids ? itens.filter((i) => i.filial_id !== null && dest.filial_ids.includes(i.filial_id)) : itens;
}

const escapar = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function montarEmail(dest, itens, limite) {
  const porFilial = new Map();
  for (const i of itens) {
    if (!porFilial.has(i.filial)) porFilial.set(i.filial, []);
    porFilial.get(i.filial).push(i);
  }
  const vencidos = itens.filter((i) => i.vencido).length;
  const assunto = `SESMT — ${vencidos ? `${vencidos} vencido(s) e ` : ''}${itens.length - vencidos} a vencer até ${dataBR(limite)}`;

  let texto = `Olá, ${dest.nome}.\n\nVencimentos até ${dataBR(limite)} (aviso com 1 mês de antecedência):\n`;
  let html = `<p>Olá, ${escapar(dest.nome)}.</p><p>Vencimentos até <b>${dataBR(limite)}</b> (aviso com 1 mês de antecedência):</p>`;
  for (const [filial, lista] of porFilial) {
    texto += `\n== ${filial} ==\n`;
    html += `<h3 style="margin:16px 0 4px;font-family:Arial">${escapar(filial)}</h3>` +
      '<table cellpadding="4" style="border-collapse:collapse;font-family:Arial;font-size:13px"><tr style="background:#e8ebf0"><th align="left">Vence em</th><th align="left">Área</th><th align="left">Item</th></tr>';
    for (const i of lista) {
      texto += `${i.vencido ? 'VENCIDO ' : ''}${dataBR(i.data)}  [${i.modulo}]  ${i.descricao}\n`;
      html += `<tr${i.vencido ? ' style="color:#8a1c17"' : ''}><td>${i.vencido ? '<b>VENCIDO</b> ' : ''}${dataBR(i.data)}</td><td>${escapar(i.modulo)}</td><td>${escapar(i.descricao)}</td></tr>`;
    }
    html += '</table>';
  }
  const rodape = 'Aviso automático do sistema SESMT. A situação completa está no painel de conformidade.';
  return { assunto, texto: `${texto}\n${rodape}\n`, html: `${html}<p style="color:#555;font-size:12px">${rodape}</p>` };
}

// Envia uma rodada de avisos. A referência é única: a mesma semana nunca sai duas vezes.
async function enviarAvisos(db, { referencia, tipo = 'automatico', usuarioId = null, dataHoje = hoje() }) {
  if (!emailAtivo()) return { enviado: false, motivo: 'email_nao_configurado' };
  const { limite, itens } = await montarAvisos(db, { dataHoje });
  let envio;
  try {
    [envio] = await db('aviso_envios').insert({ referencia, tipo, limite, usuario_id: usuarioId }).returning(['id']);
  } catch (erro) {
    if (erro.code === '23505') return { enviado: false, motivo: 'ja_enviado', referencia };
    throw erro;
  }
  const resultado = [];
  for (const dest of await destinatariosDaRodada(db, itens)) {
    const meus = itensDe(dest, itens);
    if (!meus.length) { resultado.push({ email: dest.email, itens: 0, enviado: false, motivo: 'nada_a_vencer' }); continue; }
    try {
      await enviarEmail({ para: dest.email, ...montarEmail(dest, meus, limite) });
      resultado.push({ email: dest.email, itens: meus.length, enviado: true });
    } catch (erro) {
      resultado.push({ email: dest.email, itens: meus.length, enviado: false, erro: erro.message });
    }
  }
  await db('aviso_envios').where({ id: envio.id }).update({ resultado: JSON.stringify(resultado), concluido_em: db.fn.now() });
  return { enviado: true, id: envio.id, referencia, limite, total_itens: itens.length, resultado };
}

// Semana ISO (2026-W48) de uma data 'AAAA-MM-DD'
function semanaIso(data) {
  const [a, m, d] = data.split('-').map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  const diaSemana = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - diaSemana);
  const inicioAno = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const semana = Math.ceil(((dt - inicioAno) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(semana).padStart(2, '0')}`;
}

// Envio automático semanal: no dia AVISOS_DIA_SEMANA (1 = segunda, padrão) a partir de AVISOS_HORA (7h, Brasília).
// Se o servidor estiver fora do ar na hora, sai assim que voltar, na mesma semana.
function iniciarAgendador(db) {
  if (process.env.AVISOS_AUTOMATICOS === 'false') return null;
  const dia = Number(process.env.AVISOS_DIA_SEMANA || 1);
  const hora = Number(process.env.AVISOS_HORA || 7);
  const verificar = async () => {
    if (!emailAtivo()) return;
    const agora = new Date();
    const partes = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
      .formatToParts(agora).map((p) => [p.type, p.value]));
    const diaHoje = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(partes.weekday);
    const dataHoje = hoje();
    // da hora marcada do dia escolhido até o fim da semana
    const diasDesde = (diaHoje - dia + 7) % 7;
    const semanaDoDia = semanaIso(somarDias(dataHoje, -diasDesde));
    if (diasDesde === 0 && Number(partes.hour) < hora) return;
    try {
      await enviarAvisos(db, { referencia: `semana-${semanaDoDia}`, dataHoje });
    } catch (erro) {
      console.warn(`Avisos de vencimento não enviados: ${erro.message}`);
    }
  };
  verificar();
  return setInterval(verificar, 30 * 60 * 1000).unref();
}

module.exports = {
  janela, montarAvisos, destinatarios, destinatariosDaRodada, itensDe, montarEmail, enviarAvisos, notificarOcorrencia, notificarResponsavel,
  semanaIso, iniciarAgendador
};
