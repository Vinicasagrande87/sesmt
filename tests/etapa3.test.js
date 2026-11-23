// Etapa 3: treinamentos, exigências por função, turmas, presença por QR + PIN, encerramento,
// certificados externos, pendências, PDFs e verificação pública.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente } = require('./ambiente');
const { hoje, somarDias, somarMeses, diasEntre } = require('../src/utils/datas');

let amb;
const tk = {};
const ids = {};
const api = (...args) => amb.chamar(...args);
const pdf = () => 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% certificado externo\n%%EOF').toString('base64');
const HOJE = hoje();

async function baixar(url, token) {
  const r = await fetch(amb.base + url, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, tipo: r.headers.get('content-type'), bytes: Buffer.from(await r.arrayBuffer()) };
}

before(async () => {
  amb = await iniciarAmbiente();
  await amb.criarUsuarioNoBanco({ nome: 'Matriz', email: 'admin@t.com', senha: 'senha-admin', perfil: 'admin' });
  tk.admin = await amb.login('admin@t.com', 'senha-admin');

  const filial = async (nome, cnpj) => (await api('POST', '/filiais', {
    token: tk.admin, body: { nome, cnpj, uf: 'RS', cidade: 'Guaíba', bairro: 'Centro' }
  })).body.id;
  ids.A = await filial('Campus Guaíba', '11222333000181');
  ids.B = await filial('Colégio Exemplo', '11222333000262');
  ids.setorA = (await api('POST', '/setores', { token: tk.admin, body: { filial_id: ids.A, nome: 'Manutenção' } })).body.id;
  ids.eletricista = (await api('POST', '/funcoes', { token: tk.admin, body: { nome: 'Eletricista' } })).body.id;

  for (const [nome, perfil, filiais] of [['tecA', 'tecnico', [ids.A]], ['gestorA', 'gestor', [ids.A]], ['tecB', 'tecnico', [ids.B]], ['consultaA', 'consulta', [ids.A]]]) {
    await api('POST', '/usuarios', { token: tk.admin, body: { nome, email: `${nome}@t.com`, senha: 'senha1234', perfil, filiais } });
    tk[nome] = await amb.login(`${nome}@t.com`, 'senha1234');
  }

  const funcionario = async (matricula, nome, cpf) => {
    const r = await api('POST', '/funcionarios', {
      token: tk.gestorA,
      body: { matricula, nome, cpf, data_nascimento: '1990-01-01', data_admissao: '2022-01-10', filial_id: ids.A, setor_id: ids.setorA, funcao_id: ids.eletricista }
    });
    return { id: r.body.id, qr: r.body.qr_token };
  };
  ids.ana = await funcionario('1001', 'Ana Souza', '52998224725');
  ids.sergio = await funcionario('1002', 'Sérgio Lima', '12345678909');
  await api('POST', `/funcionarios/qr/${ids.ana.qr}/pin`, { token: tk.tecA, body: { pin: '4821' } });
  await api('POST', `/funcionarios/qr/${ids.sergio.qr}/pin`, { token: tk.tecA, body: { pin: '905172' } });
});

after(async () => { if (amb) await amb.encerrar(); });

test('datas: soma de meses respeita o fim do mês', () => {
  assert.equal(somarMeses('2024-01-31', 1), '2024-02-29');
  assert.equal(somarMeses('2023-01-31', 1), '2023-02-28');
  assert.equal(somarMeses('2026-11-23', 24), '2028-11-23');
  assert.equal(somarMeses('2026-03-15', -24), '2024-03-15');
  assert.equal(diasEntre('2026-11-20', '2026-11-22'), 3);
  assert.equal(diasEntre('2026-11-20', '2026-11-20'), 1);
});

test('página de presença é servida', async () => {
  const r = await fetch(amb.base + '/presenca.html');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Presença em treinamento/);
});

