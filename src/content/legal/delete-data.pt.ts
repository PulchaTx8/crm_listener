import type { LegalDocument } from './types';

/**
 * Portuguese is the AUTHORITATIVE text (spec §3.3): the owner's own words,
 * corrected only for the product name ("PulChatX" -> "PulchatX", task brief).
 * delete-data.en.ts and delete-data.es.ts are translations of these same
 * sections, in this same order, under these same ids -- not independent
 * drafts. See
 * `.superpowers/sdd/2026-08-13-public-legal-pages/legal-source-pt.md`,
 * DOCUMENT 2, for the source this was transcribed from.
 *
 * PROSE ONLY (task brief, Step 3). The source's final section, "Formulário de
 * solicitação", is NOT transcribed here: it describes the request form, and
 * the form itself is rendered below this article by the page (Task 5).
 * Writing it as a prose section too would leave the page telling the reader
 * to fill in the form below, twice.
 *
 * The source names no day for "Última atualização" and, for this document,
 * does not even carry that line in the prose -- but `LegalDocument.updated`
 * is required, and the binding notes at the end of the source file fix
 * 2026-08-01 for all three documents alike.
 */
export const deleteData: LegalDocument = {
  title: 'Solicitação de Exclusão de Dados',
  updated: '2026-08-01',
  intro: [
    {
      kind: 'paragraph',
      text: 'O PulchatX respeita os direitos dos titulares de dados pessoais e permite que usuários solicitem a exclusão das informações associadas às suas interações realizadas através da plataforma.',
    },
    {
      kind: 'paragraph',
      text: 'O tratamento dessas solicitações é realizado em conformidade com a Lei nº 13.709/2018 – Lei Geral de Proteção de Dados Pessoais (LGPD).',
    },
  ],
  sections: [
    {
      id: 'how',
      heading: 'Como solicitar a exclusão',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Para solicitar a exclusão dos seus dados pessoais, utilize o formulário disponível nesta página.',
        },
        {
          kind: 'paragraph',
          text: 'Informe os dados necessários para identificação da interação, como o número de telefone utilizado no atendimento ou outra informação solicitada pelo formulário.',
        },
        {
          kind: 'paragraph',
          text: 'Essas informações serão utilizadas exclusivamente para localizar os registros relacionados ao usuário e confirmar a legitimidade da solicitação.',
        },
      ],
    },
    {
      id: 'after',
      heading: 'O que acontece depois da solicitação',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Após o recebimento do pedido:',
        },
        {
          kind: 'list',
          items: [
            'a solicitação será registrada',
            'poderemos realizar procedimentos para confirmar a identidade ou legitimidade do solicitante',
            'serão localizados os dados associados ao usuário',
            'os dados abrangidos pela solicitação serão excluídos ou anonimizados dos sistemas do PulchatX, quando aplicável',
            'registros que precisem ser mantidos por obrigação legal, regulatória, prevenção de fraude ou exercício regular de direitos poderão ser preservados pelo período necessário',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Quando houver dados mantidos em razão de obrigação legal ou outra hipótese prevista na legislação, sua utilização ficará limitada à finalidade que justificou sua conservação.',
        },
      ],
    },
    {
      id: 'what-data',
      heading: 'Quais dados podem ser excluídos',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Dependendo das interações realizadas, o procedimento poderá abranger informações como:',
        },
        {
          kind: 'list',
          items: [
            'dados de identificação',
            'número de telefone',
            'identificadores relacionados ao canal de comunicação',
            'histórico de mensagens armazenado pelo PulchatX',
            'pedidos de músicas',
            'registros de participação em promoções',
            'respostas fornecidas pelo usuário',
            'demais informações vinculadas diretamente ao usuário',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Quando tecnicamente apropriado, determinados registros poderão ser anonimizados em vez de eliminados, removendo a possibilidade de associação com uma pessoa identificada ou identificável.',
        },
      ],
    },
    {
      id: 'stations',
      heading: 'Dados de empresas de comunicação',
      blocks: [
        {
          kind: 'paragraph',
          text: 'O PulchatX é uma plataforma utilizada por emissoras e outras empresas de comunicação.',
        },
        {
          kind: 'paragraph',
          text: 'Dependendo da forma como o atendimento foi realizado, determinadas informações também poderão existir nos sistemas próprios da emissora ou de outros prestadores envolvidos na comunicação.',
        },
        {
          kind: 'paragraph',
          text: 'Quando aplicável, o PulchatX poderá orientar o usuário sobre a necessidade de exercer seus direitos também diretamente perante a empresa responsável pelo atendimento.',
        },
      ],
    },
    {
      id: 'meta',
      heading: 'Dados provenientes do WhatsApp ou da Meta',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Caso a interação tenha ocorrido através do WhatsApp ou de outro serviço da Meta, a solicitação feita ao PulchatX abrange os dados armazenados e controlados através dos sistemas do PulchatX.',
        },
        {
          kind: 'paragraph',
          text: 'Dados mantidos diretamente pela Meta estão sujeitos às políticas e aos procedimentos da própria Meta.',
        },
      ],
    },
    {
      id: 'inactivity',
      heading: 'Exclusão automática por inatividade',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Além da possibilidade de solicitar a exclusão a qualquer momento, o PulchatX adota uma política de retenção para usuários inativos.',
        },
        {
          kind: 'paragraph',
          text: 'Dados associados a usuários que permaneçam mais de 6 (seis) meses sem qualquer interação poderão ser automaticamente excluídos ou anonimizados, salvo quando sua conservação for necessária por obrigação legal, regulatória, segurança, prevenção de fraude, exercício regular de direitos ou outra hipótese permitida pela legislação.',
        },
      ],
    },
    {
      id: 'protection',
      heading: 'Proteção durante o processo de exclusão',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Enquanto permanecerem armazenados, os dados são protegidos por medidas técnicas e administrativas de segurança, incluindo controles de acesso e mecanismos de proteção e criptografia aplicáveis aos sistemas utilizados.',
        },
        {
          kind: 'paragraph',
          text: 'A solicitação de exclusão não exige pagamento de qualquer taxa ao PulchatX.',
        },
      ],
    },
  ],
};
