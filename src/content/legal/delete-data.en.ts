import type { LegalDocument } from './types';

/**
 * A translation of delete-data.pt.ts, not an independent draft (spec §3.3):
 * same sections, same order, same ids -- so the two stay diffable when the
 * owner amends the policy. See delete-data.pt.ts for the authoritative
 * Portuguese, the source note, and why the source's "Formulário de
 * solicitação" section is not transcribed as content here either.
 *
 * "exercício regular de direitos" is a Brazilian legal term of art -- the
 * LAWFUL exercise of a right, which is what narrows a retention exception --
 * and is rendered here as "the regular exercise of rights", matching the
 * rendering settled during Task 1's review of privacy.en.ts. Where the source
 * instead says plainly "exercer seus direitos", with no "regular", the
 * qualifier is dropped (the `stations` section, below).
 */
export const deleteData: LegalDocument = {
  title: 'Data Deletion Request',
  updated: '2026-08-01',
  intro: [
    {
      kind: 'paragraph',
      text: 'PulchatX respects the rights of data subjects and allows users to request the deletion of information associated with their interactions carried out through the platform.',
    },
    {
      kind: 'paragraph',
      text: "The handling of these requests is carried out in accordance with Law No. 13.709/2018 – Brazil's General Data Protection Law (LGPD).",
    },
  ],
  sections: [
    {
      id: 'how',
      heading: 'How to request deletion',
      blocks: [
        {
          kind: 'paragraph',
          text: 'To request the deletion of your personal data, use the form available on this page.',
        },
        {
          kind: 'paragraph',
          text: 'Provide the data needed to identify the interaction, such as the phone number used in the exchange or other information requested by the form.',
        },
        {
          kind: 'paragraph',
          text: "This information will be used solely to locate the records related to the user and to confirm the request's legitimacy.",
        },
      ],
    },
    {
      id: 'after',
      heading: 'What happens after the request',
      blocks: [
        {
          kind: 'paragraph',
          text: 'After the request is received:',
        },
        {
          kind: 'list',
          items: [
            'the request will be logged',
            "we may carry out procedures to confirm the requester's identity or legitimacy",
            'the data associated with the user will be located',
            "the data covered by the request will be deleted or anonymized from PulchatX's systems, when applicable",
            'records that need to be kept for a legal or regulatory obligation, fraud prevention, or the regular exercise of rights may be preserved for as long as necessary',
          ],
        },
        {
          kind: 'paragraph',
          text: 'When data is kept due to a legal obligation or another case provided for by law, its use will be limited to the purpose that justified its retention.',
        },
      ],
    },
    {
      id: 'what-data',
      heading: 'What data may be deleted',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Depending on the interactions carried out, the procedure may cover information such as:',
        },
        {
          kind: 'list',
          items: [
            'identification data',
            'phone number',
            'identifiers related to the communication channel',
            'message history stored by PulchatX',
            'song requests',
            'records of participation in promotions',
            'answers provided by the user',
            'other information directly linked to the user',
          ],
        },
        {
          kind: 'paragraph',
          text: 'When technically appropriate, certain records may be anonymized instead of deleted, removing the possibility of associating them with an identified or identifiable person.',
        },
      ],
    },
    {
      id: 'stations',
      heading: 'Data held by communication companies',
      blocks: [
        {
          kind: 'paragraph',
          text: 'PulchatX is a platform used by stations and other communication companies.',
        },
        {
          kind: 'paragraph',
          text: "Depending on how the interaction was carried out, certain information may also exist in the station's own systems or those of other providers involved in the communication.",
        },
        {
          kind: 'paragraph',
          text: 'When applicable, PulchatX may advise the user of the need to exercise their rights directly with the company responsible for the interaction as well.',
        },
      ],
    },
    {
      id: 'meta',
      heading: 'Data originating from WhatsApp or Meta',
      blocks: [
        {
          kind: 'paragraph',
          text: "If the interaction took place through WhatsApp or another Meta service, the request made to PulchatX covers the data stored and controlled through PulchatX's systems.",
        },
        {
          kind: 'paragraph',
          text: "Data kept directly by Meta is subject to Meta's own policies and procedures.",
        },
      ],
    },
    {
      id: 'inactivity',
      heading: 'Automatic deletion for inactivity',
      blocks: [
        {
          kind: 'paragraph',
          text: 'In addition to the ability to request deletion at any time, PulchatX adopts a retention policy for inactive users.',
        },
        {
          kind: 'paragraph',
          text: 'Data associated with users who remain without any interaction for more than 6 (six) months may be automatically deleted or anonymized, except when its retention is necessary for a legal or regulatory obligation, security, fraud prevention, the regular exercise of rights, or another case permitted by law.',
        },
      ],
    },
    {
      id: 'protection',
      heading: 'Protection during the deletion process',
      blocks: [
        {
          kind: 'paragraph',
          text: 'While still stored, data is protected by technical and administrative security measures, including access controls and the protection and encryption mechanisms applicable to the systems used.',
        },
        {
          kind: 'paragraph',
          text: 'A deletion request does not require the payment of any fee to PulchatX.',
        },
      ],
    },
  ],
};
