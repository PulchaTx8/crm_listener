import type { LegalDocument } from './types';

/**
 * Portuguese is the AUTHORITATIVE text (spec §3.3): the owner's own words,
 * corrected only for the product name ("PulChatX" -> "PulchatX", task brief).
 * terms.en.ts and terms.es.ts are translations of these same sections, in
 * this same order, under these same ids -- not independent drafts. See
 * `.superpowers/sdd/2026-08-13-public-legal-pages/legal-source-pt.md`,
 * DOCUMENT 3, for the source this was transcribed from.
 *
 * The "Última atualização: agosto de 2026" line in the source names no day and
 * is prose; `updated` below is the ISO date the owner and this task agreed on,
 * kept as data so the renderer formats it per locale instead of three separate
 * strings that could disagree with each other.
 */
export const terms: LegalDocument = {
  title: 'Termos de Serviço – PulchatX',
  updated: '2026-08-01',
  intro: [
    {
      kind: 'paragraph',
      text: 'Estes Termos de Serviço estabelecem as condições aplicáveis à utilização do PulchatX por usuários que interagem com emissoras de rádio, televisão, portais, produtoras e outras empresas de comunicação através da plataforma.',
    },
    {
      kind: 'paragraph',
      text: 'Ao utilizar os recursos disponibilizados através do PulchatX, o usuário declara estar ciente destes Termos e da Política de Privacidade aplicável ao serviço.',
    },
  ],
  sections: [
    {
      id: 'service',
      heading: '1. Sobre o serviço',
      blocks: [
        {
          kind: 'paragraph',
          text: 'O PulchatX é uma plataforma tecnológica destinada a facilitar a comunicação e interação entre empresas de comunicação e seu público.',
        },
        {
          kind: 'paragraph',
          text: 'A plataforma poderá permitir, entre outras funcionalidades:',
        },
        {
          kind: 'list',
          items: [
            'envio de mensagens',
            'pedidos de músicas',
            'participação em promoções',
            'participação em enquetes ou ações interativas',
            'envio de respostas e informações',
            'comunicação com atendentes ou sistemas automatizados',
            'recebimento de mensagens relacionadas à interação realizada',
          ],
        },
        {
          kind: 'paragraph',
          text: 'As funcionalidades disponíveis poderão variar de acordo com cada emissora ou empresa que utiliza a plataforma.',
        },
      ],
    },
    {
      id: 'use',
      heading: '2. Utilização do serviço',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Ao utilizar o PulchatX, o usuário concorda em fornecer informações verdadeiras quando estas forem necessárias para determinada interação.',
        },
        {
          kind: 'paragraph',
          text: 'O usuário não deverá utilizar a plataforma para:',
        },
        {
          kind: 'list',
          items: [
            'praticar atividades ilícitas',
            'enviar conteúdo fraudulento ou deliberadamente falso',
            'tentar obter acesso não autorizado aos sistemas',
            'interferir no funcionamento da plataforma',
            'enviar códigos maliciosos',
            'praticar fraude em promoções',
            'utilizar identidades de terceiros sem autorização',
            'violar direitos de outras pessoas',
          ],
        },
        {
          kind: 'paragraph',
          text: 'O PulchatX poderá adotar medidas destinadas à proteção da plataforma e dos demais usuários quando forem identificadas atividades abusivas, fraudulentas ou incompatíveis com estes Termos.',
        },
      ],
    },
    {
      id: 'song-requests',
      heading: '3. Pedidos de músicas',
      blocks: [
        {
          kind: 'paragraph',
          text: 'A funcionalidade de pedido de músicas permite ao usuário indicar músicas que gostaria de ouvir na programação de determinada emissora.',
        },
        {
          kind: 'paragraph',
          text: 'O envio do pedido não representa garantia de execução da música.',
        },
        {
          kind: 'paragraph',
          text: 'A seleção, disponibilidade, horário e decisão de execução permanecem sob responsabilidade editorial e operacional da respectiva emissora.',
        },
      ],
    },
    {
      id: 'promotions',
      heading: '4. Promoções',
      blocks: [
        {
          kind: 'paragraph',
          text: 'O PulchatX poderá ser utilizado como ferramenta tecnológica para inscrição ou participação em promoções realizadas por emissoras ou outras empresas.',
        },
        {
          kind: 'paragraph',
          text: 'Cada promoção poderá possuir regulamento, requisitos de participação, período de validade, critérios de seleção e regras próprios.',
        },
        {
          kind: 'paragraph',
          text: 'A participação através do PulchatX não substitui a leitura e aceitação do regulamento específico da promoção quando houver.',
        },
        {
          kind: 'paragraph',
          text: 'Salvo quando expressamente informado de forma diferente, a emissora ou empresa promotora é responsável pela organização da promoção, definição das regras, seleção dos participantes ou vencedores e entrega dos respectivos prêmios.',
        },
      ],
    },
    {
      id: 'data-protection',
      heading: '5. Proteção de dados pessoais',
      blocks: [
        {
          kind: 'paragraph',
          text: 'O tratamento de dados pessoais realizado através do PulchatX deverá observar a Lei nº 13.709/2018 – Lei Geral de Proteção de Dados Pessoais (LGPD) e demais normas aplicáveis.',
        },
        {
          kind: 'paragraph',
          text: 'São adotadas medidas técnicas e administrativas destinadas a proteger as informações contra acesso não autorizado, divulgação, alteração, destruição ou tratamento inadequado.',
        },
        {
          kind: 'paragraph',
          text: 'Conforme a arquitetura e finalidade dos sistemas envolvidos, essas medidas poderão incluir:',
        },
        {
          kind: 'list',
          items: [
            'criptografia',
            'controles de acesso',
            'autenticação',
            'segregação de informações',
            'mascaramento ou ocultação de dados apresentados a operadores',
            'monitoramento e registro de atividades',
          ],
        },
        {
          kind: 'link',
          text: 'Mais informações estão disponíveis na Política de Privacidade do PulchatX, em',
          link: { label: 'pulchatx.com/privacy', href: '/privacy' },
        },
      ],
    },
    {
      id: 'retention',
      heading: '6. Retenção e exclusão',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Os dados pessoais serão mantidos somente enquanto forem necessários para as finalidades relacionadas à interação do usuário ou enquanto existir outra justificativa legal para sua conservação.',
        },
        {
          kind: 'paragraph',
          text: 'Como política geral do PulchatX, dados relacionados a usuários que permaneçam mais de 6 (seis) meses sem qualquer interação poderão ser excluídos ou anonimizados automaticamente.',
        },
        {
          kind: 'paragraph',
          text: 'O usuário também poderá solicitar formalmente a exclusão de seus dados a qualquer momento através da página de Solicitação de Exclusão de Dados disponível no site PulchatX.',
        },
        {
          kind: 'paragraph',
          text: 'Algumas informações poderão ser preservadas quando sua conservação for necessária para cumprimento de obrigação legal ou regulatória, segurança, prevenção de fraude, exercício regular de direitos ou demais hipóteses permitidas pela legislação.',
        },
      ],
    },
    {
      id: 'third-parties',
      heading: '7. Integração com plataformas de terceiros',
      blocks: [
        {
          kind: 'paragraph',
          text: 'O PulchatX poderá operar integrado a serviços de terceiros, incluindo plataformas de comunicação como o WhatsApp e outros produtos disponibilizados pela Meta.',
        },
        {
          kind: 'paragraph',
          text: 'A utilização desses serviços também está sujeita aos respectivos termos, políticas e regras estabelecidos por seus fornecedores.',
        },
        {
          kind: 'paragraph',
          text: 'O PulchatX não controla os procedimentos internos de tratamento de dados realizados diretamente por essas plataformas.',
        },
      ],
    },
    {
      id: 'stations',
      heading: '8. Responsabilidades das emissoras',
      blocks: [
        {
          kind: 'paragraph',
          text: 'As empresas de comunicação que utilizam o PulchatX poderão determinar:',
        },
        {
          kind: 'list',
          items: [
            'quais funcionalidades disponibilizarão aos seus usuários',
            'quais promoções serão realizadas',
            'quais informações serão necessárias para determinadas ações',
            'regulamentos de promoções',
            'critérios de seleção de participantes',
            'conteúdo das mensagens enviadas através de seus atendimentos',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Quando uma emissora realizar tratamento próprio de dados pessoais, ela também deverá observar as obrigações aplicáveis previstas na legislação de proteção de dados.',
        },
      ],
    },
    {
      id: 'availability',
      heading: '9. Disponibilidade',
      blocks: [
        {
          kind: 'paragraph',
          text: 'O PulchatX procura manter seus serviços disponíveis e seguros, mas não garante funcionamento ininterrupto.',
        },
        {
          kind: 'paragraph',
          text: 'Poderão ocorrer interrupções decorrentes de manutenção, atualizações, falhas de infraestrutura, indisponibilidade de serviços de terceiros, eventos externos ou situações fora do controle razoável da plataforma.',
        },
      ],
    },
    {
      id: 'intellectual-property',
      heading: '10. Propriedade intelectual',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Software, interfaces, marcas, elementos visuais, documentação e demais componentes do PulchatX permanecem protegidos pela legislação aplicável de propriedade intelectual.',
        },
        {
          kind: 'paragraph',
          text: 'A utilização da plataforma não transfere ao usuário qualquer direito de propriedade sobre esses elementos.',
        },
      ],
    },
    {
      id: 'changes',
      heading: '11. Alterações dos Termos',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Estes Termos poderão ser atualizados em decorrência de alterações legais, regulatórias, técnicas ou operacionais.',
        },
        {
          kind: 'paragraph',
          text: 'A versão vigente estará disponível permanentemente nesta página.',
        },
      ],
    },
    {
      id: 'rights',
      heading: '12. Privacidade e direitos do usuário',
      blocks: [
        {
          kind: 'paragraph',
          text: 'A utilização do PulchatX está sujeita também à Política de Privacidade.',
        },
        {
          kind: 'link',
          text: 'O usuário poderá consultar informações sobre coleta, tratamento, armazenamento, segurança e compartilhamento de dados através da página',
          link: { label: 'pulchatx.com/privacy', href: '/privacy' },
        },
        {
          kind: 'link',
          text: 'Para exercer especificamente o direito de solicitar exclusão dos seus dados, utilize',
          link: { label: 'pulchatx.com/delete-data', href: '/delete-data' },
        },
        {
          kind: 'paragraph',
          text: 'O PulchatX busca assegurar transparência no tratamento de dados pessoais e o exercício dos direitos conferidos aos titulares pela legislação brasileira.',
        },
      ],
    },
  ],
};
