// Terceirizadas: empresa única no grupo (CNPJ), contrato por filial com treinamentos exigidos, trabalhadores e alocação,
// documentos (só inclusão, ASO sigiloso), pendências, consulta de acesso pelo CPF, permissão de trabalho com terceirizado
// e integrações (semáforo, relatório, avisos).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente } = require('./ambiente');
const { hoje, somarDias, somarMeses } = require('../src/utils/datas');

let amb;
const tk = {};
const ids = {};
const api = (...args) => amb.chamar(...args);
const HOJE = hoje();
const pdf = () => 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% documento de exemplo\n%%EOF').toString('base64');
const instante = (horas) => new Date(Date.now() + horas * 3600 * 1000).toISOString();
const CHECK_ALTURA = { analise_risco: true, ancoragem: true, equipamentos: true, isolamento: true, clima: true, resgate: true, queda_objetos: true };

before(async () => {
  amb = await iniciarAmbiente();
  await amb.criarUsuarioNoBanco({ nome: 'Matriz', email: 'admin@exemplo.com', senha: 'senha-admin', perfil: 'admin' });
  tk.admin = await amb.login('admin@exemplo.com', 'senha-admin');
  const filial = async (nome, cnpj) => (await api('POST', '/filiais', { token: tk.admin, body: { nome, cnpj, uf: 'RS', cidade: 'Guaíba', bairro: 'Centro' } })).body.id;
  ids.A = await filial('Campus Exemplo', '11222333000181');
  ids.B = await filial('Colégio Exemplo', '11444777000161');
  ids.nr35 = (await api('POST', '/treinamentos', { token: tk.admin, body: { nome_treinamento: 'Trabalho em altura', nr_referencia: 'NR-35', carga_horaria: 8, validade_meses: 24 } })).body.id;
  for (const [nome, perfil, filiais] of [['gestorA', 'gestor', [ids.A]], ['tecA', 'tecnico', [ids.A]], ['saudeA', 'saude', [ids.A]], ['consultaA', 'consulta', [ids.A]], ['tecB', 'tecnico', [ids.B]]]) {
    await api('POST', '/usuarios', { token: tk.admin, body: { nome: `Usuário ${nome}`, email: `${nome}@exemplo.com`, senha: 'senha1234', perfil, filiais } });
    tk[nome] = await amb.login(`${nome}@exemplo.com`, 'senha1234');
  }
});

after(async () => { if (amb) await amb.encerrar(); });

test('empresa contratada: única no grupo pelo CNPJ, visível para quem tem contrato com ela', async () => {
  const empresa = (token, body) => api('POST', '/terceiros/empresas', { token, body });
  const corpo = { razao_social: 'Telhados Exemplo Ltda', cnpj: '11.444.777/0001-61', contato_nome: 'Fulano', contato_email: 'contato@telhados.exemplo' };
  assert.equal((await empresa(tk.consultaA, corpo)).status, 403);
  assert.equal((await empresa(tk.tecA, { ...corpo, cnpj: '11444777000100' })).status, 400, 'CNPJ inválido');
  const r = await empresa(tk.tecA, corpo);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.emp = r.body.id;
  const dup = await empresa(tk.tecB, corpo);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.empresa_id, ids.emp, 'aponta o cadastro existente');
  assert.equal((await api('GET', '/terceiros/empresas?cnpj=11444777000161', { token: tk.tecB })).body[0].id, ids.emp, 'acha pelo CNPJ');
  assert.equal((await api('GET', '/terceiros/empresas', { token: tk.tecB })).body.length, 0, 'sem contrato no Colégio, não lista');
  assert.equal((await api('GET', '/terceiros/empresas', { token: tk.tecA })).body.length, 1, 'quem cadastrou enxerga');
  ids.outra = (await empresa(tk.tecA, { razao_social: 'Limpeza Exemplo Ltda', cnpj: '11222333000262' })).body.id;
});

