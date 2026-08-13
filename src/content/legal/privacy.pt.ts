import type { LegalDocument } from './types';

/**
 * Portuguese is the AUTHORITATIVE text (spec §3.3): the owner's own words,
 * corrected only for the product name ("PulChatX" -> "PulchatX", task brief).
 * privacy.en.ts and privacy.es.ts are translations of these same sections, in
 * this same order, under these same ids -- not independent drafts. See
 * `.superpowers/sdd/2026-08-13-public-legal-pages/legal-source-pt.md`,
 * DOCUMENT 1, for the source this was transcribed from.
 *
 * The "Última atualização: agosto de 2026" line in the source names no day and
 * is prose; `updated` below is the ISO date the owner and this task agreed on,
 * kept as data so the renderer formats it per locale instead of three separate
 * strings that could disagree with each other.
 */
export const privacy: LegalDocument = {
  title: 'Política de Privacidade – PulchatX',
  updated: '2026-08-01',
  intro: [
    {
      kind: 'paragraph',
      text: 'O PulchatX respeita a privacidade e a proteção dos dados pessoais dos usuários e realiza o tratamento dessas informações em conformidade com a Lei nº 13.709/2018 – Lei Geral de Proteção de Dados Pessoais (LGPD) e demais normas aplicáveis.',
    },
    {
      kind: 'paragraph',
      text: 'Esta Política de Privacidade explica como os dados podem ser coletados, utilizados, armazenados, protegidos e excluídos quando uma pessoa interage com emissoras de rádio, televisão, portais, produtoras ou outras empresas de comunicação que utilizam o PulchatX.',
    },
  ],
  sections: [
    {
      id: 'about',
      heading: '1. Sobre o PulchatX',
      blocks: [
        {
          kind: 'paragraph',
          text: 'O PulchatX é uma plataforma tecnológica destinada ao relacionamento entre empresas de comunicação e seu público.',
        },
        { kind: 'paragraph', text: 'Por meio da plataforma, uma pessoa pode, por exemplo:' },
        {
          kind: 'list',
          items: [
            'enviar mensagens para uma emissora',
            'solicitar músicas',
            'participar de promoções',
            'responder perguntas, enquetes ou ações promocionais',
            'enviar informações necessárias para participação em campanhas',
            'interagir com atendimentos automatizados ou realizados por operadores',
            'receber comunicações relacionadas à interação iniciada pelo próprio usuário',
          ],
        },
        {
          kind: 'paragraph',
          text: 'As interações podem ocorrer por WhatsApp, páginas web, widgets ou outros canais disponibilizados pelas empresas que utilizam o PulchatX.',
        },
      ],
    },
    {
      id: 'data',
      heading: '2. Dados que podem ser tratados',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Dependendo da interação realizada, poderão ser tratados dados como:',
        },
        {
          kind: 'list',
          items: [
            'nome',
            'número de telefone',
            'identificadores relacionados à conta utilizada para comunicação',
            'mensagens enviadas pelo usuário',
            'pedidos de músicas',
            'informações fornecidas para participação em promoções',
            'respostas a perguntas, enquetes ou formulários',
            'data e horário das interações',
            'registros técnicos necessários para funcionamento e segurança da plataforma',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Determinadas promoções poderão solicitar informações adicionais quando necessárias para identificação do participante, cumprimento do regulamento ou entrega de eventual prêmio.',
        },
        {
          kind: 'paragraph',
          text: 'O PulchatX procura limitar a coleta às informações necessárias para cada finalidade.',
        },
      ],
    },
    {
      id: 'purpose',
      heading: '3. Finalidade do tratamento',
      blocks: [
        { kind: 'paragraph', text: 'Os dados poderão ser utilizados para:' },
        {
          kind: 'list',
          items: [
            'permitir a comunicação entre o usuário e a emissora',
            'registrar e processar pedidos de músicas',
            'possibilitar a inscrição e participação em promoções',
            'identificar participantes e vencedores quando aplicável',
            'viabilizar a entrega de prêmios',
            'manter histórico operacional das interações',
            'prevenir fraude, abuso ou utilização indevida dos serviços',
            'garantir segurança e estabilidade da plataforma',
            'atender obrigações legais ou regulatórias',
            'exercer direitos em processos administrativos, judiciais ou arbitrais',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Os dados não devem ser utilizados para finalidades incompatíveis com aquelas informadas ao usuário.',
        },
      ],
    },
    {
      id: 'meta',
      heading: '4. WhatsApp e plataformas da Meta',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Quando o usuário entra em contato através do WhatsApp ou de outro serviço da Meta, determinadas informações necessárias à comunicação podem ser transmitidas por essas plataformas ao PulchatX e à empresa de comunicação responsável pelo atendimento.',
        },
        {
          kind: 'paragraph',
          text: 'O tratamento realizado pela Meta em seus próprios serviços está sujeito às políticas e aos termos da própria Meta.',
        },
        {
          kind: 'paragraph',
          text: 'O PulchatX utiliza somente as informações disponibilizadas através das integrações autorizadas e necessárias para prestar os serviços relacionados à interação do usuário.',
        },
      ],
    },
    {
      id: 'sharing',
      heading: '5. Compartilhamento de dados',
      blocks: [
        {
          kind: 'paragraph',
          text: 'As informações poderão ser disponibilizadas à emissora ou empresa de comunicação com a qual o usuário decidiu interagir.',
        },
        {
          kind: 'paragraph',
          text: 'Também poderão ser utilizados prestadores de serviços tecnológicos necessários para hospedagem, banco de dados, segurança, comunicação, processamento e operação da plataforma.',
        },
        { kind: 'paragraph', text: 'O PulchatX não comercializa dados pessoais dos usuários.' },
        {
          kind: 'paragraph',
          text: 'O compartilhamento será limitado ao necessário para prestação do serviço, cumprimento de obrigações legais, segurança da plataforma ou exercício regular de direitos.',
        },
      ],
    },
    {
      id: 'security',
      heading: '6. Segurança e proteção das informações',
      blocks: [
        {
          kind: 'paragraph',
          text: 'O PulchatX adota medidas técnicas e administrativas destinadas a proteger os dados pessoais contra acesso não autorizado, perda, alteração, divulgação ou tratamento inadequado.',
        },
        { kind: 'paragraph', text: 'Entre as medidas utilizadas podem estar:' },
        {
          kind: 'list',
          items: [
            'criptografia das informações durante transmissão e, quando aplicável, durante armazenamento',
            'controle de acesso aos sistemas',
            'autenticação e autorização de usuários',
            'segregação de dados entre empresas atendidas pela plataforma',
            'mascaramento ou ocultação de determinadas informações em interfaces operacionais',
            'registro e monitoramento de acessos',
            'procedimentos de segurança destinados à prevenção de acesso indevido',
          ],
        },
        {
          kind: 'paragraph',
          text: 'O acesso às informações é limitado aos sistemas, empresas e profissionais que necessitem desses dados para executar as finalidades previstas nesta Política.',
        },
      ],
    },
    {
      id: 'retention',
      heading: '7. Retenção dos dados',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Os dados pessoais serão mantidos somente pelo período necessário ao cumprimento das finalidades para as quais foram coletados.',
        },
        {
          kind: 'paragraph',
          text: 'Como política de retenção do PulchatX, dados associados a usuários que permanecerem sem qualquer interação por período superior a 6 (seis) meses poderão ser automaticamente eliminados ou anonimizados.',
        },
        {
          kind: 'paragraph',
          text: 'A eliminação automática poderá não ocorrer quando a conservação das informações for necessária para:',
        },
        {
          kind: 'list',
          items: [
            'cumprimento de obrigação legal ou regulatória',
            'exercício regular de direitos',
            'prevenção ou investigação de fraude',
            'cumprimento de determinação de autoridade competente',
            'outras hipóteses de conservação permitidas pela legislação aplicável',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Dados anonimizados, quando não permitirem mais a identificação do usuário, poderão ser utilizados para estatísticas, métricas e melhoria dos serviços.',
        },
      ],
    },
    {
      id: 'rights',
      heading: '8. Direitos do titular',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Nos termos da LGPD, o titular poderá exercer os direitos previstos pela legislação aplicável, incluindo, quando cabível:',
        },
        {
          kind: 'list',
          items: [
            'confirmação da existência de tratamento',
            'acesso aos seus dados pessoais',
            'correção de informações incompletas, inexatas ou desatualizadas',
            'solicitação de anonimização, bloqueio ou eliminação',
            'informação sobre compartilhamentos realizados',
            'revogação de consentimento, quando o tratamento estiver baseado em consentimento',
            'oposição ao tratamento nas hipóteses previstas em lei',
            'solicitação de exclusão dos seus dados pessoais',
          ],
        },
      ],
    },
    {
      id: 'deletion',
      heading: '9. Solicitação de exclusão dos dados',
      blocks: [
        {
          kind: 'link',
          text: 'O usuário pode solicitar formalmente a exclusão dos seus dados através da página',
          link: { label: 'pulchatx.com/delete-data', href: '/delete-data' },
        },
        {
          kind: 'paragraph',
          text: 'A solicitação poderá exigir a confirmação de determinadas informações para que possamos verificar que o pedido está sendo realizado pelo próprio titular ou por pessoa legitimamente autorizada.',
        },
        {
          kind: 'paragraph',
          text: 'Após a validação da solicitação, os dados abrangidos pelo pedido serão eliminados ou anonimizados, salvo aqueles que devam ser mantidos em razão de obrigação legal, regulatória ou outra hipótese autorizada pela LGPD.',
        },
      ],
    },
    {
      id: 'promotions',
      heading: '10. Dados relacionados a promoções',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Quando o usuário decidir participar de uma promoção, poderão ser solicitadas informações necessárias para validar sua participação.',
        },
        {
          kind: 'paragraph',
          text: 'Cada promoção poderá possuir regulamento próprio definido pela emissora ou empresa responsável pela ação.',
        },
        {
          kind: 'paragraph',
          text: 'A utilização do PulchatX como ferramenta tecnológica não significa, por si só, que o PulchatX seja o organizador ou responsável pelos prêmios oferecidos pela emissora.',
        },
      ],
    },
    {
      id: 'changes',
      heading: '11. Alterações desta Política',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Esta Política de Privacidade poderá ser atualizada para refletir mudanças na legislação, nos serviços ou nos procedimentos de segurança e proteção de dados.',
        },
        {
          kind: 'paragraph',
          text: 'A versão vigente será sempre disponibilizada nesta página.',
        },
      ],
    },
    {
      id: 'contact',
      heading: '12. Contato',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Dúvidas relacionadas à privacidade, proteção de dados ou exercício dos direitos previstos na LGPD poderão ser encaminhadas através dos canais de atendimento disponibilizados no site do PulchatX.',
        },
        {
          kind: 'link',
          text: 'Para solicitações específicas de exclusão de dados, utilize',
          link: { label: 'pulchatx.com/delete-data', href: '/delete-data' },
        },
      ],
    },
  ],
};
