// Etapa 1: filiais, prédios, setores, funções, usuários com permissão por filial, lotação e auditoria.
// Roda com: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente } = require('./ambiente');

// Documentos válidos (dígitos verificadores corretos), fictícios
const CNPJ = ['11222333000181', '11222333000262', '11222333000343'];
const CPF = ['52998224725', '12345678909', '98765432100', '11144477735', '22233344405'];

let amb;
const tk = {};   // tokens por usuário
const ids = {};  // ids criados durante os testes

before(async () => {
  amb = await iniciarAmbiente();
  await amb.criarUsuarioNoBanco({ nome: 'Eng. Matriz', email: 'admin@teste.com', senha: 'senha-admin', perfil: 'admin' });
  tk.admin = await amb.login('admin@teste.com', 'senha-admin');
});

after(async () => {
  if (amb) await amb.encerrar();
});

const api = (...args) => amb.chamar(...args);

test('rotas públicas e autenticação básica', async () => {
  assert.equal((await api('GET', '/ping')).status, 200);
  assert.equal((await api('GET', '/leitor.html')).status, 200);
  assert.equal((await api('GET', '/funcionarios')).status, 401);
  assert.equal((await api('GET', '/funcionarios', { token: 'lixo' })).status, 401);
  assert.equal((await api('POST', '/auth/login', { body: { email: 'admin@teste.com', senha: 'errada' } })).status, 401);

  const me = await api('GET', '/auth/me', { token: tk.admin });
  assert.equal(me.status, 200);
  assert.equal(me.body.perfil, 'admin');
});

test('filiais: só a matriz cadastra, com CNPJ e UF validados', async () => {
  const guaiba = await api('POST', '/filiais', {
    token: tk.admin,
    body: { nome: 'Campus Guaíba', tipo: 'Campus', cnpj: '11.222.333/0001-81', uf: 'rs', cidade: 'Guaíba', bairro: 'Centro', cep: '92500-000' }
  });
  assert.equal(guaiba.status, 201, JSON.stringify(guaiba.body));
  assert.equal(guaiba.body.cnpj, CNPJ[0]);   // guardado só com dígitos
  assert.equal(guaiba.body.uf, 'RS');
  ids.filialA = guaiba.body.id;

  const colegio = await api('POST', '/filiais', {
    token: tk.admin,
    body: { nome: 'Colégio Exemplo', tipo: 'Colégio', cnpj: CNPJ[1], uf: 'RS', cidade: 'Porto Alegre', bairro: 'Centro Histórico' }
  });
  assert.equal(colegio.status, 201);
  ids.filialB = colegio.body.id;

  const base = { nome: 'X', uf: 'RS', cidade: 'Y', bairro: 'Z' };
  assert.equal((await api('POST', '/filiais', { token: tk.admin, body: { ...base, cnpj: '11222333000180' } })).status, 400, 'CNPJ com dígito errado');
  assert.equal((await api('POST', '/filiais', { token: tk.admin, body: { ...base, cnpj: CNPJ[2], uf: 'XX' } })).status, 400, 'UF inválida');
  assert.equal((await api('POST', '/filiais', { token: tk.admin, body: { ...base, cnpj: CNPJ[0] } })).status, 409, 'CNPJ repetido');
  const faltando = await api('POST', '/filiais', { token: tk.admin, body: { nome: 'Sem dados' } });
  assert.equal(faltando.status, 400);
  assert.deepEqual(faltando.body.campos, ['cnpj', 'uf', 'cidade', 'bairro']);

  const filtro = await api('GET', '/filiais?cidade=Guaíba', { token: tk.admin });
  assert.deepEqual(filtro.body.map((f) => f.id), [ids.filialA]);
});

