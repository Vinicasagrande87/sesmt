// Planilha do PGR: modelo em branco, conversão para o formato da API e importação num PGR em rascunho.
//
//   npm run pgr:planilha -- modelo  pgr-modelo.xlsx
//   npm run pgr:planilha -- converter pgr-filial.xlsx [grupos.json]
//   npm run pgr:planilha -- importar  pgr-filial.xlsx --url https://servidor --pgr 12 --email voce@exemplo.com
//     (a senha vai na variável de ambiente SESMT_SENHA, para não ficar no histórico do terminal)
//
// Abas lidas: Grupos, Riscos, EPIs, Treinamentos (ligadas pelo "Nº" do grupo). As demais abas são ignoradas.
const fs = require('fs');
const ExcelJS = require('exceljs');

const CATEGORIAS = { fisico: 'Físico', quimico: 'Químico', biologico: 'Biológico', acidente: 'Acidente', ergonomico: 'Ergonômico' };
const PARTES = {
  cabeca: 'Cabeça', visao: 'Visão', facial: 'Facial', respiratoria: 'Respiratória', auditiva: 'Auditiva', cervical: 'Cervical',
  maos: 'Mãos', membros_superiores: 'Membros superiores', pes: 'Pés', membros_inferiores: 'Membros inferiores', corpo: 'Corpo'
};

const ABAS = {
  Grupos: [
    ['numero', 'Nº', 6], ['setor', 'Setor', 28], ['atividade', 'Atividade', 30], ['funcoes', 'Funções expostas (separe com ;)', 40],
    ['descricao_atividades', 'Descrição das atividades', 60], ['medidas_controle', 'Medidas de controle', 50],
    ['observacao_epi', 'Observação sobre EPI', 40], ['unidade_fisica', 'Unidade física', 28], ['conclusao_gfip', 'GFIP', 7],
    ['referencia_pdf', 'Página no PDF (só conferência)', 14]
  ],
  Riscos: [
    ['grupo', 'Nº grupo', 9], ['categoria', 'Categoria', 13], ['agente', 'Agente', 30], ['referencia', 'Referência legal', 18],
    ['fonte_geradora', 'Fonte geradora', 40], ['exposicao', 'Exposição', 14], ['medicao', 'Avaliação / medição', 26],
    ['epc', 'EPC', 24], ['probabilidade', 'Probabilidade (1-5)', 14], ['efeito', 'Efeito (1-5)', 12]
  ],
  EPIs: [['grupo', 'Nº grupo', 9], ['parte_corpo', 'Proteção para', 20], ['descricao', 'EPI (como no PGR)', 60], ['epi_id', 'Nº do EPI no catálogo (opcional)', 16]],
  Treinamentos: [['grupo', 'Nº grupo', 9], ['descricao', 'Treinamento (como no PGR)', 60], ['treinamento_id', 'Nº do treinamento no catálogo (opcional)', 18]]
};

const FONTE = { name: 'Arial', size: 10 };
const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const codigoDe = (mapa, valor) => {
  const v = semAcento(valor);
  return Object.keys(mapa).find((k) => k === v || semAcento(mapa[k]) === v) || null;
};

