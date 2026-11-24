// Etapa 8: integridade.
// 1) Auditoria encadeada por hash: cada linha selada guarda o hash da anterior (sequência própria).
// 2) Tabelas de prova só aceitam inclusão: o banco recusa UPDATE, DELETE e TRUNCATE.
// 3) Fechamento mensal por filial: situação congelada no fim do mês + impressão digital dos registros do mês.

// Tabelas de prova: nunca são alteradas pela aplicação (correção = anulação/estorno, que também é inclusão)
const SOMENTE_INCLUSAO = [
  'turma_presencas', 'presenca_anulacoes', 'certificado_anulacoes', 'asos', 'aso_anulacoes',
  'os_ciencias', 'os_ciencia_anulacoes', 'ordens_servico', 'entrega_estornos',
  'equipamento_inspecoes', 'inspecao_anulacoes', 'equipamento_manutencoes', 'manutencao_anulacoes',
  'ppci_anulacoes', 'alvara_anulacoes', 'relatorios_emitidos', 'fechamentos'
];

exports.up = async function(knex) {
  await knex.schema.alterTable('auditoria', (table) => {
    table.bigInteger('sequencia').unique();
    table.string('hash_anterior', 64);
    table.string('hash', 64);
    table.timestamp('selado_em');
    table.index(['hash']);
  });

  await knex.schema.createTable('fechamentos', (table) => {
    table.increments('id').primary();
    table.integer('filial_id').unsigned().notNullable().references('id').inTable('filiais').onDelete('RESTRICT');
    table.string('competencia', 7).notNullable();             // AAAA-MM
    table.date('data_base').notNullable();                    // último dia do mês
    table.jsonb('resumo').notNullable();
    table.jsonb('conteudo').notNullable();
    table.string('hash_conteudo', 64).notNullable();
    table.string('hash_anterior', 64);                        // fechamento anterior da mesma filial
    table.string('hash', 64).notNullable();
    table.bigInteger('auditoria_sequencia');                  // âncora na cadeia da auditoria
    table.string('auditoria_hash', 64);
    table.string('codigo_verificacao', 12).notNullable().unique();
    table.integer('fechado_por').unsigned().notNullable().references('id').inTable('usuarios').onDelete('RESTRICT');
    table.timestamp('fechado_em').notNullable();
    table.unique(['filial_id', 'competencia']);
  });

  await knex.raw(`
    create function sesmt_somente_inclusao() returns trigger language plpgsql as $$
    begin
      raise exception 'Tabela % só aceita inclusão: corrija por anulação ou estorno', TG_TABLE_NAME using errcode = 'P0001';
    end $$`);
  for (const t of SOMENTE_INCLUSAO) {
    await knex.raw(`create trigger ${t}_somente_inclusao before update or delete on ${t} for each row execute function sesmt_somente_inclusao()`);
    await knex.raw(`create trigger ${t}_sem_truncate before truncate on ${t} for each statement execute function sesmt_somente_inclusao()`);
  }

  // Auditoria: só a selagem pode preencher (uma vez) as colunas da cadeia; o resto nunca muda
  await knex.raw(`
    create function sesmt_auditoria_selagem() returns trigger language plpgsql as $$
    begin
      if TG_OP <> 'UPDATE' or OLD.hash is not null
         or (NEW.id, NEW.usuario_id, NEW.acao, NEW.tabela, NEW.registro_id, NEW.filial_id, NEW.antes, NEW.depois, NEW.ip, NEW.created_at)
            is distinct from
            (OLD.id, OLD.usuario_id, OLD.acao, OLD.tabela, OLD.registro_id, OLD.filial_id, OLD.antes, OLD.depois, OLD.ip, OLD.created_at) then
        raise exception 'Auditoria não pode ser alterada nem apagada' using errcode = 'P0001';
      end if;
      return NEW;
    end $$`);
  await knex.raw('create trigger auditoria_selagem before update or delete on auditoria for each row execute function sesmt_auditoria_selagem()');
  await knex.raw('create trigger auditoria_sem_truncate before truncate on auditoria for each statement execute function sesmt_somente_inclusao()');
};

exports.down = async function(knex) {
  await knex.raw('drop trigger if exists auditoria_sem_truncate on auditoria');
  await knex.raw('drop trigger if exists auditoria_selagem on auditoria');
  await knex.raw('drop function if exists sesmt_auditoria_selagem()');
  for (const t of SOMENTE_INCLUSAO) {
    await knex.raw(`drop trigger if exists ${t}_somente_inclusao on ${t}`);
    await knex.raw(`drop trigger if exists ${t}_sem_truncate on ${t}`);
  }
  await knex.schema.dropTable('fechamentos');
  await knex.raw('drop function if exists sesmt_somente_inclusao()');
  await knex.schema.alterTable('auditoria', (table) => {
    table.dropIndex(['hash']);
    table.dropColumns('sequencia', 'hash_anterior', 'hash', 'selado_em');
  });
};
