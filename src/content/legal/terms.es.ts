import type { LegalDocument } from './types';

/**
 * A translation of terms.pt.ts, not an independent draft (spec §3.3): same
 * sections, same order, same ids -- so the two stay diffable when the owner
 * amends the terms. See terms.pt.ts for the authoritative Portuguese and the
 * source note.
 *
 * "exercício regular de direitos" is a Brazilian legal term of art -- the
 * LAWFUL exercise of a right, which is what narrows a retention exception --
 * and is rendered here as "el ejercicio regular de derechos" throughout,
 * matching privacy.es.ts. Where the source instead says plainly "exercer
 * direitos"/"exercer seus direitos", with no "regular", the qualifier is
 * dropped here too.
 */
export const terms: LegalDocument = {
  title: 'Términos de Servicio – PulchatX',
  updated: '2026-08-01',
  intro: [
    {
      kind: 'paragraph',
      text: 'Estos Términos de Servicio establecen las condiciones aplicables al uso de PulchatX por parte de usuarios que interactúan con emisoras de radio, televisión, portales, productoras y otras empresas de comunicación a través de la plataforma.',
    },
    {
      kind: 'paragraph',
      text: 'Al utilizar las funciones puestas a disposición a través de PulchatX, el usuario declara estar al tanto de estos Términos y de la Política de Privacidad aplicable al servicio.',
    },
  ],
  sections: [
    {
      id: 'service',
      heading: '1. Sobre el servicio',
      blocks: [
        {
          kind: 'paragraph',
          text: 'PulchatX es una plataforma tecnológica destinada a facilitar la comunicación y la interacción entre empresas de comunicación y su público.',
        },
        {
          kind: 'paragraph',
          text: 'La plataforma podrá permitir, entre otras funcionalidades:',
        },
        {
          kind: 'list',
          items: [
            'envío de mensajes',
            'pedidos de canciones',
            'participación en promociones',
            'participación en encuestas o acciones interactivas',
            'envío de respuestas e información',
            'comunicación con agentes o sistemas automatizados',
            'recepción de mensajes relacionados con la interacción realizada',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Las funcionalidades disponibles podrán variar según cada emisora o empresa que utilice la plataforma.',
        },
      ],
    },
    {
      id: 'use',
      heading: '2. Uso del servicio',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Al utilizar PulchatX, el usuario acepta proporcionar información veraz cuando esta sea necesaria para una determinada interacción.',
        },
        {
          kind: 'paragraph',
          text: 'El usuario no deberá utilizar la plataforma para:',
        },
        {
          kind: 'list',
          items: [
            'practicar actividades ilícitas',
            'enviar contenido fraudulento o deliberadamente falso',
            'intentar obtener acceso no autorizado a los sistemas',
            'interferir en el funcionamiento de la plataforma',
            'enviar códigos maliciosos',
            'cometer fraude en promociones',
            'utilizar identidades de terceros sin autorización',
            'vulnerar los derechos de otras personas',
          ],
        },
        {
          kind: 'paragraph',
          text: 'PulchatX podrá adoptar medidas destinadas a proteger la plataforma y a los demás usuarios cuando se identifiquen actividades abusivas, fraudulentas o incompatibles con estos Términos.',
        },
      ],
    },
    {
      id: 'song-requests',
      heading: '3. Pedidos de canciones',
      blocks: [
        {
          kind: 'paragraph',
          text: 'La función de pedido de canciones permite al usuario indicar canciones que le gustaría escuchar en la programación de una determinada emisora.',
        },
        {
          kind: 'paragraph',
          text: 'El envío del pedido no representa una garantía de que la canción será emitida.',
        },
        {
          kind: 'paragraph',
          text: 'La selección, disponibilidad, horario y decisión de emisión siguen siendo responsabilidad editorial y operativa de la respectiva emisora.',
        },
      ],
    },
    {
      id: 'promotions',
      heading: '4. Promociones',
      blocks: [
        {
          kind: 'paragraph',
          text: 'PulchatX podrá utilizarse como herramienta tecnológica para la inscripción o participación en promociones realizadas por emisoras u otras empresas.',
        },
        {
          kind: 'paragraph',
          text: 'Cada promoción podrá tener su propio reglamento, requisitos de participación, período de vigencia, criterios de selección y reglas.',
        },
        {
          kind: 'paragraph',
          text: 'La participación a través de PulchatX no sustituye la lectura y aceptación del reglamento específico de la promoción, cuando exista.',
        },
        {
          kind: 'paragraph',
          text: 'Salvo cuando se informe expresamente lo contrario, la emisora o empresa promotora es responsable de la organización de la promoción, la definición de las reglas, la selección de los participantes o ganadores y la entrega de los respectivos premios.',
        },
      ],
    },
    {
      id: 'data-protection',
      heading: '5. Protección de datos personales',
      blocks: [
        {
          kind: 'paragraph',
          text: 'El tratamiento de datos personales realizado a través de PulchatX deberá observar la Ley n.º 13.709/2018 – Ley General de Protección de Datos Personales de Brasil (LGPD) y demás normas aplicables.',
        },
        {
          kind: 'paragraph',
          text: 'Se adoptan medidas técnicas y administrativas destinadas a proteger la información frente al acceso no autorizado, la divulgación, la alteración, la destrucción o el tratamiento inadecuado.',
        },
        {
          kind: 'paragraph',
          text: 'Según la arquitectura y la finalidad de los sistemas involucrados, esas medidas podrán incluir:',
        },
        {
          kind: 'list',
          items: [
            'cifrado',
            'controles de acceso',
            'autenticación',
            'segregación de información',
            'enmascaramiento u ocultación de datos mostrados a los operadores',
            'monitoreo y registro de actividades',
          ],
        },
        {
          kind: 'link',
          text: 'Más información está disponible en la Política de Privacidad de PulchatX, en',
          link: { label: 'pulchatx.com/privacy', href: '/privacy' },
        },
      ],
    },
    {
      id: 'retention',
      heading: '6. Retención y eliminación',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Los datos personales se conservarán solo mientras sean necesarios para las finalidades relacionadas con la interacción del usuario o mientras exista otra justificación legal para su conservación.',
        },
        {
          kind: 'paragraph',
          text: 'Como política general de PulchatX, los datos relacionados con usuarios que permanezcan más de 6 (seis) meses sin ninguna interacción podrán eliminarse o anonimizarse automáticamente.',
        },
        {
          kind: 'paragraph',
          text: 'El usuario también podrá solicitar formalmente la eliminación de sus datos en cualquier momento a través de la página de Solicitud de Eliminación de Datos disponible en el sitio web de PulchatX.',
        },
        {
          kind: 'paragraph',
          text: 'Determinada información podrá conservarse cuando su conservación sea necesaria para el cumplimiento de una obligación legal o regulatoria, la seguridad, la prevención de fraude, el ejercicio regular de derechos u otros supuestos permitidos por la legislación.',
        },
      ],
    },
    {
      id: 'third-parties',
      heading: '7. Integración con plataformas de terceros',
      blocks: [
        {
          kind: 'paragraph',
          text: 'PulchatX podrá operar integrado con servicios de terceros, incluyendo plataformas de comunicación como WhatsApp y otros productos puestos a disposición por Meta.',
        },
        {
          kind: 'paragraph',
          text: 'El uso de esos servicios también está sujeto a los respectivos términos, políticas y reglas establecidos por sus proveedores.',
        },
        {
          kind: 'paragraph',
          text: 'PulchatX no controla los procedimientos internos de tratamiento de datos realizados directamente por esas plataformas.',
        },
      ],
    },
    {
      id: 'stations',
      heading: '8. Responsabilidades de las emisoras',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Las empresas de comunicación que utilizan PulchatX podrán determinar:',
        },
        {
          kind: 'list',
          items: [
            'qué funcionalidades pondrán a disposición de sus usuarios',
            'qué promociones se realizarán',
            'qué información será necesaria para determinadas acciones',
            'los reglamentos de las promociones',
            'los criterios de selección de participantes',
            'el contenido de los mensajes enviados a través de sus atenciones',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Cuando una emisora realice su propio tratamiento de datos personales, también deberá observar las obligaciones aplicables previstas en la legislación de protección de datos.',
        },
      ],
    },
    {
      id: 'availability',
      heading: '9. Disponibilidad',
      blocks: [
        {
          kind: 'paragraph',
          text: 'PulchatX procura mantener sus servicios disponibles y seguros, pero no garantiza un funcionamiento ininterrumpido.',
        },
        {
          kind: 'paragraph',
          text: 'Podrán producirse interrupciones derivadas de mantenimiento, actualizaciones, fallas de infraestructura, indisponibilidad de servicios de terceros, eventos externos o situaciones fuera del control razonable de la plataforma.',
        },
      ],
    },
    {
      id: 'intellectual-property',
      heading: '10. Propiedad intelectual',
      blocks: [
        {
          kind: 'paragraph',
          text: 'El software, las interfaces, las marcas, los elementos visuales, la documentación y demás componentes de PulchatX permanecen protegidos por la legislación aplicable de propiedad intelectual.',
        },
        {
          kind: 'paragraph',
          text: 'El uso de la plataforma no transfiere al usuario ningún derecho de propiedad sobre esos elementos.',
        },
      ],
    },
    {
      id: 'changes',
      heading: '11. Cambios en los Términos',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Estos Términos podrán actualizarse como consecuencia de cambios legales, regulatorios, técnicos u operativos.',
        },
        {
          kind: 'paragraph',
          text: 'La versión vigente estará disponible de forma permanente en esta página.',
        },
      ],
    },
    {
      id: 'rights',
      heading: '12. Privacidad y derechos del usuario',
      blocks: [
        {
          kind: 'paragraph',
          text: 'El uso de PulchatX también está sujeto a la Política de Privacidad.',
        },
        {
          kind: 'link',
          text: 'El usuario podrá consultar información sobre la recopilación, el tratamiento, el almacenamiento, la seguridad y la compartición de datos a través de la página',
          link: { label: 'pulchatx.com/privacy', href: '/privacy' },
        },
        {
          kind: 'link',
          text: 'Para ejercer específicamente el derecho a solicitar la eliminación de sus datos, utilice',
          link: { label: 'pulchatx.com/delete-data', href: '/delete-data' },
        },
        {
          kind: 'paragraph',
          text: 'PulchatX procura garantizar la transparencia en el tratamiento de datos personales y el ejercicio de los derechos conferidos a los titulares por la legislación brasileña.',
        },
      ],
    },
  ],
};
