// Etapa 2: catálogo com CA, estoque por filial em lotes (PEPS), entrega com QR + PIN + foto,
// estornos, transferências, termo de adesão, ficha de EPI em PDF e verificação pública.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { iniciarAmbiente } = require('./ambiente');
const { hoje, somarDias } = require('../src/utils/datas');

let amb;
const tk = {};
const ids = {};
const api = (...args) => amb.chamar(...args);

// "Arquivos" mínimos: o sistema confere o tipo pelos primeiros bytes
const jpeg = (tamanho = 2000) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(tamanho)]).toString('base64');
const pdf = () => 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% termo de adesao assinado\n%%EOF').toString('base64');

before(async () => {
  amb = await iniciarAmbiente();
  await amb.criarUsuarioNoBanco({ nome: 'Matriz', email: 'admin@t.com', senha: 'senha-admin', perfil: 'admin' });
  tk.admin = await amb.login('admin@t.com', 'senha-admin');

  const filial = async (nome, cnpj) => (await api('POST', '/filiais', {
    token: tk.admin, body: { nome, cnpj, razao_social: `${nome} LTDA`, uf: 'RS', cidade: 'Guaíba', bairro: 'Centro' }
  })).body.id;
  ids.A = await filial('Campus Guaíba', '11222333000181');
  ids.B = await filial('Colégio Exemplo', '11222333000262');
  ids.setorA = (await api('POST', '/setores', { token: tk.admin, body: { filial_id: ids.A, nome: 'Manutenção' } })).body.id;
  ids.funcao = (await api('POST', '/funcoes', { token: tk.admin, body: { nome: 'Eletricista' } })).body.id;

  for (const [nome, perfil, filiais] of [['tecA', 'tecnico', [ids.A]], ['gestorA', 'gestor', [ids.A]], ['tecB', 'tecnico', [ids.B]], ['consultaA', 'consulta', [ids.A]]]) {
    await api('POST', '/usuarios', { token: tk.admin, body: { nome, email: `${nome}@t.com`, senha: 'senha1234', perfil, filiais } });
    tk[nome] = await amb.login(`${nome}@t.com`, 'senha1234');
  }

  const ana = await api('POST', '/funcionarios', {
    token: tk.gestorA,
    body: { matricula: '1001', nome: 'Ana Souza', cpf: '52998224725', data_nascimento: '1990-05-10', data_admissao: '2024-01-15', filial_id: ids.A, setor_id: ids.setorA, funcao_id: ids.funcao }
  });
  ids.ana = ana.body.id;
  ids.qrAna = ana.body.qr_token;
});

after(async () => { if (amb) await amb.encerrar(); });

test('catálogo: EPI com tamanhos e CA; só a matriz cadastra', async () => {
  const sem = await api('POST', '/epis', { token: tk.admin, body: { nome: 'Luva', validade_dias: 30 } });
  assert.equal(sem.status, 400, 'CA obrigatório');
  assert.equal((await api('POST', '/epis', { token: tk.admin, body: { nome: 'Luva', validade_dias: 30, ca: { numero: '123' } } })).status, 400, 'CA sem validade');
  assert.equal((await api('POST', '/epis', { token: tk.gestorA, body: { nome: 'Luva', validade_dias: 30, ca: { numero: '1', validade: '2099-01-01' } } })).status, 403);

  const luva = await api('POST', '/epis', {
    token: tk.admin,
    body: { nome: 'Luva nitrílica', categoria: 'Proteção das mãos', unidade: 'par', validade_dias: 30, tamanhos: ['P', 'M', 'G'], ca: { numero: 'CA 37.000', validade: '2099-12-31' } }
  });
  assert.equal(luva.status, 201, JSON.stringify(luva.body));
  assert.deepEqual(luva.body.itens.map((i) => i.tamanho), ['P', 'M', 'G']);
  assert.deepEqual(luva.body.ca_vigente, { numero: '37000', validade: '2099-12-31' });
  ids.luva = luva.body.id;
  ids.luvaM = luva.body.itens.find((i) => i.tamanho === 'M').id;
  ids.luvaG = luva.body.itens.find((i) => i.tamanho === 'G').id;

  const gg = await api('POST', `/epis/${ids.luva}/itens`, { token: tk.admin, body: { tamanho: 'GG' } });
  assert.equal(gg.status, 201);
  assert.equal((await api('POST', `/epis/${ids.luva}/itens`, { token: tk.admin, body: { tamanho: 'GG' } })).status, 409);
  assert.equal((await api('PUT', `/epi-itens/${gg.body.id}`, { token: tk.admin, body: { ativo: false } })).body.ativo, false);
});