test('setores, prédios e funções', async () => {
  const setor = async (filial_id, nome) =>
    (await api('POST', '/setores', { token: tk.admin, body: { filial_id, nome, centro_custo: 'CC-' + nome } })).body.id;
  ids.setorA1 = await setor(ids.filialA, 'Manutenção');
  ids.setorA2 = await setor(ids.filialA, 'Limpeza');
  ids.setorB1 = await setor(ids.filialB, 'Manutenção');
  assert.equal((await api('POST', '/setores', { token: tk.admin, body: { filial_id: ids.filialA, nome: 'Manutenção' } })).status, 409, 'setor repetido na filial');

  for (let i = 1; i <= 3; i++) {
    const r = await api('POST', '/predios', { token: tk.admin, body: { filial_id: ids.filialA, nome: `Prédio ${i}`, area_m2: 1200.5 } });
    assert.equal(r.status, 201);
  }
  const show = await api('GET', `/filiais/${ids.filialA}`, { token: tk.admin });
  assert.equal(show.body.predios.length, 3);
  assert.equal(show.body.setores.length, 2);

  const eletricista = await api('POST', '/funcoes', { token: tk.admin, body: { nome: 'Eletricista', cbo: '7156-10' } });
  assert.equal(eletricista.status, 201);
  assert.equal(eletricista.body.cbo, '715610');
  ids.funcao1 = eletricista.body.id;
  ids.funcao2 = (await api('POST', '/funcoes', { token: tk.admin, body: { nome: 'Auxiliar de limpeza' } })).body.id;
  assert.equal((await api('POST', '/funcoes', { token: tk.admin, body: { nome: 'X', cbo: '12' } })).status, 400, 'CBO inválido');
});