test('catálogo de treinamentos e exigências por função (matriz)', async () => {
  assert.equal((await api('POST', '/treinamentos', { token: tk.gestorA, body: { nome_treinamento: 'X', carga_horaria: 1 } })).status, 403);
  const nr35 = await api('POST', '/treinamentos', {
    token: tk.admin,
    body: { nome_treinamento: 'Trabalho em altura', nr_referencia: 'NR-35', carga_horaria: 8, validade_meses: 24, conteudo_programatico: 'Normas e regulamentos; análise de risco; sistemas de proteção contra quedas; acidentes típicos; resgate e primeiros socorros.' }
  });
  assert.equal(nr35.status, 201);
  ids.nr35 = nr35.body.id;
  ids.nr10 = (await api('POST', '/treinamentos', { token: tk.admin, body: { nome_treinamento: 'Segurança em eletricidade', nr_referencia: 'NR-10', carga_horaria: 40, validade_meses: 24 } })).body.id;
  const integracao = await api('POST', '/treinamentos', { token: tk.admin, body: { nome_treinamento: 'Integração', carga_horaria: 2, validade_meses: 0 } });
  assert.equal(integracao.body.validade_meses, null, '0 = não vence');

  assert.equal((await api('PUT', `/funcoes/${ids.eletricista}/treinamentos`, { token: tk.gestorA, body: { treinamento_ids: [ids.nr35] } })).status, 403);
  assert.equal((await api('PUT', `/funcoes/${ids.eletricista}/treinamentos`, { token: tk.admin, body: { treinamento_ids: [999] } })).status, 400);
  const ex = await api('PUT', `/funcoes/${ids.eletricista}/treinamentos`, { token: tk.admin, body: { treinamento_ids: [ids.nr35, ids.nr10, ids.nr35] } });
  assert.equal(ex.status, 200);
  assert.deepEqual(ex.body.treinamentos.map((t) => t.nr_referencia).sort(), ['NR-10', 'NR-35']);
});

test('pendências: sem treinamento = faltando; filial alheia não aparece', async () => {
  const p = await api('GET', '/treinamentos/pendencias', { token: tk.consultaA });
  assert.equal(p.status, 200);
  assert.deepEqual(p.body.resumo, { faltando: 4, vencido: 0, vencendo: 0, em_dia: 0 });
  assert.deepEqual((await api('GET', '/treinamentos/pendencias', { token: tk.tecB })).body.itens, []);
});

test('turma: criação e validações', async () => {
  const base = { treinamento_id: ids.nr35, filial_id: ids.A, data_inicio: HOJE, data_fim: HOJE, instrutor_nome: 'Carlos Pereira', instrutor_qualificacao: 'Téc. Seg. Trabalho', local: 'Auditório' };
  assert.equal((await api('POST', '/turmas', { token: tk.tecA, body: { ...base, filial_id: ids.B } })).status, 403);
  assert.equal((await api('POST', '/turmas', { token: tk.tecA, body: { ...base, data_fim: somarDias(HOJE, -1) } })).status, 400);
  assert.equal((await api('POST', '/turmas', { token: tk.tecA, body: { ...base, treinamento_id: 999 } })).status, 404);
  assert.equal((await api('POST', '/turmas', { token: tk.consultaA, body: base })).status, 403);

  const t = await api('POST', '/turmas', { token: tk.tecA, body: base });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.equal(t.body.carga_horaria, 8, 'carga do catálogo');
  ids.turmaHoje = t.body.id;

  const amanha = await api('POST', '/turmas', { token: tk.tecA, body: { ...base, data_inicio: somarDias(HOJE, 1), data_fim: somarDias(HOJE, 1) } });
  ids.turmaAmanha = amanha.body.id;

  const lista = await api('GET', '/turmas?hoje=true', { token: tk.tecA });
  assert.deepEqual(lista.body.map((x) => x.id), [ids.turmaHoje]);
  assert.equal((await api('GET', `/turmas/${ids.turmaHoje}`, { token: tk.tecB })).status, 404);
});

test('presença por QR + PIN: assinatura, duplicidade, PIN errado e dia errado', async () => {
  const assinar = (qr, pin, turma = ids.turmaHoje, token = tk.tecA) => api('POST', `/turmas/${turma}/presencas`, { token, body: { token: qr, pin } });

  const ok = await assinar(ids.ana.qr, '4821');
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.match(ok.body.codigo_verificacao, /^[A-HJ-NP-Z2-9]{8}$/);
  ids.presencaAna = ok.body.id;
  ids.codigoPresenca = ok.body.codigo_verificacao;

  assert.equal((await assinar(ids.ana.qr, '4821')).status, 409, 'já assinou hoje');
  assert.equal((await assinar(ids.sergio.qr, '000000')).status, 422, 'PIN errado');
  assert.equal((await assinar(ids.ana.qr, '4821', ids.turmaAmanha)).status, 409, 'fora dos dias da turma');
  assert.equal((await assinar(ids.ana.qr, '4821', ids.turmaHoje, tk.tecB)).status, 404, 'turma de outra filial');
  assert.equal((await assinar('token-qualquer', '4821')).status, 404);

  const p = await amb.knex('turma_presencas').where({ id: ids.presencaAna }).first();
  assert.equal(p.metodo_assinatura, 'qr_pin');
  assert.equal(p.pin_validado, true);
  assert.equal(p.funcao_id, ids.eletricista);
  assert.ok(p.ip && p.user_agent);
});