test('CA vencido ou sem validade bloqueia a entrega', async () => {
  const capacete = await api('POST', '/epis', {
    token: tk.admin, body: { nome: 'Capacete', validade_dias: 365, ca: { numero: '555', validade: '2020-01-01' } }
  });
  ids.capacete = capacete.body.itens[0].id;
  assert.equal(capacete.body.ca_vigente, null);

  await api('POST', '/estoque/entradas', { token: tk.tecA, body: { filial_id: ids.A, item_id: ids.capacete, quantidade: 5, valor_unitario: 40 } });
  await api('POST', `/funcionarios/qr/${ids.qrAna}/pin`, { token: tk.tecA, body: { pin: '4821' } });

  const bloqueada = await api('POST', '/entregas/qr', { token: tk.tecA, body: { token: ids.qrAna, pin: '4821', item_id: ids.capacete } });
  assert.equal(bloqueada.status, 409);
  assert.match(bloqueada.body.error, /CA 555 vencido em 2020-01-01/);

  // Renovação do CA libera
  assert.equal((await api('POST', `/epis/${capacete.body.id}/cas`, { token: tk.admin, body: { numero: '555', validade: '2099-06-30' } })).status, 201);
  const ok = await api('POST', '/entregas/qr', { token: tk.tecA, body: { token: ids.qrAna, pin: '4821', item_id: ids.capacete } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.ca, { numero: '555', validade: '2099-06-30' });
});

test('entrada de estoque: validações', async () => {
  const base = { filial_id: ids.A, item_id: ids.luvaM, quantidade: 10, valor_unitario: 2 };
  const entrar = (body, token = tk.tecA) => api('POST', '/estoque/entradas', { token, body: { ...base, ...body } });
  assert.equal((await entrar({ valor_unitario: -1 })).status, 400);
  assert.equal((await entrar({ quantidade: 0 })).status, 400);
  assert.equal((await entrar({ data_entrada: somarDias(hoje(), 1) })).status, 400, 'data futura');
  assert.equal((await entrar({ data_validade: '2021-01-01' })).status, 400, 'lote vencido');
  assert.equal((await entrar({ filial_id: ids.B })).status, 403);
  assert.equal((await entrar({}, tk.consultaA)).status, 403);

  const fornB = await api('POST', '/fornecedores', { token: tk.admin, body: { filial_id: ids.B, nome: 'Fornecedor B', cnpj: '11222333000343' } });
  assert.equal(fornB.status, 201);
  assert.equal((await entrar({ fornecedor_id: fornB.body.id })).status, 400, 'fornecedor de outra filial');
  assert.equal((await api('POST', '/fornecedores', { token: tk.gestorA, body: { filial_id: ids.A, nome: 'X', cnpj: '123' } })).status, 400);
  ids.fornA = (await api('POST', '/fornecedores', { token: tk.gestorA, body: { filial_id: ids.A, nome: 'EPI Sul' } })).body.id;
});

test('PEPS: cada saída usa o preço do lote de onde saiu (2020 ≠ 2026)', async () => {
  const lote2020 = await api('POST', '/estoque/entradas', {
    token: tk.tecA, body: { filial_id: ids.A, item_id: ids.luvaM, quantidade: 10, valor_unitario: 2, data_entrada: '2020-03-10', fornecedor_id: ids.fornA, nota_numero: '123' }
  });
  assert.equal(lote2020.status, 201, JSON.stringify(lote2020.body));
  ids.lote2020 = lote2020.body.lote.id;
  const lote2026 = await api('POST', '/estoque/entradas', {
    token: tk.tecA, body: { filial_id: ids.A, item_id: ids.luvaM, quantidade: 10, valor_unitario: 5, data_entrada: '2026-01-10' }
  });
  ids.lote2026 = lote2026.body.lote.id;

  const e = await api('POST', '/entregas/qr', { token: tk.tecA, body: { token: ids.qrAna, pin: '4821', item_id: ids.luvaM, quantidade: 15, motivo: 'primeira_entrega' } });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  assert.equal(e.body.custo_total, 45); // 10 × R$2 (2020) + 5 × R$5 (2026), não 15 × média
  ids.entregaPeps = e.body.id;

  const movs = (await api('GET', `/estoque/movimentacoes?entrega_id=${e.body.id}`, { token: tk.gestorA })).body;
  assert.deepEqual(movs.map((m) => [m.lote_id, m.quantidade, m.valor_unitario]).sort(),
    [[ids.lote2020, -10, 2], [ids.lote2026, -5, 5]].sort());

  const saldo = (await api('GET', `/estoque/saldos?filial_id=${ids.A}`, { token: tk.gestorA })).body.find((s) => s.item_id === ids.luvaM);
  assert.equal(saldo.saldo, 5);
  assert.equal(saldo.valor, 25); // restam 5 do lote de 2026 a R$5

  // Pedido maior que o saldo: nada é gravado
  const antes = await amb.knex('movimentacoes').count({ n: '*' }).first();
  const falta = await api('POST', '/entregas/qr', { token: tk.tecA, body: { token: ids.qrAna, pin: '4821', item_id: ids.luvaM, quantidade: 6 } });
  assert.equal(falta.status, 409);
  assert.equal(falta.body.disponivel, 5);
  assert.deepEqual(await amb.knex('movimentacoes').count({ n: '*' }).first(), antes);
});

test('entrega grava as provas: CA, técnico, IP, aparelho, hora do servidor, código', async () => {
  const e = await amb.knex('entregas').where({ id: ids.entregaPeps }).first();
  assert.equal(e.ca_numero, '37000');
  assert.equal(e.ca_validade, '2099-12-31');
  assert.equal(e.metodo_assinatura, 'qr_pin');
  assert.equal(e.pin_validado, true);
  assert.equal(e.filial_id, ids.A);
  assert.equal(e.setor_id, ids.setorA);
  assert.equal(e.funcao_id, ids.funcao);
  assert.ok(e.usuario_id);
  assert.ok(e.ip);
  assert.ok(e.user_agent);
  assert.ok(e.data_hora instanceof Date);
  assert.match(e.codigo_verificacao, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(e.data_proxima_troca, somarDias(hoje(), 30));
  assert.equal(e.termo_adesao_vigente, false);
  assert.equal(e.motivo, 'primeira_entrega');
});

test('PIN: cadastro, PIN fraco, tentativas erradas e bloqueio', async () => {
  const sergio = await api('POST', '/funcionarios', {
    token: tk.gestorA,
    body: { matricula: '1002', nome: 'Sérgio Lima', cpf: '12345678909', data_nascimento: '1985-02-01', data_admissao: '2023-05-01', filial_id: ids.A, setor_id: ids.setorA, funcao_id: ids.funcao }
  });
  ids.sergio = sergio.body.id;
  ids.qrSergio = sergio.body.qr_token;
  const entregar = (pin) => api('POST', '/entregas/qr', { token: tk.tecA, body: { token: ids.qrSergio, pin, item_id: ids.luvaM } });

  const semPin = await entregar('1234');
  assert.equal(semPin.status, 409);
  assert.equal(semPin.body.codigo, 'PIN_NAO_DEFINIDO');

  const cadastrar = (pin) => api('POST', `/funcionarios/qr/${ids.qrSergio}/pin`, { token: tk.tecA, body: { pin } });
  assert.equal((await cadastrar('1234')).status, 400, 'sequência');
  assert.equal((await cadastrar('7777')).status, 400, 'repetido');
  assert.equal((await cadastrar('12a4')).status, 400, 'não numérico');
  assert.equal((await cadastrar('905172')).status, 201);
  assert.equal((await cadastrar('905173')).status, 409, 'já tem PIN');
  const f = await amb.knex('funcionarios').where({ id: ids.sergio }).first('pin_hash');
  assert.ok(f.pin_hash.startsWith('$2'), 'PIN guardado só como hash');

  assert.equal((await entregar(undefined)).body.codigo, 'PIN_OBRIGATORIO');
  for (let restam = 4; restam >= 1; restam--) {
    const r = await entregar('000000');
    assert.equal(r.status, 422);
    assert.match(r.body.error, new RegExp(`Restam ${restam}`));
  }
  const bloqueio = await entregar('000000');
  assert.equal(bloqueio.status, 423);
  assert.equal((await entregar('905172')).status, 423, 'nem o PIN certo passa durante o bloqueio');

  const leitura = await api('GET', `/funcionarios/qr/${ids.qrSergio}`, { token: tk.tecA });
  assert.equal(leitura.body.funcionario.pin_bloqueado, true);

  // Reset pela gestão (técnico não pode)
  assert.equal((await api('DELETE', `/funcionarios/${ids.sergio}/pin`, { token: tk.tecA })).status, 403);
  assert.equal((await api('DELETE', `/funcionarios/${ids.sergio}/pin`, { token: tk.gestorA })).status, 204);
  assert.equal((await cadastrar('390214')).status, 201);
  assert.equal((await entregar('390214')).status, 201);
});

test('foto da entrega: tipo conferido pelo conteúdo, hash e acesso por filial', async () => {
  const foto = jpeg();
  const e = await api('POST', '/entregas/qr', { token: tk.tecA, body: { token: ids.qrAna, pin: '4821', item_id: ids.luvaM, foto: `data:image/jpeg;base64,${foto}` } });
  assert.equal(e.status, 201, JSON.stringify(e.body));
  assert.equal(e.body.foto, true);
  ids.entregaFoto = e.body.id;

  const r = await fetch(`${amb.base}/entregas/${e.body.id}/foto`, { headers: { Authorization: `Bearer ${tk.consultaA}` } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.equal(r.headers.get('x-arquivo-sha256'), crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await api('GET', `/entregas/${e.body.id}/foto`, { token: tk.tecB })).status, 404);

  const texto = Buffer.from('não sou uma imagem').toString('base64');
  assert.equal((await api('POST', '/entregas/qr', { token: tk.tecA, body: { token: ids.qrAna, pin: '4821', item_id: ids.luvaM, foto: texto } })).status, 400);
  const grande = await api('POST', '/entregas/qr', { token: tk.tecA, body: { token: ids.qrAna, pin: '4821', item_id: ids.luvaM, foto: jpeg(2.2 * 1024 * 1024) } });
  assert.equal(grande.status, 413);
});

test('entrega manual exige gestão e justificativa', async () => {
  const body = { funcionario_id: ids.ana, item_id: ids.capacete, motivo: 'perda' };
  assert.equal((await api('POST', '/entregas', { token: tk.tecA, body: { ...body, observacao: 'crachá esquecido em casa hoje' } })).status, 403);
  assert.equal((await api('POST', '/entregas', { token: tk.gestorA, body })).status, 400);
  const ok = await api('POST', '/entregas', { token: tk.gestorA, body: { ...body, observacao: 'crachá esquecido em casa hoje' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const e = await amb.knex('entregas').where({ id: ok.body.id }).first();
  assert.equal(e.metodo_assinatura, 'manual');
  assert.equal(e.pin_validado, false);
  assert.equal((await api('POST', '/entregas', { token: tk.gestorA, body: { ...body, motivo: 'qualquer', observacao: 'x'.repeat(20) } })).status, 400);
});

test('estorno de entrega: estoque volta aos mesmos lotes, registro permanece', async () => {
  const saldoAntes = (await api('GET', `/estoque/saldos?filial_id=${ids.A}`, { token: tk.gestorA })).body.find((s) => s.item_id === ids.luvaM);

  assert.equal((await api('POST', `/entregas/${ids.entregaFoto}/estorno`, { token: tk.tecA, body: { motivo: 'lançado errado' } })).status, 403);
  assert.equal((await api('POST', `/entregas/${ids.entregaFoto}/estorno`, { token: tk.gestorA, body: {} })).status, 400);
  const est = await api('POST', `/entregas/${ids.entregaFoto}/estorno`, { token: tk.gestorA, body: { motivo: 'Funcionário devolveu na hora, tamanho errado' } });
  assert.equal(est.status, 201, JSON.stringify(est.body));
  assert.equal((await api('POST', `/entregas/${ids.entregaFoto}/estorno`, { token: tk.gestorA, body: { motivo: 'de novo por engano' } })).status, 409);

  const saldoDepois = (await api('GET', `/estoque/saldos?filial_id=${ids.A}`, { token: tk.gestorA })).body.find((s) => s.item_id === ids.luvaM);
  assert.equal(saldoDepois.saldo, saldoAntes.saldo + 1);
  assert.equal(saldoDepois.valor, saldoAntes.valor + 5);

  // Continua existindo, marcada como estornada
  assert.ok(await amb.knex('entregas').where({ id: ids.entregaFoto }).first());
  const padrao = (await api('GET', `/entregas?funcionario_id=${ids.ana}`, { token: tk.gestorA })).body;
  assert.ok(!padrao.some((e) => e.id === ids.entregaFoto));
  const todas = (await api('GET', `/entregas?funcionario_id=${ids.ana}&incluir_estornadas=true`, { token: tk.gestorA })).body;
  assert.equal(todas.find((e) => e.id === ids.entregaFoto).estornada, true);

  // Não existem rotas para editar ou apagar entrega/movimentação
  assert.equal((await api('PUT', `/entregas/${ids.entregaFoto}`, { token: tk.admin, body: {} })).status, 404);
  assert.equal((await api('DELETE', `/entregas/${ids.entregaFoto}`, { token: tk.admin })).status, 404);
});

test('verificação pública pelo código: sem login e sem dados pessoais', async () => {
  const e = await amb.knex('entregas').where({ id: ids.entregaPeps }).first('codigo_verificacao');
  const r = await api('GET', `/verificar/${e.codigo_verificacao.toLowerCase()}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.valida, true);
  assert.equal(r.body.funcionario, 'A. S.');
  assert.equal(r.body.epi, 'Luva nitrílica (M)');
  assert.equal(r.body.assinatura, 'Crachá QR + PIN pessoal');
  assert.equal(r.body.estornada, false);
  assert.equal(JSON.stringify(r.body).includes('52998224725'), false);

  const estornada = await amb.knex('entregas').where({ id: ids.entregaFoto }).first('codigo_verificacao');
  assert.equal((await api('GET', `/verificar/${estornada.codigo_verificacao}`)).body.estornada, true);
  assert.equal((await api('GET', '/verificar/ZZZZZZZZ')).status, 404);
  assert.equal((await api('GET', '/verificar/x')).status, 404);
});

test('duas entregas ao mesmo tempo não usam o mesmo saldo', async () => {
  await api('POST', '/estoque/entradas', { token: tk.tecA, body: { filial_id: ids.A, item_id: ids.luvaG, quantidade: 5, valor_unitario: 3 } });
  const pedido = () => api('POST', '/entregas/qr', { token: tk.tecA, body: { token: ids.qrAna, pin: '4821', item_id: ids.luvaG, quantidade: 3 } });
  const resultados = await Promise.all([pedido(), pedido()]);
  assert.deepEqual(resultados.map((r) => r.status).sort(), [201, 409]);
  const saldo = (await api('GET', `/estoque/saldos?filial_id=${ids.A}`, { token: tk.gestorA })).body.find((s) => s.item_id === ids.luvaG);
  assert.equal(saldo.saldo, 2);
});

test('lote vencido não é entregue e pode ser descartado', async () => {
  const lote = await api('POST', '/estoque/entradas', { token: tk.tecA, body: { filial_id: ids.A, item_id: ids.luvaG, quantidade: 4, valor_unitario: 3, data_validade: '2099-01-01' } });
  await amb.knex('lotes').where({ id: lote.body.lote.id }).update({ data_validade: '2025-01-01' }); // venceu

  const saldo = (await api('GET', `/estoque/saldos?filial_id=${ids.A}`, { token: tk.gestorA })).body.find((s) => s.item_id === ids.luvaG);
  assert.equal(saldo.saldo, 6);
  assert.equal(saldo.saldo_vencido, 4);
  assert.equal(saldo.saldo_disponivel, 2);
  assert.equal((await api('POST', '/entregas/qr', { token: tk.tecA, body: { token: ids.qrAna, pin: '4821', item_id: ids.luvaG, quantidade: 3 } })).status, 409);

  const disp = (await api('GET', `/estoque/disponivel?filial_id=${ids.A}`, { token: tk.tecA })).body.find((d) => d.item_id === ids.luvaG);
  assert.equal(disp.saldo, 2);
  assert.equal(disp.ca_vigente.numero, '37000');

  assert.equal((await api('POST', '/estoque/descartes', { token: tk.tecA, body: { lote_id: lote.body.lote.id, quantidade: 4 } })).status, 400, 'sem motivo');
  const desc = await api('POST', '/estoque/descartes', { token: tk.tecA, body: { lote_id: lote.body.lote.id, quantidade: 4, motivo: 'Lote vencido' } });
  assert.equal(desc.status, 201);
  assert.equal(desc.body.valor_total, -12);
  assert.equal((await api('POST', '/estoque/descartes', { token: tk.tecB, body: { lote_id: lote.body.lote.id, quantidade: 1, motivo: 'teste outra filial' } })).status, 403);
});

test('ajuste de inventário e estorno de movimentação', async () => {
  assert.equal((await api('POST', '/estoque/ajustes', { token: tk.tecA, body: { lote_id: ids.lote2026, quantidade: -1, motivo: 'contagem física' } })).status, 403);
  const falta = await api('POST', '/estoque/ajustes', { token: tk.gestorA, body: { lote_id: ids.lote2026, quantidade: -1, motivo: 'Contagem física: faltou 1' } });
  assert.equal(falta.status, 201);
  const sobra = await api('POST', '/estoque/ajustes', { token: tk.gestorA, body: { lote_id: ids.lote2026, quantidade: 2, motivo: 'Contagem física: sobraram 2' } });
  assert.equal(sobra.status, 201);
  assert.equal(sobra.body.valor_total, 10);

  // Estorno de ajuste: ok, uma vez só
  assert.equal((await api('POST', `/estoque/movimentacoes/${sobra.body.id}/estorno`, { token: tk.gestorA, body: { motivo: 'Ajuste lançado em dobro' } })).status, 201);
  assert.equal((await api('POST', `/estoque/movimentacoes/${sobra.body.id}/estorno`, { token: tk.gestorA, body: { motivo: 'Ajuste lançado em dobro' } })).status, 409);

  // Estorno de entrada já consumida: recusado
  const entrada2020 = await amb.knex('movimentacoes').where({ lote_id: ids.lote2020, tipo: 'entrada' }).first('id');
  const r = await api('POST', `/estoque/movimentacoes/${entrada2020.id}/estorno`, { token: tk.gestorA, body: { motivo: 'Nota lançada errada' } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /já foi usada/);

  const movEntrega = await amb.knex('movimentacoes').where({ tipo: 'entrega' }).first('id');
  assert.equal((await api('POST', `/estoque/movimentacoes/${movEntrega.id}/estorno`, { token: tk.gestorA, body: { motivo: 'tentativa errada' } })).status, 400);
});

test('estoque mínimo e saldos por filial', async () => {
  assert.equal((await api('PUT', '/estoque/minimos', { token: tk.tecA, body: { filial_id: ids.A, item_id: ids.luvaM, minimo: 20 } })).status, 403);
  assert.equal((await api('PUT', '/estoque/minimos', { token: tk.gestorA, body: { filial_id: ids.A, item_id: ids.luvaM, minimo: 20 } })).status, 200);
  await api('PUT', '/estoque/minimos', { token: tk.gestorA, body: { filial_id: ids.A, item_id: ids.luvaG, minimo: 1 } });

  const abaixo = (await api('GET', '/estoque/saldos?abaixo_minimo=true', { token: tk.consultaA })).body;
  assert.deepEqual(abaixo.map((s) => s.item_id), [ids.luvaM]);
  assert.equal(abaixo[0].minimo, 20);

  assert.deepEqual((await api('GET', '/estoque/saldos', { token: tk.tecB })).body, []);
  assert.equal((await api('GET', `/estoque/disponivel?filial_id=${ids.A}`, { token: tk.tecB })).status, 403);
});

test('transferência entre filiais: custo acompanha, destino confirma', async () => {
  const antesA = (await api('GET', `/estoque/saldos?filial_id=${ids.A}`, { token: tk.admin })).body.find((s) => s.item_id === ids.luvaM);

  assert.equal((await api('POST', '/transferencias', { token: tk.tecA, body: { origem_filial_id: ids.A, destino_filial_id: ids.A, item_id: ids.luvaM, quantidade: 1 } })).status, 400);
  assert.equal((await api('POST', '/transferencias', { token: tk.tecB, body: { origem_filial_id: ids.A, destino_filial_id: ids.B, item_id: ids.luvaM, quantidade: 1 } })).status, 403);
  const semSaldo = await api('POST', '/transferencias', { token: tk.tecA, body: { origem_filial_id: ids.A, destino_filial_id: ids.B, item_id: ids.luvaM, quantidade: 999 } });
  assert.equal(semSaldo.status, 409);
  assert.equal(await amb.knex('transferencias').count({ n: '*' }).first().then((r) => Number(r.n)), 0, 'nada fica gravado');

  const t = await api('POST', '/transferencias', { token: tk.tecA, body: { origem_filial_id: ids.A, destino_filial_id: ids.B, item_id: ids.luvaM, quantidade: 3 } });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.equal(t.body.status, 'pendente');

  const emTransito = (await api('GET', `/estoque/saldos?filial_id=${ids.A}`, { token: tk.admin })).body.find((s) => s.item_id === ids.luvaM);
  assert.equal(emTransito.saldo, antesA.saldo - 3);
  assert.deepEqual((await api('GET', '/estoque/saldos', { token: tk.tecB })).body, [], 'destino só recebe ao confirmar');

  assert.equal((await api('POST', `/transferencias/${t.body.id}/receber`, { token: tk.tecA })).status, 403, 'origem não confirma pelo destino');
  const rec = await api('POST', `/transferencias/${t.body.id}/receber`, { token: tk.tecB });
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  assert.equal(rec.body.status, 'recebida');
  assert.ok(rec.body.lotes.every((l) => l.valor_unitario === 5 && l.origem_lote_id === ids.lote2026));
  assert.equal((await api('POST', `/transferencias/${t.body.id}/receber`, { token: tk.tecB })).status, 409);

  const saldoB = (await api('GET', '/estoque/saldos', { token: tk.tecB })).body[0];
  assert.equal(saldoB.saldo, 3);
  assert.equal(saldoB.valor, 15);
  assert.equal((await api('POST', `/transferencias/${t.body.id}/cancelar`, { token: tk.tecA, body: { motivo: 'tarde demais' } })).status, 409);

  // Cancelamento devolve à origem
  await api('POST', '/estoque/entradas', { token: tk.tecA, body: { filial_id: ids.A, item_id: ids.luvaM, quantidade: 2, valor_unitario: 6 } });
  const t2 =await api('POST', '/transferencias', { token: tk.tecA, body: { origem_filial_id: ids.A, destino_filial_id: ids.B, item_id: ids.luvaM, quantidade: 1 } });
  assert.equal(t2.status, 201, JSON.stringify(t2.body));
  const canc = await api('POST', `/transferencias/${t2.body.id}/cancelar`, { token: tk.tecA, body: { motivo: 'Enviado por engano' } });
  assert.equal(canc.status, 200, JSON.stringify(canc.body));
  assert.equal(canc.body.status, 'cancelada');
  const depoisA = (await api('GET', `/estoque/saldos?filial_id=${ids.A}`, { token: tk.admin })).body.find((s) => s.item_id === ids.luvaM);
  assert.equal(depoisA.saldo, antesA.saldo - 3 + 2);
  assert.equal(depoisA.valor, 12, 'os 2 a R$6 voltaram para o mesmo lote');

  const listaB = (await api('GET', '/transferencias', { token: tk.tecB })).body;
  assert.equal(listaB.length, 2);
});

test('termo de adesão: upload, data e efeito nas próximas entregas', async () => {
  assert.equal((await api('POST', `/funcionarios/${ids.ana}/termo`, { token: tk.tecA, body: { data: '2026-11-01', arquivo: pdf() } })).status, 403);
  assert.equal((await api('POST', `/funcionarios/${ids.ana}/termo`, { token: tk.gestorA, body: { data: somarDias(hoje(), 2), arquivo: pdf() } })).status, 400);
  const textoQualquer = Buffer.from('isto não é PDF nem imagem').toString('base64');
  assert.equal((await api('POST', `/funcionarios/${ids.ana}/termo`, { token: tk.gestorA, body: { data: '2026-11-01', arquivo: textoQualquer } })).status, 400);

  const t = await api('POST', `/funcionarios/${ids.ana}/termo`, { token: tk.gestorA, body: { data: '2026-11-01', arquivo: pdf() } });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.match(t.body.sha256, /^[0-9a-f]{64}$/);

  const arq = await fetch(`${amb.base}/arquivos/${t.body.arquivo_id}`, { headers: { Authorization: `Bearer ${tk.consultaA}` } });
  assert.equal(arq.status, 200);
  assert.equal(arq.headers.get('content-type'), 'application/pdf');
  assert.equal((await api('GET', `/arquivos/${t.body.arquivo_id}`, { token: tk.tecB })).status, 404);

  const e = await api('POST', '/entregas/qr', { token: tk.tecA, body: { token: ids.qrAna, pin: '4821', item_id: ids.capacete } });
  assert.equal(e.body.termo_adesao_vigente, true);
  const leitura = await api('GET', `/funcionarios/qr/${ids.qrAna}`, { token: tk.tecA });
  assert.equal(leitura.body.funcionario.termo_adesao_data, '2026-11-01');
});

test('ficha de EPI em PDF', async () => {
  const r = await fetch(`${amb.base}/funcionarios/${ids.ana}/ficha-epi`, { headers: { Authorization: `Bearer ${tk.consultaA}` } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(bytes.length > 2000);
  assert.equal((await api('GET', `/funcionarios/${ids.ana}/ficha-epi`, { token: tk.tecB })).status, 404);

  const log = (await api('GET', `/auditoria?acao=emitir_ficha_epi&registro_id=${ids.ana}`, { token: tk.admin })).body;
  assert.equal(log.length, 1);
  assert.equal(log[0].usuario, 'consultaA');
});

test('auditoria das operações de estoque e entrega', async () => {
  const acoes = (await api('GET', '/auditoria?limite=1000', { token: tk.admin })).body.map((l) => l.acao);
  for (const acao of ['entrada', 'entregar_qr', 'entregar_manual', 'estornar', 'descarte', 'ajuste', 'estorno', 'enviar', 'receber', 'cancelar', 'cadastrar_pin', 'resetar_pin', 'registrar_termo', 'definir_minimo']) {
    assert.ok(acoes.includes(acao), `falta auditoria de ${acao}`);
  }
});