function prepararAba(wb, nome, colunas) {
  const ws = wb.addWorksheet(nome, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = colunas.map(([key, header, width]) => ({ key, header, width }));
  const cab = ws.getRow(1);
  cab.font = { ...FONTE, bold: true, color: { argb: 'FFFFFFFF' } };
  cab.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D3557' } };
  cab.alignment = { vertical: 'middle', wrapText: true };
  cab.height = 30;
  return ws;
}

function lista(ws, coluna, valores, ate = 2000) {
  for (let r = 2; r <= ate; r++) {
    ws.getCell(`${coluna}${r}`).dataValidation = {
      type: 'list', allowBlank: true, formulae: [`"${valores.join(',')}"`],
      showErrorMessage: true, errorTitle: 'Valor inválido', error: `Use: ${valores.join(', ')}`
    };
  }
}

function formatar(ws) {
  ws.eachRow((row, n) => {
    if (n === 1) return;
    row.font = FONTE;
    row.alignment = { vertical: 'top', wrapText: true };
  });
}

// grupos: [{ numero, setor, atividade, funcoes: [], ..., riscos: [], epis: [], treinamentos: [] }]
// extras: { leiame: [linhas], conferencia: [[item, detalhe]], cadastros: { setores: [], funcoes: [[nome_pgr, nome_sistema]] } }
async function escreverPlanilha(grupos, caminho, extras = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sistema SESMT';

  const leia = wb.addWorksheet('Leia-me');
  leia.getColumn(1).width = 120;
  const linhasLeia = extras.leiame || [];
  [
    'PLANILHA DE IMPORTAÇÃO DO PGR',
    '',
    'Como preencher:',
    '• Aba Grupos: uma linha por grupo de exposição (cada "ficha" do PGR). O Nº liga o grupo às outras abas.',
    '• Setor: nome exatamente como cadastrado na filial no sistema (maiúsculas e acentos não importam).',
    '• Funções expostas: separe com ponto e vírgula. Cada função precisa existir no catálogo da matriz.',
    '• Um mesmo setor + função só pode aparecer em UM grupo (é assim que o sistema acha a OS de cada pessoa).',
    '• Abas Riscos, EPIs e Treinamentos: uma linha por item, indicando o Nº do grupo.',
    `• Categoria do risco: ${Object.values(CATEGORIAS).join(', ')}.`,
    `• Proteção para (EPI): ${Object.values(PARTES).join(', ')}.`,
    '• Probabilidade e efeito (1 a 5, matriz AIHA do capítulo 7) são opcionais; preencha os dois juntos para o sistema calcular o nível.',
    '• "Nº no catálogo" (EPI e treinamento) é opcional: ligando, o sistema cobra EPI nunca entregue e mostra o treinamento do catálogo.',
    '• Colunas e abas marcadas "só conferência" não são importadas.',
    '',
    'Exemplo de grupo: Nº 1 | Setor: Manutenção | Atividade: Atividades em eletricidade | Funções: Eletricista; Encarregado de elétrica',
    '   Riscos: 1 | Acidente | Trabalho em altura | NR 35 | Eventual trabalho em altura | eventual',
    '   EPIs:   1 | Corpo | Cinto para trabalho em altura',
    ...(linhasLeia.length ? ['', ...linhasLeia] : [])
  ].forEach((t, i) => {
    const c = leia.getCell(`A${i + 1}`);
    c.value = t;
    c.font = { ...FONTE, bold: i === 0 || t.endsWith(':'), size: i === 0 ? 13 : 10 };
    c.alignment = { wrapText: true, vertical: 'top' };
  });

  const wsG = prepararAba(wb, 'Grupos', ABAS.Grupos);
  const wsR = prepararAba(wb, 'Riscos', ABAS.Riscos);
  const wsE = prepararAba(wb, 'EPIs', ABAS.EPIs);
  const wsT = prepararAba(wb, 'Treinamentos', ABAS.Treinamentos);

  for (const g of grupos) {
    wsG.addRow({ ...g, funcoes: (g.funcoes || []).join('; ') });
    for (const r of g.riscos || []) wsR.addRow({ ...r, grupo: g.numero, categoria: CATEGORIAS[r.categoria] || r.categoria });
    for (const e of g.epis || []) wsE.addRow({ ...e, grupo: g.numero, parte_corpo: PARTES[e.parte_corpo] || e.parte_corpo });
    for (const t of g.treinamentos || []) wsT.addRow(typeof t === 'string' ? { grupo: g.numero, descricao: t } : { ...t, grupo: g.numero });
  }
  lista(wsR, 'B', Object.values(CATEGORIAS));
  lista(wsE, 'B', Object.values(PARTES));
  [wsG, wsR, wsE, wsT].forEach(formatar);
  [wsR, wsE, wsT].forEach((ws) => { ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columnCount } }; });

  if (extras.conferencia && extras.conferencia.length) {
    const ws = prepararAba(wb, 'Conferência', [['item', 'Ponto para conferir (só conferência)', 45], ['detalhe', 'Detalhe', 110]]);
    extras.conferencia.forEach(([item, detalhe]) => ws.addRow({ item, detalhe }));
    formatar(ws);
  }
  if (extras.cadastros) {
    const ws = prepararAba(wb, 'Cadastros', [['tipo', 'Cadastro necessário (só conferência)', 22], ['nome', 'Nome a usar no sistema', 45], ['origem', 'Como aparece no PGR', 60]]);
    (extras.cadastros.setores || []).forEach(([nome, origem]) => ws.addRow({ tipo: 'Setor (filial)', nome, origem }));
    (extras.cadastros.funcoes || []).forEach(([nome, origem]) => ws.addRow({ tipo: 'Função (matriz)', nome, origem }));
    formatar(ws);
  }

  await wb.xlsx.writeFile(caminho);
}