test('anulação de presença (gestão) permite assinar de novo', async () => {
  assert.equal((await api('POST', `/presencas/${ids.presencaAna}/anular`, { token: tk.tecA, body: { motivo: 'assinou na turma errada' } })).status, 403);
  assert.equal((await api('POST', `/presencas/${ids.presencaAna}/anular`, { token: tk.gestorA, body: {} })).status, 400);
  assert.equal((await api('POST', `/presencas/${ids.presencaAna}/anular`, { token: tk.gestorA, body: { motivo: 'Teste de anulação' } })).status, 201);
  assert.equal((await api('POST', `/presencas/${ids.presencaAna}/anular`, { token: tk.gestorA, body: { motivo: 'Teste de anulação' } })).status, 409);

  const de_novo = await api('POST', `/turmas/${ids.turmaHoje}/presencas`, { token: tk.tecA, body: { token: ids.ana.qr, pin: '4821' } });
  assert.equal(de_novo.status, 201);
  ids.codigoPresenca = de_novo.body.codigo_verificacao;

  const turma = (await api('GET', `/turmas/${ids.turmaHoje}`, { token: tk.consultaA })).body;
  assert.equal(turma.presencas.length, 2);
  assert.equal(turma.presencas.filter((p) => p.anulada).length, 1);
});

test('encerramento: gera capacitação com vencimento e fecha a turma', async () => {
  assert.equal((await api('POST', `/turmas/${ids.turmaAmanha}/encerrar`, { token: tk.tecA, body: {} })).status, 409, 'antes do último dia');
  assert.equal((await api('POST', `/turmas/${ids.turmaHoje}/encerrar`, { token: tk.tecA, body: { resultados: [{ funcionario_id: ids.sergio.id, aprovado: true }] } })).status, 400, 'sem presença');

  const enc = await api('POST', `/turmas/${ids.turmaHoje}/encerrar`, { token: tk.tecA, body: {} });
  assert.equal(enc.status, 200, JSON.stringify(enc.body));
  assert.equal(enc.body.status, 'encerrada');
  assert.equal(enc.body.resultados.length, 1);
  const r = enc.body.resultados[0];
  assert.deepEqual([r.funcionario_id, r.status, r.frequencia, r.data_vencimento], [ids.ana.id, 'Aprovado', 100, somarMeses(HOJE, 24)]);
  ids.certAna35 = r.certificado_id;
  ids.codigoCert = r.codigo_verificacao;

  assert.equal((await api('POST', `/turmas/${ids.turmaHoje}/presencas`, { token: tk.tecA, body: { token: ids.sergio.qr, pin: '905172' } })).status, 409, 'turma encerrada');
  assert.equal((await api('POST', `/turmas/${ids.turmaHoje}/encerrar`, { token: tk.tecA, body: {} })).status, 409);
  assert.equal((await api('PUT', `/turmas/${ids.turmaHoje}`, { token: tk.tecA, body: { local: 'Outro' } })).status, 409);
});

