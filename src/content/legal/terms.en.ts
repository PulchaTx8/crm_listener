import type { LegalDocument } from './types';

/**
 * A translation of terms.pt.ts, not an independent draft (spec §3.3): same
 * sections, same order, same ids -- so the two stay diffable when the owner
 * amends the terms. See terms.pt.ts for the authoritative Portuguese and the
 * source note.
 *
 * "exercício regular de direitos" is a Brazilian legal term of art -- the
 * LAWFUL exercise of a right, which is what narrows a retention exception --
 * and is rendered here as "the regular exercise of rights" throughout,
 * matching the rendering settled during Task 1's review of privacy.en.ts.
 * Where the source instead says plainly "exercer direitos"/"exercer seus
 * direitos", with no "regular", the qualifier is dropped here too.
 */
export const terms: LegalDocument = {
  title: 'Terms of Service – PulchatX',
  updated: '2026-08-01',
  intro: [
    {
      kind: 'paragraph',
      text: 'These Terms of Service set out the conditions applicable to the use of PulchatX by users who interact with radio or television stations, portals, producers and other communication companies through the platform.',
    },
    {
      kind: 'paragraph',
      text: 'By using the features made available through PulchatX, the user states that they are aware of these Terms and of the Privacy Policy applicable to the service.',
    },
  ],
  sections: [
    {
      id: 'service',
      heading: '1. About the service',
      blocks: [
        {
          kind: 'paragraph',
          text: 'PulchatX is a technology platform intended to facilitate communication and interaction between communication companies and their audience.',
        },
        {
          kind: 'paragraph',
          text: 'The platform may allow, among other features:',
        },
        {
          kind: 'list',
          items: [
            'sending messages',
            'song requests',
            'taking part in promotions',
            'taking part in polls or interactive actions',
            'sending answers and information',
            'communicating with attendants or automated systems',
            'receiving messages related to the interaction that took place',
          ],
        },
        {
          kind: 'paragraph',
          text: 'The features available may vary according to each station or company that uses the platform.',
        },
      ],
    },
    {
      id: 'use',
      heading: '2. Use of the service',
      blocks: [
        {
          kind: 'paragraph',
          text: 'By using PulchatX, the user agrees to provide truthful information whenever this is necessary for a given interaction.',
        },
        {
          kind: 'paragraph',
          text: 'The user must not use the platform to:',
        },
        {
          kind: 'list',
          items: [
            'engage in unlawful activities',
            'send fraudulent or deliberately false content',
            'attempt to gain unauthorized access to the systems',
            'interfere with the operation of the platform',
            'send malicious code',
            'commit fraud in promotions',
            "use other people's identities without authorization",
            'infringe the rights of other people',
          ],
        },
        {
          kind: 'paragraph',
          text: 'PulchatX may adopt measures intended to protect the platform and other users when abusive, fraudulent activities, or activities incompatible with these Terms, are identified.',
        },
      ],
    },
    {
      id: 'song-requests',
      heading: '3. Song requests',
      blocks: [
        {
          kind: 'paragraph',
          text: "The song request feature allows the user to indicate songs they would like to hear on a given station's programming.",
        },
        {
          kind: 'paragraph',
          text: 'Sending a request is not a guarantee that the song will be played.',
        },
        {
          kind: 'paragraph',
          text: 'Selection, availability, timing and the decision to play a song remain the editorial and operational responsibility of the respective station.',
        },
      ],
    },
    {
      id: 'promotions',
      heading: '4. Promotions',
      blocks: [
        {
          kind: 'paragraph',
          text: 'PulchatX may be used as a technology tool for registration in, or participation in, promotions run by stations or other companies.',
        },
        {
          kind: 'paragraph',
          text: 'Each promotion may have its own rules, participation requirements, validity period, selection criteria and regulations.',
        },
        {
          kind: 'paragraph',
          text: "Participation through PulchatX does not replace reading and accepting the promotion's specific rules, where they exist.",
        },
        {
          kind: 'paragraph',
          text: 'Unless expressly stated otherwise, the station or promoting company is responsible for organizing the promotion, setting the rules, selecting participants or winners, and delivering the respective prizes.',
        },
      ],
    },
    {
      id: 'data-protection',
      heading: '5. Protection of personal data',
      blocks: [
        {
          kind: 'paragraph',
          text: "The processing of personal data carried out through PulchatX must observe Law No. 13.709/2018 – Brazil's General Data Protection Law (LGPD) and other applicable rules.",
        },
        {
          kind: 'paragraph',
          text: 'Technical and administrative measures are adopted to protect the information against unauthorized access, disclosure, alteration, destruction or improper processing.',
        },
        {
          kind: 'paragraph',
          text: 'Depending on the architecture and purpose of the systems involved, these measures may include:',
        },
        {
          kind: 'list',
          items: [
            'encryption',
            'access controls',
            'authentication',
            'segregation of information',
            'masking or hiding of data shown to operators',
            'monitoring and logging of activity',
          ],
        },
        {
          kind: 'link',
          text: "More information is available in PulchatX's Privacy Policy, at",
          link: { label: 'pulchatx.com/privacy', href: '/privacy' },
        },
      ],
    },
    {
      id: 'retention',
      heading: '6. Retention and deletion',
      blocks: [
        {
          kind: 'paragraph',
          text: "Personal data will be kept only for as long as necessary for the purposes related to the user's interaction, or for as long as another legal basis for its retention exists.",
        },
        {
          kind: 'paragraph',
          text: "As PulchatX's general policy, data related to users who remain without any interaction for more than 6 (six) months may be automatically deleted or anonymized.",
        },
        {
          kind: 'paragraph',
          text: 'The user may also formally request the deletion of their data at any time through the Data Deletion Request page available on the PulchatX website.',
        },
        {
          kind: 'paragraph',
          text: 'Some information may be preserved when its retention is necessary to comply with a legal or regulatory obligation, for security, fraud prevention, the regular exercise of rights, or other cases permitted by law.',
        },
      ],
    },
    {
      id: 'third-parties',
      heading: '7. Integration with third-party platforms',
      blocks: [
        {
          kind: 'paragraph',
          text: 'PulchatX may operate integrated with third-party services, including communication platforms such as WhatsApp and other products made available by Meta.',
        },
        {
          kind: 'paragraph',
          text: 'The use of those services is also subject to the respective terms, policies and rules established by their providers.',
        },
        {
          kind: 'paragraph',
          text: 'PulchatX does not control the internal data-processing procedures carried out directly by those platforms.',
        },
      ],
    },
    {
      id: 'stations',
      heading: '8. Responsibilities of stations',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Communication companies that use PulchatX may determine:',
        },
        {
          kind: 'list',
          items: [
            'which features they make available to their users',
            'which promotions will be run',
            'which information is required for certain actions',
            'the rules for promotions',
            'the criteria for selecting participants',
            'the content of messages sent through their own support channels',
          ],
        },
        {
          kind: 'paragraph',
          text: 'When a station carries out its own processing of personal data, it must also observe the applicable obligations set out in data protection legislation.',
        },
      ],
    },
    {
      id: 'availability',
      heading: '9. Availability',
      blocks: [
        {
          kind: 'paragraph',
          text: 'PulchatX seeks to keep its services available and secure, but does not guarantee uninterrupted operation.',
        },
        {
          kind: 'paragraph',
          text: "Interruptions may occur due to maintenance, updates, infrastructure failures, unavailability of third-party services, external events, or situations outside the platform's reasonable control.",
        },
      ],
    },
    {
      id: 'intellectual-property',
      heading: '10. Intellectual property',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Software, interfaces, trademarks, visual elements, documentation and other components of PulchatX remain protected under applicable intellectual property law.',
        },
        {
          kind: 'paragraph',
          text: 'Use of the platform does not transfer any ownership right over those elements to the user.',
        },
      ],
    },
    {
      id: 'changes',
      heading: '11. Changes to the Terms',
      blocks: [
        {
          kind: 'paragraph',
          text: 'These Terms may be updated as a result of legal, regulatory, technical or operational changes.',
        },
        {
          kind: 'paragraph',
          text: 'The current version will always be available on this page.',
        },
      ],
    },
    {
      id: 'rights',
      heading: '12. Privacy and user rights',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Use of PulchatX is also subject to the Privacy Policy.',
        },
        {
          kind: 'link',
          text: 'The user may review information about the collection, processing, storage, security and sharing of data through the page',
          link: { label: 'pulchatx.com/privacy', href: '/privacy' },
        },
        {
          kind: 'link',
          text: 'To specifically exercise the right to request deletion of their data, use',
          link: { label: 'pulchatx.com/delete-data', href: '/delete-data' },
        },
        {
          kind: 'paragraph',
          text: 'PulchatX seeks to ensure transparency in the processing of personal data and the exercise of the rights granted to data subjects under Brazilian law.',
        },
      ],
    },
  ],
};