// Valor de célula como texto simples (exceljs devolve objetos para rich text, fórmulas e hyperlinks)
function texto(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if (v.richText) v = v.richText.map((p) => p.text).join('');
    else if ('result' in v) v = v.result;
    else if (v.text) v = v.text;
  }
  const s = String(v).trim();
  return s === '' ? null : s;
}

function linhasDe(ws, colunas) {
  const linhas = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const obj = { _linha: n };
    colunas.forEach(([key], i) => { obj[key] = texto(row.getCell(i + 1).value); });
    if (colunas.some(([key]) => obj[key] !== null)) linhas.push(obj);
  });
  return linhas;
}

const inteiro = (v) => (v === null ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);

// Lê a planilha e devolve { grupos } no formato aceito por POST /pgrs/:id/grupos. Lança erro listando todos os problemas.
async function lerPlanilha(caminho) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(caminho);
  const erros = [];
  const aba = (nome) => {
    const ws = wb.getWorksheet(nome);
    if (!ws) erros.push(`Aba "${nome}" não encontrada`);
    return ws ? linhasDe(ws, ABAS[nome]) : [];
  };
  const [gs, rs, es, ts] = ['Grupos', 'Riscos', 'EPIs', 'Treinamentos'].map(aba);

  const grupos = new Map();
  for (const g of gs) {
    const numero = inteiro(g.numero);
    if (!numero || numero < 1) { erros.push(`Grupos, linha ${g._linha}: Nº inválido`); continue; }
    if (grupos.has(numero)) { erros.push(`Grupos, linha ${g._linha}: Nº ${numero} repetido`); continue; }
    if (!g.setor || !g.atividade || !g.funcoes) erros.push(`Grupos, linha ${g._linha}: setor, atividade e funções são obrigatórios`);
    grupos.set(numero, {
      ordem: numero, setor: g.setor, atividade: g.atividade,
      funcoes: String(g.funcoes || '').split(';').map((f) => f.trim()).filter(Boolean),
      descricao_atividades: g.descricao_atividades, medidas_controle: g.medidas_controle, observacao_epi: g.observacao_epi,
      unidade_fisica: g.unidade_fisica, conclusao_gfip: g.conclusao_gfip ? String(g.conclusao_gfip).padStart(2, '0') : null,
      riscos: [], epis: [], treinamentos: []
    });
  }
  const doGrupo = (aba, l) => {
    const g = grupos.get(inteiro(l.grupo));
    if (!g) erros.push(`${aba}, linha ${l._linha}: Nº grupo "${l.grupo}" não existe na aba Grupos`);
    return g;
  };
  for (const r of rs) {
    const g = doGrupo('Riscos', r);
    const categoria = codigoDe(CATEGORIAS, r.categoria);
    if (!categoria) erros.push(`Riscos, linha ${r._linha}: categoria "${r.categoria}" inválida`);
    if (!r.agente) erros.push(`Riscos, linha ${r._linha}: agente obrigatório`);
    const p = inteiro(r.probabilidade), e = inteiro(r.efeito);
    if ((p === null) !== (e === null) || [p, e].some((v) => v !== null && !(v >= 1 && v <= 5))) {
      erros.push(`Riscos, linha ${r._linha}: probabilidade e efeito juntos, de 1 a 5`);
    }
    if (g && categoria) {
      g.riscos.push({ categoria, agente: r.agente, referencia: r.referencia, fonte_geradora: r.fonte_geradora, exposicao: r.exposicao,
        medicao: r.medicao, epc: r.epc, probabilidade: p, efeito: e });
    }
  }
  for (const l of es) {
    const g = doGrupo('EPIs', l);
    const parte = codigoDe(PARTES, l.parte_corpo);
    if (!parte) erros.push(`EPIs, linha ${l._linha}: "Proteção para" inválida ("${l.parte_corpo}")`);
    if (!l.descricao) erros.push(`EPIs, linha ${l._linha}: descrição obrigatória`);
    if (g && parte) g.epis.push({ parte_corpo: parte, descricao: l.descricao, epi_id: inteiro(l.epi_id) });
  }
  for (const l of ts) {
    const g = doGrupo('Treinamentos', l);
    if (!l.descricao) erros.push(`Treinamentos, linha ${l._linha}: descrição obrigatória`);
    if (g && l.descricao) g.treinamentos.push({ descricao: l.descricao, treinamento_id: inteiro(l.treinamento_id) });
  }

  // Mesmo setor + função em dois grupos (a API recusaria; aqui já aponta onde)
  const vistos = new Map();
  for (const [n, g] of grupos) {
    for (const f of g.funcoes) {
      const k = `${semAcento(g.setor)}|${semAcento(f)}`;
      if (vistos.has(k)) erros.push(`Grupos ${vistos.get(k)} e ${n}: "${f}" aparece duas vezes no setor "${g.setor}"`);
      else vistos.set(k, n);
    }
  }
  if (erros.length) {
    const erro = new Error(`Planilha com ${erros.length} problema(s):\n- ${erros.join('\n- ')}`);
    erro.problemas = erros;
    throw erro;
  }
  return { grupos: [...grupos.values()] };
}