test('contrato por filial, trabalhadores e alocação', async () => {
  const contrato = (token, body) => api('POST', '/terceiros/contratos', { token, body });
  const corpo = { empresa_id: ids.emp, filial_id: ids.A, numero: 'CT-12/2026', objeto: 'Manutenção de telhados e calhas', inicio: somarDias(HOJE, -30), treinamentos_exigidos: [ids.nr35] };
  assert.equal((await contrato(tk.tecB, corpo)).status, 404, 'filial de fora');
  assert.equal((await contrato(tk.tecA, { ...corpo, treinamentos_exigidos: [999] })).status, 400);
  const r = await contrato(tk.tecA, corpo);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.contrato = r.body.id;
  assert.equal((await api('GET', `/terceiros/empresas/${ids.emp}`, { token: tk.gestorA })).status, 200, 'com contrato na filial, a gestão enxerga');
  assert.equal((await api('GET', `/terceiros/empresas/${ids.emp}`, { token: tk.tecB })).status, 404);

  const trab = (body) => api('POST', '/terceiros/trabalhadores', { token: tk.tecA, body });
  assert.equal((await trab({ empresa_id: ids.emp, nome: 'Paulo Telhadista', cpf: '111.111.111-11' })).status, 400);
  const p = await trab({ empresa_id: ids.emp, nome: 'Paulo Telhadista', cpf: '529.982.247-25', funcao: 'Telhadista' });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  ids.paulo = p.body.id;
  assert.equal((await trab({ empresa_id: ids.outra, nome: 'Outro', cpf: '52998224725' })).status, 409, 'CPF já em outra terceirizada');
  ids.rui = (await trab({ empresa_id: ids.emp, nome: 'Rui Ajudante', cpf: '12345678909' })).body.id;
  ids.lia = (await trab({ empresa_id: ids.outra, nome: 'Lia Limpeza', cpf: '11144477735' })).body.id;
  const lista = (await api('GET', `/terceiros/trabalhadores?empresa_id=${ids.emp}`, { token: tk.consultaA })).body;
  assert.equal(lista.find((t) => t.id === ids.paulo).cpf, '***.982.247-**', 'consulta vê o CPF mascarado');

  const alocar = (t) => api('POST', `/terceiros/contratos/${ids.contrato}/alocacoes`, { token: tk.tecA, body: { trabalhador_id: t, inicio: somarDias(HOJE, -30) } });
  assert.equal((await alocar(ids.paulo)).status, 201);
  assert.equal((await alocar(ids.paulo)).status, 409);
  assert.equal((await alocar(ids.lia)).status, 400, 'trabalhador de outra empresa');
});

test('documentos, pendências e consulta de acesso pelo CPF', async () => {
  const pend = async () => (await api('GET', `/terceiros/pendencias?filial_id=${ids.A}`, { token: tk.consultaA })).body;
  const antes = await pend();
  assert.equal(antes.resumo.faltando, 5, 'PGR, PCMSO, ASO, integração e NR-35');
  const acesso = async () => (await api('GET', `/terceiros/acesso?cpf=52998224725&filial_id=${ids.A}`, { token: tk.consultaA })).body;
  const negado = await acesso();
  assert.equal(negado.liberado, false);
  assert.ok(negado.problemas.includes('sem PGR da contratada'));
  assert.equal((await api('GET', `/terceiros/acesso?cpf=52998224725&filial_id=${ids.B}`, { token: tk.consultaA })).status, 404);

  const doc = (body, token = tk.tecA) => api('POST', '/terceiros/documentos', { token, body: { arquivo: pdf(), data_documento: somarDias(HOJE, -10), ...body } });
  assert.equal((await doc({ empresa_id: ids.emp, tipo: 'pgr' })).status, 400, 'PGR sem validade');
  assert.equal((await doc({ empresa_id: ids.emp, tipo: 'aso' })).status, 400, 'ASO é do trabalhador');
  assert.equal((await doc({ empresa_id: ids.emp, tipo: 'pgr', data_vencimento: somarDias(HOJE, 300) })).status, 201);
  assert.equal((await doc({ empresa_id: ids.emp, tipo: 'pcmso', data_vencimento: somarDias(HOJE, 20) })).status, 201);
  assert.equal((await doc({ trabalhador_id: ids.paulo, tipo: 'aso', data_vencimento: somarDias(HOJE, 200) })).status, 400, 'ASO sem resultado');
  const aso = await doc({ trabalhador_id: ids.paulo, tipo: 'aso', resultado: 'apto', data_vencimento: somarDias(HOJE, 200) }, tk.saudeA);
  assert.equal(aso.status, 201);
  const integ = await doc({ trabalhador_id: ids.paulo, tipo: 'integracao', descricao: 'Integração de SST do campus' });
  assert.equal(integ.body.data_vencimento, somarMeses(somarDias(HOJE, -10), 12), 'integração vale 12 meses por padrão');
  assert.equal((await doc({ trabalhador_id: ids.paulo, tipo: 'treinamento', nr_referencia: 'NR 35', data_vencimento: somarDias(HOJE, 500) })).status, 201, 'vale pela NR, sem estar no catálogo');

  const depois = await pend();
  assert.deepEqual(depois.itens.map((i) => `${i.exigencia}:${i.situacao}`), ['PCMSO da contratada:vencendo']);
  const liberado = await acesso();
  assert.equal(liberado.liberado, true, JSON.stringify(liberado));
  assert.equal(liberado.empresa, 'Telhados Exemplo Ltda');

  // ASO do terceirizado: arquivo só para a saúde
  assert.equal((await fetch(`${amb.base}/terceiro-documentos/${aso.body.id}/arquivo`, { headers: { Authorization: `Bearer ${tk.tecA}` } })).status, 403);
  assert.equal((await fetch(`${amb.base}/terceiro-documentos/${aso.body.id}/arquivo`, { headers: { Authorization: `Bearer ${tk.saudeA}` } })).status, 200);
  await assert.rejects(amb.knex('terceiro_documentos').where({ id: aso.body.id }).update({ resultado: 'inapto' }), /só aceita inclusão/);

  // Anular o ASO derruba a liberação; um novo ASO devolve
  assert.equal((await api('POST', `/terceiro-documentos/${aso.body.id}/anular`, { token: tk.tecA, body: { motivo: 'ASO de outra pessoa' } })).status, 403);
  assert.equal((await api('POST', `/terceiro-documentos/${aso.body.id}/anular`, { token: tk.gestorA, body: { motivo: 'ASO de outra pessoa' } })).status, 201);
  assert.ok((await acesso()).problemas.includes('sem ASO'));
  await doc({ trabalhador_id: ids.paulo, tipo: 'aso', resultado: 'apto', data_vencimento: somarDias(HOJE, 200) }, tk.saudeA);
  assert.equal((await acesso()).liberado, true);
});