test('turma de vários dias lançada a partir de lista em papel: frequência define o resultado', async () => {
  const inicio = somarDias(HOJE, -10);
  const fim = somarDias(HOJE, -8);
  const t = await api('POST', '/turmas', { token: tk.gestorA, body: { treinamento_id: ids.nr10, filial_id: ids.A, data_inicio: inicio, data_fim: fim, instrutor_nome: 'Eng. Paula Reis', carga_horaria: 40 } });
  ids.turmaNr10 = t.body.id;

  const manual = (funcionario_id, data_presenca, token = tk.gestorA, observacao = 'Lista de presença em papel digitalizada') =>
    api('POST', `/turmas/${ids.turmaNr10}/presencas/manual`, { token, body: { funcionario_id, data_presenca, observacao } });
  assert.equal((await manual(ids.ana.id, inicio, tk.tecA)).status, 403);
  assert.equal((await manual(ids.ana.id, inicio, tk.gestorA, 'curta')).status, 400);
  assert.equal((await manual(ids.ana.id, somarDias(HOJE, -20))).status, 400, 'fora do período');

  for (const dia of [inicio, somarDias(inicio, 1), fim]) assert.equal((await manual(ids.ana.id, dia)).status, 201);
  for (const dia of [inicio, somarDias(inicio, 1)]) assert.equal((await manual(ids.sergio.id, dia)).status, 201);

  const enc = await api('POST', `/turmas/${ids.turmaNr10}/encerrar`, { token: tk.gestorA, body: {} });
  assert.equal(enc.status, 200);
  const porFunc = Object.fromEntries(enc.body.resultados.map((r) => [r.funcionario_id, r]));
  assert.deepEqual([porFunc[ids.ana.id].status, porFunc[ids.ana.id].frequencia], ['Aprovado', 100]);
  assert.deepEqual([porFunc[ids.sergio.id].status, porFunc[ids.sergio.id].frequencia, porFunc[ids.sergio.id].data_vencimento], ['Reprovado', 67, null]);
  assert.equal(porFunc[ids.ana.id].data_vencimento, somarMeses(fim, 24));
  ids.certSergioReprovado = porFunc[ids.sergio.id].certificado_id;
});

test('resultado definido pelo instrutor sobrepõe a frequência', async () => {
  const t = await api('POST', '/turmas', { token: tk.tecA, body: { treinamento_id: ids.nr35, filial_id: ids.A, data_inicio: HOJE, data_fim: HOJE, instrutor_nome: 'Carlos Pereira' } });
  await api('POST', `/turmas/${t.body.id}/presencas`, { token: tk.tecA, body: { token: ids.sergio.qr, pin: '905172' } });
  const enc = await api('POST', `/turmas/${t.body.id}/encerrar`, { token: tk.tecA, body: { resultados: [{ funcionario_id: ids.sergio.id, aprovado: false }] } });
  assert.equal(enc.body.resultados[0].status, 'Reprovado', 'reprovado na avaliação prática');
});

test('certificado externo com arquivo; anulação', async () => {
  const base = { funcionario_id: ids.sergio.id, treinamento_id: ids.nr10, instituicao: 'Escola Técnica X', arquivo: pdf() };
  assert.equal((await api('POST', '/certificados', { token: tk.tecA, body: { ...base, arquivo: undefined, data_realizacao: '2025-01-01' } })).status, 400);
  assert.equal((await api('POST', '/certificados', { token: tk.tecA, body: { ...base, data_realizacao: somarDias(HOJE, 1) } })).status, 400);
  assert.equal((await api('POST', '/certificados', { token: tk.tecB, body: { ...base, data_realizacao: '2025-01-01' } })).status, 404);

  // Feito há 3 anos: NR-10 (24 meses) vencido
  const antigo = await api('POST', '/certificados', { token: tk.tecA, body: { ...base, data_realizacao: somarMeses(HOJE, -36) } });
  assert.equal(antigo.status, 201, JSON.stringify(antigo.body));
  assert.equal(antigo.body.origem, 'externo');
  assert.equal(antigo.body.data_vencimento, somarMeses(HOJE, -12));
  ids.certExterno = antigo.body.id;

  const arq = await baixar(`/certificados/${ids.certExterno}/pdf`, tk.consultaA);
  assert.equal(arq.status, 200);
  assert.equal(arq.tipo, 'application/pdf');

  // Lançado errado e anulado: não conta
  const errado = await api('POST', '/certificados', { token: tk.tecA, body: { ...base, data_realizacao: HOJE } });
  assert.equal((await api('POST', `/certificados/${errado.body.id}/anular`, { token: tk.tecA, body: { motivo: 'certificado de outra pessoa' } })).status, 403);
  assert.equal((await api('POST', `/certificados/${errado.body.id}/anular`, { token: tk.gestorA, body: { motivo: 'Certificado de outra pessoa' } })).status, 201);
  assert.equal((await baixar(`/certificados/${errado.body.id}/pdf`, tk.gestorA)).status, 409);
});