test('usuários: só a matriz cria; perfis não-admin precisam de filial', async () => {
  const criar = (body) => api('POST', '/usuarios', { token: tk.admin, body });

  assert.equal((await criar({ nome: 'Sem filial', email: 'x@teste.com', senha: '12345678', perfil: 'tecnico' })).status, 400);
  assert.equal((await criar({ nome: 'Filial falsa', email: 'x@teste.com', senha: '12345678', perfil: 'tecnico', filiais: [999] })).status, 400);
  assert.equal((await criar({ nome: 'Perfil falso', email: 'x@teste.com', senha: '12345678', perfil: 'root', filiais: [ids.filialA] })).status, 400);

  const usuarios = [
    ['gestorA', 'gestor', [ids.filialA]],
    ['tecnicoA', 'tecnico', [ids.filialA]],
    ['tecnicoB', 'tecnico', [ids.filialB]],
    ['saudeA', 'saude', [ids.filialA]],
    ['consultaAB', 'consulta', [ids.filialA, ids.filialB]]
  ];
  for (const [nome, perfil, filiais] of usuarios) {
    const r = await criar({ nome, email: `${nome}@teste.com`, senha: 'senha1234', perfil, filiais });
    assert.equal(r.status, 201, `${nome}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.filiais.length, filiais.length);
    ids[nome] = r.body.id;
    tk[nome] = await amb.login(`${nome}@teste.com`, 'senha1234');
  }
  assert.equal((await criar({ nome: 'dup', email: 'GESTORA@teste.com', senha: 'senha1234', perfil: 'gestor', filiais: [ids.filialA] })).status, 409);

  // O gestor da filial não cria usuários, filiais, funções nem EPIs
  assert.equal((await api('POST', '/usuarios', { token: tk.gestorA, body: { nome: 'a', email: 'a@a.com', senha: '12345678', filiais: [ids.filialA] } })).status, 403);
  assert.equal((await api('POST', '/filiais', { token: tk.gestorA, body: {} })).status, 403);
  assert.equal((await api('POST', '/funcoes', { token: tk.gestorA, body: { nome: 'Y' } })).status, 403);
  assert.equal((await api('POST', '/epis', { token: tk.gestorA, body: { nome: 'Luva', ca: '1', validade_dias: 30 } })).status, 403);

  // Login devolve as filiais em que o usuário atua
  const me = await api('GET', '/auth/me', { token: tk.consultaAB });
  assert.deepEqual(me.body.filiais.map((f) => f.id).sort(), [ids.filialA, ids.filialB].sort());
  const filiaisTecB = await api('GET', '/filiais', { token: tk.tecnicoB });
  assert.deepEqual(filiaisTecB.body.map((f) => f.id), [ids.filialB]);
  assert.equal((await api('GET', `/filiais/${ids.filialA}`, { token: tk.tecnicoB })).status, 403);
});

test('gestor cadastra setor/prédio só na própria filial', async () => {
  assert.equal((await api('POST', '/setores', { token: tk.gestorA, body: { filial_id: ids.filialA, nome: 'Portaria' } })).status, 201);
  assert.equal((await api('POST', '/setores', { token: tk.gestorA, body: { filial_id: ids.filialB, nome: 'Portaria' } })).status, 403);
  assert.equal((await api('POST', '/predios', { token: tk.tecnicoA, body: { filial_id: ids.filialA, nome: 'Prédio 9' } })).status, 403, 'técnico não cadastra prédio');

  const setoresTecB = await api('GET', '/setores', { token: tk.tecnicoB });
  assert.ok(setoresTecB.body.every((s) => s.filial_id === ids.filialB));
});

test('funcionários: cadastro com lotação, validações e matrícula por CNPJ', async () => {
  const base = {
    matricula: '1001', nome: 'Ana Souza', cpf: '529.982.247-25', data_nascimento: '1990-05-10',
    data_admissao: '2024-01-15', filial_id: ids.filialA, setor_id: ids.setorA1, funcao_id: ids.funcao1
  };
  const criar = (token, body) => api('POST', '/funcionarios', { token, body });

  assert.equal((await criar(tk.gestorA, { ...base, cpf: '52998224724' })).status, 400, 'CPF inválido');
  assert.equal((await criar(tk.gestorA, { ...base, setor_id: ids.setorB1 })).status, 400, 'setor de outra filial');
  assert.equal((await criar(tk.gestorA, { ...base, data_admissao: '2024-02-31' })).status, 400, 'data inexistente');
  assert.equal((await criar(tk.gestorA, { ...base, filial_id: ids.filialB, setor_id: ids.setorB1 })).status, 403, 'gestor em filial alheia');
  assert.equal((await criar(tk.tecnicoA, base)).status, 403, 'técnico não cadastra funcionário');

  const ana = await criar(tk.gestorA, base);
  assert.equal(ana.status, 201, JSON.stringify(ana.body));
  assert.match(ana.body.qr_token, /^[0-9a-f-]{36}$/);
  ids.ana = ana.body.id;
  ids.tokenAna = ana.body.qr_token;

  assert.equal((await criar(tk.gestorA, { ...base, nome: 'Outra' })).status, 409, 'mesma matrícula na mesma filial');

  // Mesma matrícula em outro CNPJ é permitida
  const bruno = await criar(tk.admin, {
    ...base, nome: 'Bruno Lima', cpf: CPF[1], filial_id: ids.filialB, setor_id: ids.setorB1, funcao_id: ids.funcao2
  });
  assert.equal(bruno.status, 201);
  ids.bruno = bruno.body.id;
  ids.tokenBruno = bruno.body.qr_token;

  assert.equal((await criar(tk.admin, { ...base, matricula: '2002', nome: 'CPF repetido', filial_id: ids.filialB, setor_id: ids.setorB1 })).status, 409, 'CPF único no grupo');

  const lot = await api('GET', `/funcionarios/${ids.ana}/lotacoes`, { token: tk.gestorA });
  assert.equal(lot.body.length, 1);
  assert.equal(lot.body[0].inicio, '2024-01-15');
  assert.equal(lot.body[0].fim, null);
  assert.equal(lot.body[0].cnpj, CNPJ[0]);
});

test('escopo: cada filial só enxerga os seus funcionários', async () => {
  const listaB = await api('GET', '/funcionarios', { token: tk.tecnicoB });
  assert.deepEqual(listaB.body.map((f) => f.id), [ids.bruno]);

  assert.equal((await api('GET', `/funcionarios/${ids.ana}`, { token: tk.tecnicoB })).status, 404);
  assert.equal((await api('GET', `/funcionarios/${ids.ana}/qrcode`, { token: tk.tecnicoB })).status, 404);
  assert.equal((await api('GET', `/funcionarios/${ids.ana}/lotacoes`, { token: tk.tecnicoB })).status, 404);
  assert.equal((await api('GET', `/funcionarios/qr/${ids.tokenAna}`, { token: tk.tecnicoB })).status, 404);

  const qr = await api('GET', `/funcionarios/${ids.ana}/qrcode`, { token: tk.tecnicoA });
  assert.equal(qr.status, 200);
  assert.equal(qr.headers.get('content-type'), 'image/png');

  // CPF completo só para admin/gestor/saúde
  const consulta = await api('GET', '/funcionarios', { token: tk.consultaAB });
  assert.equal(consulta.body.length, 2);
  assert.ok(consulta.body.every((f) => f.cpf.startsWith('***.')));
  const gestor = await api('GET', `/funcionarios/${ids.ana}`, { token: tk.gestorA });
  assert.equal(gestor.body.cpf, CPF[0]);
  assert.equal(gestor.body.setor, 'Manutenção');
  assert.equal(gestor.body.funcao, 'Eletricista');

  const busca = await api('GET', '/funcionarios?busca=ana', { token: tk.admin });
  assert.deepEqual(busca.body.map((f) => f.id), [ids.ana]);
});

test('entrega por QR respeita perfil e filial', async () => {
  const epi = await api('POST', '/epis', {
    token: tk.admin, body: { nome: 'Luva nitrílica', validade_dias: 30, ca: { numero: '12345', validade: '2099-12-31' } }
  });
  assert.equal(epi.status, 201, JSON.stringify(epi.body));
  ids.epi = epi.body.id;
  ids.item = epi.body.itens[0].id;

  const entrada = await api('POST', '/estoque/entradas', {
    token: tk.tecnicoA, body: { filial_id: ids.filialA, item_id: ids.item, quantidade: 10, valor_unitario: 3.5 }
  });
  assert.equal(entrada.status, 201, JSON.stringify(entrada.body));
  assert.equal((await api('POST', '/estoque/entradas', {
    token: tk.tecnicoA, body: { filial_id: ids.filialB, item_id: ids.item, quantidade: 10, valor_unitario: 3.5 }
  })).status, 403, 'entrada em filial alheia');

  const leitura = await api('GET', `/funcionarios/qr/${ids.tokenAna}`, { token: tk.tecnicoA });
  assert.equal(leitura.status, 200);
  assert.equal(leitura.body.funcionario.cargo, 'Eletricista');
  assert.equal(leitura.body.funcionario.filial, 'Campus Guaíba');
  assert.equal(leitura.body.funcionario.cpf, undefined);

  assert.equal((await api('POST', `/funcionarios/qr/${ids.tokenAna}/pin`, { token: tk.tecnicoA, body: { pin: '4821' } })).status, 201);
  const entrega = await api('POST', '/entregas/qr', { token: tk.tecnicoA, body: { token: ids.tokenAna, pin: '4821', item_id: ids.item, quantidade: 2 } });
  assert.equal(entrega.status, 201, JSON.stringify(entrega.body));

  assert.equal((await api('POST', '/entregas/qr', { token: tk.tecnicoB, body: { token: ids.tokenAna, pin: '4821', item_id: ids.item } })).status, 404, 'crachá de outra filial');
  assert.equal((await api('POST', '/entregas/qr', { token: tk.consultaAB, body: { token: ids.tokenAna, pin: '4821', item_id: ids.item } })).status, 403, 'consulta não entrega');

  const entregasB = await api('GET', '/entregas', { token: tk.tecnicoB });
  assert.equal(entregasB.body.length, 0);
  const entregasA = await api('GET', '/entregas', { token: tk.tecnicoA });
  assert.equal(entregasA.body.length, 1);
  assert.equal(entregasA.body[0].filial, 'Campus Guaíba');

  // EPI inativado não pode mais ser entregue
  assert.equal((await api('PUT', `/epis/${ids.epi}`, { token: tk.admin, body: { ativo: false } })).status, 200);
  assert.equal((await api('POST', '/entregas/qr', { token: tk.tecnicoA, body: { token: ids.tokenAna, pin: '4821', item_id: ids.item } })).status, 404);
  await api('PUT', `/epis/${ids.epi}`, { token: tk.admin, body: { ativo: true } });
});

test('mudança de setor e de filial gera histórico de lotação', async () => {
  const r = await api('PUT', `/funcionarios/${ids.ana}`, {
    token: tk.gestorA, body: { setor_id: ids.setorA2, funcao_id: ids.funcao2, data_mudanca: '2025-03-01' }
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.setor, 'Limpeza');

  let lot = (await api('GET', `/funcionarios/${ids.ana}/lotacoes`, { token: tk.gestorA })).body;
  assert.equal(lot.length, 2);
  assert.deepEqual([lot[0].inicio, lot[0].fim, lot[0].setor], ['2025-03-01', null, 'Limpeza']);
  assert.deepEqual([lot[1].inicio, lot[1].fim, lot[1].setor], ['2024-01-15', '2025-02-28', 'Manutenção']);

  assert.equal((await api('PUT', `/funcionarios/${ids.ana}`, {
    token: tk.gestorA, body: { setor_id: ids.setorA1, data_mudanca: '2025-01-01' }
  })).status, 400, 'mudança antes da lotação atual');

  // Gestor da A não transfere para a B (não tem acesso à B)
  assert.equal((await api('PUT', `/funcionarios/${ids.ana}`, {
    token: tk.gestorA, body: { filial_id: ids.filialB, setor_id: ids.setorB1, data_mudanca: '2025-06-01' }
  })).status, 403);

  // Na transferência entre CNPJs a matrícula muda: a 1001 já é do Bruno na filial B
  assert.equal((await api('PUT', `/funcionarios/${ids.ana}`, {
    token: tk.admin, body: { filial_id: ids.filialB, setor_id: ids.setorB1, data_mudanca: '2025-06-01' }
  })).status, 409, 'matrícula já usada na filial de destino');

  // A matriz transfere; a partir daí a filial A deixa de vê-la
  const transf = await api('PUT', `/funcionarios/${ids.ana}`, {
    token: tk.admin, body: { matricula: '3003', filial_id: ids.filialB, setor_id: ids.setorB1, data_mudanca: '2025-06-01' }
  });
  assert.equal(transf.status, 200, JSON.stringify(transf.body));
  assert.equal(transf.body.filial, 'Colégio Exemplo');
  assert.equal((await api('GET', `/funcionarios/${ids.ana}`, { token: tk.gestorA })).status, 404);
  assert.equal((await api('GET', `/funcionarios/${ids.ana}`, { token: tk.tecnicoB })).status, 200);

  lot = (await api('GET', `/funcionarios/${ids.ana}/lotacoes`, { token: tk.admin })).body;
  assert.equal(lot.length, 3);
  assert.equal(lot[0].filial, 'Colégio Exemplo');
  assert.equal(lot[1].fim, '2025-05-31');
});

test('desligamento: não apaga, bloqueia entrega e fecha a lotação', async () => {
  const r = await api('PUT', `/funcionarios/${ids.bruno}`, {
    token: tk.admin, body: { status: 'Desligado', data_demissao: '2026-10-31' }
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data_demissao, '2026-10-31');

  const lot = (await api('GET', `/funcionarios/${ids.bruno}/lotacoes`, { token: tk.admin })).body;
  assert.equal(lot[0].fim, '2026-10-31');

  await amb.knex('funcionarios').where({ id: ids.bruno }).update({ pin_hash: await require('bcryptjs').hash('7395', 4) });
  const entrega = await api('POST', '/entregas/qr', { token: tk.tecnicoB, body: { token: ids.tokenBruno, pin: '7395', item_id: ids.item } });
  assert.equal(entrega.status, 409);
  assert.match(entrega.body.error, /Desligado/);

  assert.equal((await api('PUT', `/funcionarios/${ids.bruno}`, { token: tk.admin, body: { status: 'Sumido' } })).status, 400);

  // Readmissão abre nova lotação
  const volta = await api('PUT', `/funcionarios/${ids.bruno}`, { token: tk.admin, body: { status: 'Ativo', data_mudanca: '2026-11-10' } });
  assert.equal(volta.status, 200);
  assert.equal(volta.body.data_demissao, null);
  const lot2 = (await api('GET', `/funcionarios/${ids.bruno}/lotacoes`, { token: tk.admin })).body;
  assert.equal(lot2.length, 2);
  assert.deepEqual([lot2[0].inicio, lot2[0].fim], ['2026-11-10', null]);
});

test('nada com histórico é apagado', async () => {
  // As rotas DELETE não existem mais
  assert.equal((await api('DELETE', `/funcionarios/${ids.ana}`, { token: tk.admin })).status, 404);
  assert.equal((await api('DELETE', `/epis/${ids.epi}`, { token: tk.admin })).status, 404);

  // E o banco recusa apagar direto (RESTRICT em vez de CASCADE)
  await assert.rejects(amb.knex('funcionarios').where({ id: ids.ana }).del(), (e) => e.code === '23503');
  await assert.rejects(amb.knex('epis').where({ id: ids.epi }).del(), (e) => e.code === '23503');
  await assert.rejects(amb.knex('filiais').where({ id: ids.filialA }).del(), (e) => e.code === '23503');
});

test('funcionário antigo (sem filial) continua editável pela matriz e invisível para filiais', async () => {
  const [legado] = await amb.knex('funcionarios').insert({
    matricula: 'OLD1', nome: 'Legado', cpf: CPF[3], data_nascimento: '1980-01-01',
    cargo: 'Pedreiro', setor: 'Obras', data_admissao: '2010-01-01', status: 'Ativo', qr_token: '00000000-0000-0000-0000-000000000001'
  }).returning('id');

  const r = await api('PUT', `/funcionarios/${legado.id}`, { token: tk.admin, body: { nome: 'Legado Renomeado' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.funcao, 'Pedreiro');
  assert.equal((await api('GET', `/funcionarios/${legado.id}`, { token: tk.consultaAB })).status, 404);
});

test('auditoria registra quem fez o quê, sem vazar segredos', async () => {
  const log = await api('GET', `/auditoria?tabela=funcionarios&registro_id=${ids.ana}`, { token: tk.admin });
  assert.equal(log.status, 200);
  const acoes = log.body.map((l) => l.acao);
  assert.ok(acoes.includes('criar'));
  assert.equal(acoes.filter((a) => a === 'alterar').length, 2);
  const criacao = log.body.find((l) => l.acao === 'criar');
  assert.equal(criacao.usuario, 'gestorA');
  assert.equal(criacao.depois.qr_token, '[oculto]');

  const usuarios = await api('GET', `/auditoria?tabela=usuarios&registro_id=${ids.gestorA}&acao=criar`, { token: tk.admin });
  assert.equal(usuarios.body.length, 1);
  assert.equal(usuarios.body[0].depois.senha_hash, undefined);

  const logins = await api('GET', '/auditoria?acao=login', { token: tk.admin });
  assert.ok(logins.body.length >= 6);

  assert.equal((await api('GET', '/auditoria', { token: tk.gestorA })).status, 403);
});

test('alterações de usuário valem na hora, sem esperar o token expirar', async () => {
  // Desativado: o token que ele já tem para de funcionar
  assert.equal((await api('PUT', `/usuarios/${ids.tecnicoA}`, { token: tk.admin, body: { ativo: false } })).status, 200);
  assert.equal((await api('GET', '/funcionarios', { token: tk.tecnicoA })).status, 401);
  assert.equal((await api('POST', '/auth/login', { body: { email: 'tecnicoA@teste.com', senha: 'senha1234' } })).status, 401);

  // Ganhou a filial A: passa a ver os funcionários dela imediatamente
  const r = await api('PUT', `/usuarios/${ids.tecnicoB}`, { token: tk.admin, body: { filiais: [ids.filialA, ids.filialB] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.filiais.length, 2);
  const lista = await api('GET', '/funcionarios', { token: tk.tecnicoB });
  assert.ok(lista.body.length >= 2);

  // Promovido a admin: filiais deixam de importar
  const promovido = await api('PUT', `/usuarios/${ids.gestorA}`, { token: tk.admin, body: { perfil: 'admin' } });
  assert.equal(promovido.status, 200);
  assert.equal(promovido.body.filiais.length, 0);
  assert.equal((await api('GET', '/auditoria', { token: tk.gestorA })).status, 200);

  // Rebaixar sem informar filial: erro
  assert.equal((await api('PUT', `/usuarios/${ids.gestorA}`, { token: tk.admin, body: { perfil: 'gestor' } })).status, 400);

  // A matriz não se desativa por engano
  const eu = (await api('GET', '/auth/me', { token: tk.admin })).body.id;
  assert.equal((await api('PUT', `/usuarios/${eu}`, { token: tk.admin, body: { ativo: false } })).status, 400);
});

test('erros de entrada viram 400, não 500', async () => {
  assert.equal((await api('GET', '/funcionarios/abc', { token: tk.admin })).status, 404);
  assert.equal((await api('GET', '/funcionarios?filial_id=abc', { token: tk.admin })).status, 400);

  const jsonQuebrado = await fetch(amb.base + '/filiais', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tk.admin}`, 'Content-Type': 'application/json' },
    body: '{ "nome": '
  });
  assert.equal(jsonQuebrado.status, 400);
});

test('migrations desfazem e refazem sem erro (banco vazio)', async () => {
  const tabelas = await amb.knex('pg_tables').where({ schemaname: 'public' })
    .whereNotIn('tablename', ['knex_migrations', 'knex_migrations_lock']).pluck('tablename');
  // As tabelas de prova recusam TRUNCATE (etapa 8): só um superusuário, desligando os gatilhos nesta transação, esvazia o banco
  await amb.knex.transaction(async (trx) => {
    await trx.raw('set local session_replication_role = replica');
    await trx.raw(`TRUNCATE ${tabelas.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  });

  await amb.knex.migrate.rollback(undefined, true);
  assert.equal(await amb.knex.schema.hasTable('filiais'), false);
  await amb.knex.migrate.latest();
  assert.equal(await amb.knex.schema.hasTable('auditoria'), true);
});