test('permissão de trabalho com terceirizado: mesma conferência, ciência registrada pela equipe', async () => {
  const pt = (participantes) => api('POST', '/permissoes-trabalho', { token: tk.tecA, body: {
    filial_id: ids.A, tipo: 'altura', local_descricao: 'Telhado do prédio 2', servico: 'Troca de calhas', inicio: instante(0), fim: instante(6), checklist: CHECK_ALTURA, participantes } });
  assert.equal((await api('POST', '/permissoes-trabalho/conferir', { token: tk.tecA, body: { tipo: 'altura', participantes: [{ terceiro_trabalhador_id: ids.paulo, papel: 'executante' }] } })).status, 400, 'sem filial');

  const recusa = await pt([{ terceiro_trabalhador_id: ids.rui, papel: 'executante' }]);
  assert.equal(recusa.status, 409);
  assert.match(recusa.body.participantes[0].problemas.join(), /sem contrato ativo/);
  assert.equal(recusa.body.participantes[0].empresa, 'Telhados Exemplo Ltda');

  const ok = await pt([{ terceiro_trabalhador_id: ids.paulo, papel: 'executante' }]);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const x = ok.body.participantes[0];
  assert.equal(x.nome, 'Paulo Telhadista');
  assert.equal(x.empresa, 'Telhados Exemplo Ltda');
  assert.equal(x.conferencia.terceirizado, true);
  const ass = await api('POST', `/pt-participantes/${x.id}/assinatura-manual`, { token: tk.tecA, body: { observacao: 'Ciência dada no local, PT lida em voz alta' } });
  assert.equal(ass.status, 201, JSON.stringify(ass.body));
  assert.equal(ass.body.status, 'liberada');
  const v = await api('GET', `/verificar/${ok.body.codigo_verificacao}`);
  assert.deepEqual(v.body.participantes, [{ iniciais: 'P. T.', papel: 'executante', assinou: true }]);
  const doc = await fetch(`${amb.base}/permissoes-trabalho/${ok.body.id}/pdf`, { headers: { Authorization: `Bearer ${tk.tecA}` } });
  assert.equal(doc.status, 200);
});

test('integrações e encerramento do contrato', async () => {
  const painel = (await api('GET', `/painel/conformidade?filial_id=${ids.A}`, { token: tk.consultaA })).body.filiais[0];
  assert.equal(painel.modulos.terceiros.cor, 'amarelo', 'PCMSO vencendo');
  assert.equal((await fetch(`${amb.base}/relatorios/terceiros?todas=true&formato=xlsx`, { headers: { Authorization: `Bearer ${tk.gestorA}` } })).status, 200);
  const previa = (await api('GET', '/avisos/previa', { token: tk.admin })).body;
  assert.ok(previa.itens.some((i) => i.modulo === 'Terceirizada' && i.descricao.includes('PCMSO')));

  assert.equal((await api('POST', `/terceiros/contratos/${ids.contrato}/encerrar`, { token: tk.tecA, body: { motivo: 'Fim da obra' } })).status, 403);
  assert.equal((await api('POST', `/terceiros/contratos/${ids.contrato}/encerrar`, { token: tk.gestorA, body: { motivo: 'Fim da obra' } })).status, 200);
  const acesso = (await api('GET', `/terceiros/acesso?cpf=52998224725&filial_id=${ids.A}`, { token: tk.consultaA })).body;
  assert.equal(acesso.liberado, false, 'contrato encerrado: não entra mais');
  assert.equal((await api('GET', `/terceiros/pendencias?filial_id=${ids.A}&todas=true`, { token: tk.consultaA })).body.itens.length, 0);
});
