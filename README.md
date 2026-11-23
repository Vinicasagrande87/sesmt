# SESMT — Gestão de Segurança do Trabalho

Sistema web para o SESMT (Serviço Especializado em Segurança e Medicina do Trabalho) controlar a entrega de EPIs, o estoque e os custos, além de guardar a **comprovação legal** de tudo o que foi entregue e realizado, pensando em fiscalizações e em futuros processos trabalhistas.

## Sobre mim e o porquê deste projeto

Trabalho há **14 anos como Técnico em Segurança do Trabalho** e estou migrando para a área de tecnologia, cursando **Análise e Desenvolvimento de Sistemas (ADS)**.

Este projeto junta as duas coisas. Ele nasceu de problemas que vivi no dia a dia do SESMT:

- **Fichas de EPI em papel** que se perdem, ficam sem assinatura ou não comprovam a data da troca. Quando chega um processo, anos depois, falta a prova.
- **Controles espalhados em planilhas:** vencimento de treinamentos (NR-10, NR-35...), de ASOs, de extintores e de alvarás de PPCI, cada um num arquivo.
- **Custos sem histórico:** o preço pago por uma luva em 2020 não é o de hoje, e somar e dividir valores esconde o gasto real.

A ideia é usar o conhecimento técnico da área para construir uma ferramenta que um SESMT realmente usaria, e documentar aqui as decisões de desenvolvimento.

## O que já funciona

- **Entrega de EPI por QR code.** Cada funcionário tem um QR no crachá, que contém só uma chave aleatória (nunca CPF ou id). O técnico lê o QR pelo celular, vê os dados do funcionário e os EPIs com troca vencida, escolhe o EPI e registra a entrega.
- **Baixa automática no estoque,** feita numa transação com trava de linha: duas entregas simultâneas não conseguem usar o mesmo saldo.
- **Cálculo da próxima troca** a partir da periodicidade do EPI, com datas no fuso de São Paulo.
- **Bloqueios de regra de negócio:** funcionário inativo, saldo insuficiente ou EPI inexistente geram respostas 4xx claras.
- **Autenticação com JWT** e perfis `admin` e `tecnico`. Todas as rotas exigem login, e as exclusões são exclusivas do admin.
- **Leitor web** ([public/leitor.html](public/leitor.html)) com login e acesso à câmera traseira do celular.

## Em construção (roadmap)

O modelo completo está sendo desenhado junto com a rotina real de um SESMT com várias filiais:

1. **Estrutura multi-filial:** matriz → filiais (cada uma com CNPJ próprio) → prédios, com permissões por filial.
2. **EPI com valor jurídico:**
   - assinatura por QR + PIN + foto;
   - CA vigente copiado na entrega (a entrega é bloqueada se o CA estiver vencido);
   - ficha de EPI em PDF.
3. **Estoque com custo histórico:** lotes com o preço pago em cada compra e custo das saídas pelo método PEPS. Os relatórios somam valores gravados no momento da movimentação, nunca o preço atual.
4. **Treinamentos:** exigências por função e lista de presença assinada com o crachá.
5. **ASOs (PCMSO):** controle de vencimentos, com acesso restrito aos dados de saúde (LGPD).
6. **PPCI por prédio:**
   - projeto aprovado e alvará;
   - comparação entre o que o projeto prevê e o que está instalado;
   - manutenção de extintores e inspeção mensal por QR no equipamento.
7. **Relatórios em todas as áreas:**
   - exportação em PDF e Excel, com código de verificação;
   - consulta da situação "como estava em uma data";
   - painel de conformidade.
8. **Registros imutáveis:** correção por estorno, encadeamento por hash e fechamento mensal, para servir de prova.

## Tecnologias

- **Node.js** + **Express 5**
- **Knex** com migrations: MySQL em desenvolvimento e PostgreSQL em produção
- **JWT** (`jsonwebtoken`) e **bcrypt** (`bcryptjs`) para autenticação
- **qrcode** para gerar os QR codes e **html5-qrcode** para a leitura pela câmera

## Como rodar

```bash
npm install
cp .env.example .env          # preencha os dados do banco e gere o JWT_SECRET
npx knex migrate:latest
npm run criar-admin -- "Seu Nome" voce@exemplo.com "uma-senha-forte"
npm run dev
```

O leitor fica em `http://localhost:3000/leitor.html`. No celular, a câmera só abre por **HTTPS**: use o ambiente de produção ou um túnel (por exemplo, `npx localtunnel --port 3000`).

## Principais rotas

| Método | Rota | Descrição |
|---|---|---|
| POST | `/auth/login` | Login, devolve o token JWT |
| GET | `/auth/me` | Usuário logado |
| GET/POST | `/usuarios` | Usuários (somente admin) |
| GET/POST | `/funcionarios` | Lista e cadastra funcionários |
| GET | `/funcionarios/:id/qrcode` | PNG do QR do crachá |
| GET | `/funcionarios/qr/:token` | Dados do funcionário, entregas e EPIs vencidos |
| GET/POST | `/epis` | Catálogo de EPIs |
| POST | `/entregas/qr` | Entrega por QR code, com baixa de estoque |
| GET/POST | `/estoque` | Movimentações de estoque |
| GET/POST | `/treinamentos`, `/certificados`, `/acidentes` | Demais cadastros |

Todas as rotas, exceto `/ping` e `/auth/login`, exigem o cabeçalho `Authorization: Bearer <token>`.

## Autor

**[@Vinicasagrande87](https://github.com/Vinicasagrande87)**: Técnico em Segurança do Trabalho há 14 anos, estudante de Análise e Desenvolvimento de Sistemas.