async function cli(args) {
  const [comando, arquivo, ...resto] = args;
  const opcao = (nome) => { const i = resto.indexOf(`--${nome}`); return i >= 0 ? resto[i + 1] : undefined; };
  if (comando === 'modelo' && arquivo) {
    await escreverPlanilha([], arquivo);
    return console.log(`Modelo criado: ${arquivo}`);
  }
  if (comando === 'converter' && arquivo) {
    const lote = await lerPlanilha(arquivo);
    const saida = resto[0] || arquivo.replace(/\.xlsx$/i, '.json');
    fs.writeFileSync(saida, JSON.stringify(lote, null, 2));
    return console.log(`${lote.grupos.length} grupos convertidos: ${saida}`);
  }
  if (comando === 'importar' && arquivo) {
    const url = opcao('url'), pgr = opcao('pgr'), email = opcao('email'), senha = process.env.SESMT_SENHA;
    if (!url || !pgr || !email || !senha) throw new Error('Use: importar arquivo.xlsx --url URL --pgr ID --email EMAIL (senha em SESMT_SENHA)');
    const lote = await lerPlanilha(arquivo);
    const login = await fetch(`${url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) });
    if (!login.ok) throw new Error(`Login falhou (${login.status})`);
    const { token } = await login.json();
    const r = await fetch(`${url}/pgrs/${pgr}/grupos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(lote)
    });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Importação recusada (${r.status}): ${corpo.error || ''}${corpo.funcoes ? ` — ${corpo.funcoes.join(', ')}` : ''}`);
    return console.log(`${corpo.length} grupos importados no PGR ${pgr}. Confira e publique.`);
  }
  console.log('Uso:\n  modelo <saida.xlsx>\n  converter <planilha.xlsx> [saida.json]\n  importar <planilha.xlsx> --url URL --pgr ID --email EMAIL   (senha em SESMT_SENHA)');
}

if (require.main === module) {
  cli(process.argv.slice(2)).catch((erro) => { console.error(erro.message); process.exit(1); });
}

module.exports = { escreverPlanilha, lerPlanilha, CATEGORIAS, PARTES };