test('pendências depois das turmas e certificados', async () => {
  // Sérgio: NR-35 reprovado (faltando) e NR-10 externo vencido. Ana: tudo em dia.
  const p = (await api('GET', '/treinamentos/pendencias?todas=true', { token: tk.gestorA })).body;
  const sit = Object.fromEntries(p.itens.map((i) => [`${i.funcionario}:${i.nr}`, i.situacao]));
  assert.deepEqual(sit, {
    'Ana Souza:NR-35': 'em_dia',
    'Ana Souza:NR-10': 'em_dia',
    'Sérgio Lima:NR-35': 'faltando',
    'Sérgio Lima:NR-10': 'vencido'
  });
  assert.deepEqual(p.resumo, { faltando: 1, vencido: 1, vencendo: 0, em_dia: 2 });

  // Vencendo: externo que vence em 10 dias
  await api('POST', '/certificados', {
    token: tk.tecA,
    body: { funcionario_id: ids.sergio.id, treinamento_id: ids.nr10, instituicao: 'Escola Técnica X', arquivo: pdf(), data_realizacao: somarDias(somarMeses(HOJE, -24), 10) }
  });
  const depois = (await api('GET', `/treinamentos/pendencias?funcionario_id=${ids.sergio.id}`, { token: tk.gestorA })).body;
  assert.deepEqual(depois.itens.map((i) => [i.nr, i.situacao]).sort(), [['NR-10', 'vencendo'], ['NR-35', 'faltando']]);
  assert.equal((await api('GET', '/treinamentos/pendencias?situacao=qualquer', { token: tk.gestorA })).status, 400);
});

test('PDFs: lista de presença e certificado', async () => {
  const lista = await baixar(`/turmas/${ids.turmaNr10}/lista-presenca`, tk.consultaA);
  assert.equal(lista.status, 200);
  assert.equal(lista.bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await baixar(`/turmas/${ids.turmaNr10}/lista-presenca`, tk.tecB)).status, 404);

  const cert = await baixar(`/certificados/${ids.certAna35}/pdf`, tk.consultaA);
  assert.equal(cert.status, 200);
  assert.equal(cert.bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await baixar(`/certificados/${ids.certSergioReprovado}/pdf`, tk.gestorA)).status, 409, 'reprovado não tem certificado');
});

test('verificação pública de presença e certificado', async () => {
  const p = await api('GET', `/verificar/${ids.codigoPresenca}`);
  assert.equal(p.status, 200);
  assert.equal(p.body.tipo, 'presenca_treinamento');
  assert.equal(p.body.treinamento, 'Trabalho em altura (NR-35)');
  assert.equal(p.body.funcionario, 'A. S.');
  assert.equal(p.body.anulada, false);

  const c = await api('GET', `/verificar/${ids.codigoCert}`);
  assert.equal(c.body.tipo, 'certificado_treinamento');
  assert.equal(c.body.resultado, 'Aprovado');
  assert.equal(c.body.valido_ate, somarMeses(HOJE, 24));
  assert.equal(JSON.stringify(c.body).includes('Souza'), false);
});

test('cancelamento de turma (gestão)', async () => {
  assert.equal((await api('POST', `/turmas/${ids.turmaAmanha}/cancelar`, { token: tk.tecA, body: { motivo: 'instrutor doente' } })).status, 403);
  const c = await api('POST', `/turmas/${ids.turmaAmanha}/cancelar`, { token: tk.gestorA, body: { motivo: 'Instrutor indisponível' } });
  assert.equal(c.status, 200);
  assert.equal(c.body.status, 'cancelada');
  assert.equal((await api('POST', `/turmas/${ids.turmaAmanha}/cancelar`, { token: tk.gestorA, body: { motivo: 'de novo' } })).status, 409);
});

test('auditoria de treinamentos', async () => {
  const acoes = (await api('GET', '/auditoria?limite=1000', { token: tk.admin })).body.map((l) => l.acao);
  for (const acao of ['definir_exigencias', 'assinar_presenca', 'presenca_manual', 'anular_presenca', 'encerrar', 'cancelar', 'certificado_externo', 'anular_certificado', 'emitir_lista_presenca', 'emitir_certificado']) {
    assert.ok(acoes.includes(acao), `falta auditoria de ${acao}`);
  }
});
