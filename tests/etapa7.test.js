// Etapa 7: "como estava em uma data" (data_base), painel de conformidade (semáforo) e relatórios em
// PDF/Excel com código de verificação público e SHA-256 do conteúdo e do arquivo.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { iniciarAmbiente } = require('./ambiente');
const { hoje, somarDias } = require('../src/utils/datas');

let amb;
const tk = {};
const ids = {};
const api = (...args) => amb.chamar(...args);
const HOJE = hoje();
const pdf = () => 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% certificado de exemplo\n%%EOF').toString('base64');

async function baixar(url, token) {
  const r = await fetch(amb.base + url, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, tipo: r.headers.get('content-type'), headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) };
}
const pendTreinamentos = async (query, token = tk.consultaA) => (await api('GET', `/treinamentos/pendencias?todas=true&${query}`, { token })).body;

before(async () => {
  amb = await iniciarAmbiente();
  await amb.criarUsuarioNoBanco({ nome: 'Matriz', email: 'admin@t.com', senha: 'senha-admin', perfil: 'admin' });
  tk.admin = await amb.login('admin@t.com', 'senha-admin');
  const filial = async (nome, cnpj) => (await api('POST', '/filiais', { token: tk.admin, body: { nome, cnpj, uf: 'RS', cidade: 'Guaíba', bairro: 'Centro' } })).body.id;
  ids.A = await filial('Campus Exemplo', '11222333000181');
  ids.B = await filial('Colégio Exemplo', '11444777000161');
  ids.setorA = (await api('POST', '/setores', { token: tk.admin, body: { filial_id: ids.A, nome: 'Manutenção' } })).body.id;
  ids.setorB = (await api('POST', '/setores', { token: tk.admin, body: { filial_id: ids.B, nome: 'Manutenção' } })).body.id;
  ids.eletricista = (await api('POST', '/funcoes', { token: tk.admin, body: { nome: 'Eletricista' } })).body.id;
  ids.nr35 = (await api('POST', '/treinamentos', { token: tk.admin, body: { nome_treinamento: 'Trabalho em altura', nr_referencia: 'NR-35', carga_horaria: 8, validade_meses: 12 } })).body.id;
  assert.equal((await api('PUT', `/funcoes/${ids.eletricista}/treinamentos`, { token: tk.admin, body: { treinamento_ids: [ids.nr35] } })).status, 200);
  // A exigência existe desde 2020 (o teste roda num banco criado agora)
  await amb.knex('funcao_treinamento_vigencias').update({ inicio: new Date('2020-01-01T00:00:00-03:00') });

  for (const [nome, perfil, filiais] of [['gestorA', 'gestor', [ids.A]], ['tecA', 'tecnico', [ids.A]], ['consultaA', 'consulta', [ids.A]], ['tecB', 'tecnico', [ids.B]]]) {
    await api('POST', '/usuarios', { token: tk.admin, body: { nome: `Usuário ${nome}`, email: `${nome}@t.com`, senha: 'senha1234', perfil, filiais } });
    tk[nome] = await amb.login(`${nome}@t.com`, 'senha1234');
  }
  const pessoa = async (matricula, nome, cpf) => {
    const r = await api('POST', '/funcionarios', { token: tk.admin, body: { matricula, nome, cpf, data_nascimento: '1990-01-01', data_admissao: '2022-01-10', filial_id: ids.A, setor_id: ids.setorA, funcao_id: ids.eletricista } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id;
  };
  ids.ana = await pessoa('3001', 'Ana Exemplo', '52998224725');
  ids.bruno = await pessoa('3002', 'Bruno Exemplo', '12345678909');
});

after(async () => { if (amb) await amb.encerrar(); });

test('data_base: validação', async () => {
  assert.equal((await api('GET', `/treinamentos/pendencias?data_base=${somarDias(HOJE, 1)}`, { token: tk.consultaA })).status, 400, 'futura');
  assert.equal((await api('GET', '/treinamentos/pendencias?data_base=2026-02-31', { token: tk.consultaA })).status, 400, 'inválida');
  assert.equal((await api('GET', '/asos/pendencias?data_base=31/01/2026', { token: tk.consultaA })).status, 400);
  const r = await api('GET', `/treinamentos/pendencias?data_base=${HOJE}`, { token: tk.consultaA });
  assert.equal(r.status, 200);
  assert.equal(r.body.data_base, HOJE, 'hoje = situação atual');
});

test('treinamentos como estavam: pela data do fato, com marca de lançado depois', async () => {
  const cert = await api('POST', '/certificados', { token: tk.tecA, body: {
    funcionario_id: ids.ana, treinamento_id: ids.nr35, data_realizacao: somarDias(HOJE, -400), instituicao: 'Escola Exemplo', arquivo: pdf()
  } });
  assert.equal(cert.status, 201, JSON.stringify(cert.body));
  const vencimento = cert.body.data_vencimento; // ~35 dias atrás

  const ana = (lista) => lista.itens.find((i) => i.funcionario_id === ids.ana);
  assert.equal(ana(await pendTreinamentos('')).situacao, 'vencido', 'hoje');
  const ha100 = ana(await pendTreinamentos(`data_base=${somarDias(HOJE, -100)}`));
  assert.equal(ha100.situacao, 'em_dia', 'há 100 dias o NR-35 estava válido');
  assert.equal(ha100.vencimento, vencimento);
  assert.equal(ha100.lancado_depois, true, 'o certificado foi lançado hoje, depois da data-base');
  assert.equal(ana(await pendTreinamentos(`data_base=${somarDias(vencimento, -10)}`)).situacao, 'vencendo');
  assert.equal(ana(await pendTreinamentos(`data_base=${somarDias(HOJE, -500)}`)).situacao, 'faltando', 'antes da realização');

  // Anulado não conta nem no passado
  ids.cert = cert.body.id;
  assert.equal((await api('POST', `/certificados/${ids.cert}/anular`, { token: tk.gestorA, body: { motivo: 'lançado no funcionário errado' } })).status, 201);
  assert.equal(ana(await pendTreinamentos(`data_base=${somarDias(HOJE, -100)}`)).situacao, 'faltando');
});

test('lotação e exigências da época: quem mudou de filial e treinamento que deixou de ser exigido', async () => {
  const mudou = await api('PUT', `/funcionarios/${ids.bruno}`, { token: tk.admin, body: { filial_id: ids.B, setor_id: ids.setorB, data_mudanca: somarDias(HOJE, -10) } });
  assert.equal(mudou.status, 200, JSON.stringify(mudou.body));
  const deA = async (q) => (await pendTreinamentos(q)).itens.map((i) => i.funcionario_id);
  assert.ok(!(await deA('')).includes(ids.bruno), 'hoje Bruno está no Colégio');
  assert.ok((await deA(`data_base=${somarDias(HOJE, -20)}`)).includes(ids.bruno), 'há 20 dias estava no Campus');
  const doColegio = await pendTreinamentos(`data_base=${somarDias(HOJE, -20)}`, tk.tecB);
  assert.equal(doColegio.itens.length, 0, 'o Colégio não vê o passado de Bruno no Campus');

  // A matriz tira o NR-35 da função hoje: as pendências de hoje somem, as de ontem continuam
  assert.equal((await api('PUT', `/funcoes/${ids.eletricista}/treinamentos`, { token: tk.admin, body: { treinamento_ids: [] } })).status, 200);
  assert.equal((await pendTreinamentos('')).itens.length, 0);
  assert.ok((await pendTreinamentos(`data_base=${somarDias(HOJE, -1)}`)).itens.length > 0);
  assert.equal((await api('PUT', `/funcoes/${ids.eletricista}/treinamentos`, { token: tk.admin, body: { treinamento_ids: [ids.nr35] } })).status, 200);
  await amb.knex('funcao_treinamento_vigencias').whereNull('fim').update({ inicio: new Date('2020-01-01T00:00:00-03:00') });
  const vig = await amb.knex('funcao_treinamento_vigencias').where({ funcao_id: ids.eletricista }).orderBy('id');
  assert.equal(vig.length, 2, 'histórico: período encerrado + novo período');
  assert.ok(vig[0].fim, 'o primeiro período foi encerrado');
});

test('PPCI como estava: equipamento baixado hoje aparece no passado; prazos contados da data-base', async () => {
  ids.p1 = (await api('POST', '/predios', { token: tk.admin, body: { filial_id: ids.A, nome: 'Prédio 1' } })).body.id;
  const hid = await api('POST', '/equipamentos-incendio', { token: tk.tecA, body: {
    predio_id: ids.p1, tipo: 'hidrante', identificacao: 'HID-01', localizacao: 'Escada', manutencoes: [{ tipo: 'manutencao', data_servico: somarDias(HOJE, -200) }]
  } });
  assert.equal(hid.status, 201, JSON.stringify(hid.body));
  ids.hid = hid.body.id;
  // Prédio e equipamento existem há 300 dias
  await amb.knex('predios').where({ id: ids.p1 }).update({ created_at: new Date(`${somarDias(HOJE, -300)}T12:00:00-03:00`) });
  await amb.knex('equipamento_historico').where({ equipamento_id: ids.hid }).update({ inicio: new Date(`${somarDias(HOJE, -300)}T12:00:00-03:00`) });

  assert.equal((await api('PUT', `/equipamentos-incendio/${ids.hid}`, { token: tk.gestorA, body: { ativo: false, motivo_baixa: 'Hidrante desativado na reforma' } })).status, 200);
  assert.equal((await amb.knex('equipamento_historico').where({ equipamento_id: ids.hid })).length, 2, 'a baixa entrou no histórico');

  const doHid = async (q) => (await api('GET', `/ppci/pendencias?${q}`, { token: tk.consultaA })).body.itens.filter((i) => i.equipamento_id === ids.hid).map((i) => i.situacao);
  assert.deepEqual(await doHid(''), [], 'baixado: fora das pendências de hoje');
  assert.deepEqual(await doHid(`data_base=${somarDias(HOJE, -30)}`), ['inspecao_atrasada'], 'há 30 dias: ativo, manutenção em dia, sem inspeção');
  assert.deepEqual((await doHid(`data_base=${somarDias(HOJE, -250)}`)).sort(), ['inspecao_atrasada', 'manutencao_nao_registrada'], 'antes da manutenção');
  const antes = await api('GET', `/ppci/pendencias?data_base=${somarDias(HOJE, -400)}`, { token: tk.consultaA });
  assert.equal(antes.body.itens.filter((i) => i.predio_id === ids.p1).length, 0, 'o prédio ainda não estava cadastrado');

  const painelPredio = await api('GET', `/predios/${ids.p1}/ppci?data_base=${somarDias(HOJE, -30)}`, { token: tk.consultaA });
  assert.equal(painelPredio.body.equipamentos.length, 1);
  assert.equal(painelPredio.body.data_base, somarDias(HOJE, -30));
});

test('painel de conformidade: semáforo por filial e módulo, escopo e data-base', async () => {
  const r = await api('GET', '/painel/conformidade', { token: tk.consultaA });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.atual, true);
  assert.deepEqual(r.body.filiais.map((f) => f.filial_id), [ids.A], 'consulta da filial vê só a sua');
  const a = r.body.filiais[0];
  assert.equal(a.modulos.treinamentos.cor, 'vermelho', 'Ana sem NR-35 válido');
  assert.equal(a.modulos.treinamentos.total, 1);
  assert.equal(a.modulos.asos.cor, 'vermelho', 'ninguém com ASO');
  assert.equal(a.modulos.ordens_servico.resumo.sem_pgr, 1);
  assert.equal(a.modulos.ppci.cor, 'vermelho', 'prédio sem PPCI e sem alvará');
  assert.equal(a.cor, 'vermelho');
  assert.equal(a.percentual, 0);

  // Colégio: Bruno chegou há 10 dias; há 20 dias o Colégio não tinha ninguém
  const b = (await api('GET', `/painel/conformidade?filial_id=${ids.B}`, { token: tk.admin })).body.filiais[0];
  assert.equal(b.modulos.treinamentos.total, 1);
  const bAntes = (await api('GET', `/painel/conformidade?filial_id=${ids.B}&data_base=${somarDias(HOJE, -20)}`, { token: tk.admin })).body;
  assert.equal(bAntes.atual, false);
  assert.equal(bAntes.filiais[0].modulos.treinamentos.cor, 'cinza');
  assert.equal(bAntes.filiais[0].modulos.treinamentos.total, 0);

  assert.equal((await api('GET', `/painel/conformidade?filial_id=${ids.B}`, { token: tk.consultaA })).status, 404);
  const geral = (await api('GET', '/painel/conformidade', { token: tk.admin })).body;
  assert.equal(geral.filiais.length, 2);
  assert.equal(geral.geral.modulos.treinamentos.total, 2);
});

test('relatório PDF: código de verificação público, SHA-256 do arquivo e nada de nomes na verificação', async () => {
  const r = await baixar(`/relatorios/treinamentos?formato=pdf&todas=true&data_base=${somarDias(HOJE, -20)}`, tk.consultaA);
  assert.equal(r.status, 200, r.bytes.toString());
  assert.equal(r.tipo, 'application/pdf');
  assert.equal(r.bytes.subarray(0, 5).toString(), '%PDF-');
  const codigo = r.headers.get('x-codigo-verificacao');
  assert.match(codigo, /^[A-Z2-9]{8}$/);
  assert.equal(r.headers.get('x-arquivo-sha256'), crypto.createHash('sha256').update(r.bytes).digest('hex'));
  assert.match(r.headers.get('content-disposition'), new RegExp(`relatorio-treinamentos-${somarDias(HOJE, -20)}-${codigo}\\.pdf`));

  const v = await api('GET', `/verificar/${codigo}`);
  assert.equal(v.status, 200);
  assert.equal(v.body.tipo, 'relatorio');
  assert.equal(v.body.situacao_em, somarDias(HOJE, -20));
  assert.deepEqual(v.body.filiais, ['Campus Exemplo']);
  assert.equal(v.body.sha256_arquivo, r.headers.get('x-arquivo-sha256'));
  assert.equal(v.body.sha256_conteudo, r.headers.get('x-conteudo-sha256'));
  assert.equal(v.body.emitido_por, 'U. C.', 'só as iniciais de quem emitiu');
  assert.ok(!JSON.stringify(v.body).includes('Ana'), 'a verificação pública não mostra a lista de pessoas');

  const registro = await amb.knex('relatorios_emitidos').where({ codigo_verificacao: codigo }).first();
  assert.equal(registro.total_itens, 2, 'Ana e Bruno estavam no Campus há 20 dias');
  assert.equal(registro.conteudo.itens.length, 2, 'o conteúdo fica guardado para conferir a via impressa');
  assert.ok(await amb.knex('auditoria').where({ acao: 'emitir_relatorio', registro_id: String(registro.id) }).first());

  for (const tipo of ['conformidade', 'asos', 'ordens_servico', 'ppci']) {
    const x = await baixar(`/relatorios/${tipo}`, tk.gestorA);
    assert.equal(x.status, 200, `${tipo}: ${x.bytes.toString()}`);
    assert.equal(x.bytes.subarray(0, 5).toString(), '%PDF-');
  }
  assert.equal((await api('GET', '/relatorios/salarios', { token: tk.consultaA })).status, 404);
  assert.equal((await api('GET', '/relatorios/asos?formato=docx', { token: tk.consultaA })).status, 400);
  assert.equal((await api('GET', `/relatorios/asos?filial_id=${ids.B}`, { token: tk.consultaA })).status, 404, 'filial de fora');
  assert.equal((await api('GET', '/relatorios/asos')).status, 401);
});

test('relatório Excel: cabeçalho com data-base e código, linhas e resumo; lista de emitidos por escopo', async () => {
  const r = await baixar('/relatorios/conformidade?formato=xlsx', tk.admin);
  assert.equal(r.status, 200, r.bytes.toString());
  assert.equal(r.tipo, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.bytes);
  const ws = wb.getWorksheet('Relatório');
  assert.equal(ws.getCell('A1').value, 'Painel de conformidade SST');
  assert.match(String(ws.getCell('A6').value), new RegExp(r.headers.get('x-codigo-verificacao')));
  assert.equal(ws.getCell('A8').value, 'Filial');
  const filiais = [];
  ws.eachRow((row, n) => { if (n > 8) filiais.push(row.getCell(1).value); });
  assert.ok(filiais.includes('Campus Exemplo') && filiais.includes('Colégio Exemplo') && filiais.includes('Todas as filiais'));
  assert.ok(wb.getWorksheet('Resumo'));

  const t = await baixar(`/relatorios/treinamentos?formato=xlsx&filial_id=${ids.A}`, tk.tecA);
  const wt = new ExcelJS.Workbook();
  await wt.xlsx.load(t.bytes);
  const linha = wt.getWorksheet('Relatório').getRow(9);
  assert.equal(linha.getCell(3).value, 'Ana Exemplo');
  assert.equal(linha.getCell(7).value, 'Faltando');

  const doA = (await api('GET', '/relatorios-emitidos', { token: tk.gestorA })).body;
  assert.ok(doA.length >= 6);
  assert.ok(doA.every((x) => x.filial_ids.every((f) => f === ids.A)));
  assert.equal((await api('GET', '/relatorios-emitidos', { token: tk.tecB })).body.length, 0, 'Colégio não vê relatórios do Campus');
  assert.ok((await api('GET', '/relatorios-emitidos?tipo=conformidade', { token: tk.admin })).body.some((x) => x.filial_ids.length === 2));
});
