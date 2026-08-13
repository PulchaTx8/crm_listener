import type { LegalDocument } from './types';

/**
 * A translation of privacy.pt.ts, not an independent draft (spec §3.3): same
 * sections, same order, same ids -- so the two stay diffable when the owner
 * amends the policy. See privacy.pt.ts for the authoritative Portuguese and
 * the source note.
 */
export const privacy: LegalDocument = {
  title: 'Privacy Policy – PulchatX',
  updated: '2026-08-01',
  intro: [
    {
      kind: 'paragraph',
      text: "PulchatX respects the privacy and protection of users' personal data and processes this information in accordance with Law No. 13.709/2018 – Brazil's General Data Protection Law (LGPD) and other applicable rules.",
    },
    {
      kind: 'paragraph',
      text: 'This Privacy Policy explains how data may be collected, used, stored, protected and deleted when a person interacts with radio or television stations, portals, producers or other communication companies that use PulchatX.',
    },
  ],
  sections: [
    {
      id: 'about',
      heading: '1. About PulchatX',
      blocks: [
        {
          kind: 'paragraph',
          text: 'PulchatX is a technology platform for the relationship between communication companies and their audience.',
        },
        { kind: 'paragraph', text: 'Through the platform, a person may, for example:' },
        {
          kind: 'list',
          items: [
            'send messages to a station',
            'request songs',
            'take part in promotions',
            'answer questions, polls or promotional actions',
            'submit information required to take part in campaigns',
            'interact with automated support or with operators',
            'receive communications related to an interaction the user themself started',
          ],
        },
        {
          kind: 'paragraph',
          text: 'These interactions may take place over WhatsApp, web pages, widgets or other channels made available by the companies that use PulchatX.',
        },
      ],
    },
    {
      id: 'data',
      heading: '2. Data that may be processed',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Depending on the interaction, data such as the following may be processed:',
        },
        {
          kind: 'list',
          items: [
            'name',
            'phone number',
            'identifiers related to the account used for communication',
            'messages sent by the user',
            'song requests',
            'information provided to take part in promotions',
            'answers to questions, polls or forms',
            'date and time of the interactions',
            "technical logs required for the platform's operation and security",
          ],
        },
        {
          kind: 'paragraph',
          text: "Certain promotions may request additional information when necessary to identify the participant, comply with the promotion's rules, or deliver a prize.",
        },
        {
          kind: 'paragraph',
          text: 'PulchatX seeks to limit collection to the information necessary for each purpose.',
        },
      ],
    },
    {
      id: 'purpose',
      heading: '3. Purpose of processing',
      blocks: [
        { kind: 'paragraph', text: 'Data may be used to:' },
        {
          kind: 'list',
          items: [
            'enable communication between the user and the station',
            'record and process song requests',
            'enable registration and participation in promotions',
            'identify participants and winners when applicable',
            'enable the delivery of prizes',
            'keep an operational history of the interactions',
            'prevent fraud, abuse or improper use of the services',
            'ensure the security and stability of the platform',
            'comply with legal or regulatory obligations',
            'exercise rights in administrative, judicial or arbitration proceedings',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Data must not be used for purposes incompatible with those disclosed to the user.',
        },
      ],
    },
    {
      id: 'meta',
      heading: '4. WhatsApp and Meta platforms',
      blocks: [
        {
          kind: 'paragraph',
          text: "When the user contacts PulchatX through WhatsApp or another Meta service, certain information necessary for the communication may be transmitted by those platforms to PulchatX and to the communication company responsible for the user's interaction.",
        },
        {
          kind: 'paragraph',
          text: "Processing carried out by Meta within its own services is subject to Meta's own policies and terms.",
        },
        {
          kind: 'paragraph',
          text: "PulchatX uses only the information made available through the authorized integrations necessary to provide the services related to the user's interaction.",
        },
      ],
    },
    {
      id: 'sharing',
      heading: '5. Data sharing',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Information may be made available to the station or communication company the user chose to interact with.',
        },
        {
          kind: 'paragraph',
          text: 'Technology service providers necessary for hosting, database, security, communication, processing and operation of the platform may also be used.',
        },
        { kind: 'paragraph', text: "PulchatX does not sell users' personal data." },
        {
          kind: 'paragraph',
          text: "Sharing will be limited to what is necessary to provide the service, comply with legal obligations, protect the platform's security, or exercise a right.",
        },
      ],
    },
    {
      id: 'security',
      heading: '6. Security and protection of information',
      blocks: [
        {
          kind: 'paragraph',
          text: 'PulchatX adopts technical and administrative measures intended to protect personal data against unauthorized access, loss, alteration, disclosure or improper processing.',
        },
        { kind: 'paragraph', text: 'Measures used may include:' },
        {
          kind: 'list',
          items: [
            'encryption of information during transmission and, where applicable, during storage',
            'access control over the systems',
            'user authentication and authorization',
            'segregation of data between the companies served by the platform',
            'masking or hiding of certain information in operational interfaces',
            'logging and monitoring of access',
            'security procedures aimed at preventing improper access',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Access to information is limited to the systems, companies and professionals who need that data to carry out the purposes set out in this Policy.',
        },
      ],
    },
    {
      id: 'retention',
      heading: '7. Data retention',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Personal data will be kept only for as long as necessary to fulfil the purposes for which it was collected.',
        },
        {
          kind: 'paragraph',
          text: "As PulchatX's retention policy, data associated with users who remain without any interaction for more than 6 (six) months may be automatically deleted or anonymized.",
        },
        {
          kind: 'paragraph',
          text: 'Automatic deletion may not occur when retaining the information is necessary for:',
        },
        {
          kind: 'list',
          items: [
            'compliance with a legal or regulatory obligation',
            'the exercise of a right',
            'the prevention or investigation of fraud',
            'compliance with an order from a competent authority',
            'other cases of retention permitted by applicable law',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Anonymized data, once it no longer allows the user to be identified, may be used for statistics, metrics and improvement of the services.',
        },
      ],
    },
    {
      id: 'rights',
      heading: '8. Data subject rights',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Under the LGPD, the data subject may exercise the rights provided for by applicable law, including, where applicable:',
        },
        {
          kind: 'list',
          items: [
            'confirmation that processing exists',
            'access to their personal data',
            'correction of incomplete, inaccurate or outdated information',
            'request for anonymization, blocking or deletion',
            'information about sharing that has taken place',
            'withdrawal of consent, when processing is based on consent',
            'objection to processing in the cases provided for by law',
            'request for deletion of their personal data',
          ],
        },
      ],
    },
    {
      id: 'deletion',
      heading: '9. Requesting deletion of data',
      blocks: [
        {
          kind: 'link',
          text: 'A user may formally request the deletion of their data through the page',
          link: { label: 'pulchatx.com/delete-data', href: '/delete-data' },
        },
        {
          kind: 'paragraph',
          text: 'The request may require confirmation of certain information so we can verify that it is being made by the data subject themself, or by someone legitimately authorized to do so.',
        },
        {
          kind: 'paragraph',
          text: 'Once the request has been validated, the data it covers will be deleted or anonymized, except for data that must be retained due to a legal or regulatory obligation or another case authorized by the LGPD.',
        },
      ],
    },
    {
      id: 'promotions',
      heading: '10. Data related to promotions',
      blocks: [
        {
          kind: 'paragraph',
          text: 'When the user decides to take part in a promotion, information necessary to validate their participation may be requested.',
        },
        {
          kind: 'paragraph',
          text: 'Each promotion may have its own rules, set by the station or company responsible for the campaign.',
        },
        {
          kind: 'paragraph',
          text: 'Using PulchatX as a technology tool does not, by itself, mean that PulchatX is the organizer of, or responsible for, the prizes offered by the station.',
        },
      ],
    },
    {
      id: 'changes',
      heading: '11. Changes to this Policy',
      blocks: [
        {
          kind: 'paragraph',
          text: 'This Privacy Policy may be updated to reflect changes in legislation, in the services, or in data security and protection procedures.',
        },
        {
          kind: 'paragraph',
          text: 'The current version will always be available on this page.',
        },
      ],
    },
    {
      id: 'contact',
      heading: '12. Contact',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Questions related to privacy, data protection or the exercise of rights provided for by the LGPD may be directed through the support channels made available on the PulchatX website.',
        },
        {
          kind: 'link',
          text: 'For specific requests to delete data, use',
          link: { label: 'pulchatx.com/delete-data', href: '/delete-data' },
        },
      ],
    },
  ],
};
