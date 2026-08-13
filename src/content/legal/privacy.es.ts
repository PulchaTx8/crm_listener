import type { LegalDocument } from './types';

/**
 * A translation of privacy.pt.ts, not an independent draft (spec §3.3): same
 * sections, same order, same ids -- so the two stay diffable when the owner
 * amends the policy. See privacy.pt.ts for the authoritative Portuguese and
 * the source note.
 */
export const privacy: LegalDocument = {
  title: 'Política de Privacidad – PulchatX',
  updated: '2026-08-01',
  intro: [
    {
      kind: 'paragraph',
      text: 'PulchatX respeta la privacidad y la protección de los datos personales de los usuarios y trata esa información de conformidad con la Ley n.º 13.709/2018 – Ley General de Protección de Datos Personales de Brasil (LGPD) y demás normas aplicables.',
    },
    {
      kind: 'paragraph',
      text: 'Esta Política de Privacidad explica cómo pueden recopilarse, utilizarse, almacenarse, protegerse y eliminarse los datos cuando una persona interactúa con emisoras de radio, televisión, portales, productoras u otras empresas de comunicación que utilizan PulchatX.',
    },
  ],
  sections: [
    {
      id: 'about',
      heading: '1. Sobre PulchatX',
      blocks: [
        {
          kind: 'paragraph',
          text: 'PulchatX es una plataforma tecnológica destinada a la relación entre empresas de comunicación y su público.',
        },
        { kind: 'paragraph', text: 'A través de la plataforma, una persona puede, por ejemplo:' },
        {
          kind: 'list',
          items: [
            'enviar mensajes a una emisora',
            'solicitar canciones',
            'participar en promociones',
            'responder preguntas, encuestas o acciones promocionales',
            'enviar la información necesaria para participar en campañas',
            'interactuar con atenciones automatizadas o realizadas por operadores',
            'recibir comunicaciones relacionadas con la interacción iniciada por el propio usuario',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Las interacciones pueden producirse por WhatsApp, páginas web, widgets u otros canales puestos a disposición por las empresas que utilizan PulchatX.',
        },
      ],
    },
    {
      id: 'data',
      heading: '2. Datos que pueden tratarse',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Según la interacción realizada, podrán tratarse datos como:',
        },
        {
          kind: 'list',
          items: [
            'nombre',
            'número de teléfono',
            'identificadores relacionados con la cuenta utilizada para la comunicación',
            'mensajes enviados por el usuario',
            'pedidos de canciones',
            'información proporcionada para participar en promociones',
            'respuestas a preguntas, encuestas o formularios',
            'fecha y hora de las interacciones',
            'registros técnicos necesarios para el funcionamiento y la seguridad de la plataforma',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Determinadas promociones podrán solicitar información adicional cuando sea necesaria para identificar al participante, cumplir el reglamento o entregar un eventual premio.',
        },
        {
          kind: 'paragraph',
          text: 'PulchatX procura limitar la recopilación a la información necesaria para cada finalidad.',
        },
      ],
    },
    {
      id: 'purpose',
      heading: '3. Finalidad del tratamiento',
      blocks: [
        { kind: 'paragraph', text: 'Los datos podrán utilizarse para:' },
        {
          kind: 'list',
          items: [
            'permitir la comunicación entre el usuario y la emisora',
            'registrar y procesar pedidos de canciones',
            'posibilitar la inscripción y la participación en promociones',
            'identificar participantes y ganadores cuando corresponda',
            'viabilizar la entrega de premios',
            'mantener un historial operativo de las interacciones',
            'prevenir fraude, abuso o uso indebido de los servicios',
            'garantizar la seguridad y la estabilidad de la plataforma',
            'atender obligaciones legales o regulatorias',
            'ejercer derechos en procesos administrativos, judiciales o arbitrales',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Los datos no deben utilizarse para finalidades incompatibles con las informadas al usuario.',
        },
      ],
    },
    {
      id: 'meta',
      heading: '4. WhatsApp y las plataformas de Meta',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Cuando el usuario se pone en contacto a través de WhatsApp u otro servicio de Meta, determinada información necesaria para la comunicación puede ser transmitida por esas plataformas a PulchatX y a la empresa de comunicación responsable de la atención.',
        },
        {
          kind: 'paragraph',
          text: 'El tratamiento realizado por Meta en sus propios servicios está sujeto a las políticas y los términos de la propia Meta.',
        },
        {
          kind: 'paragraph',
          text: 'PulchatX utiliza únicamente la información puesta a disposición a través de las integraciones autorizadas y necesarias para prestar los servicios relacionados con la interacción del usuario.',
        },
      ],
    },
    {
      id: 'sharing',
      heading: '5. Compartición de datos',
      blocks: [
        {
          kind: 'paragraph',
          text: 'La información podrá ponerse a disposición de la emisora o empresa de comunicación con la que el usuario decidió interactuar.',
        },
        {
          kind: 'paragraph',
          text: 'También podrán utilizarse proveedores de servicios tecnológicos necesarios para el alojamiento, la base de datos, la seguridad, la comunicación, el procesamiento y la operación de la plataforma.',
        },
        { kind: 'paragraph', text: 'PulchatX no comercializa los datos personales de los usuarios.' },
        {
          kind: 'paragraph',
          text: 'La compartición se limitará a lo necesario para la prestación del servicio, el cumplimiento de obligaciones legales, la seguridad de la plataforma o el ejercicio regular de derechos.',
        },
      ],
    },
    {
      id: 'security',
      heading: '6. Seguridad y protección de la información',
      blocks: [
        {
          kind: 'paragraph',
          text: 'PulchatX adopta medidas técnicas y administrativas destinadas a proteger los datos personales frente al acceso no autorizado, la pérdida, la alteración, la divulgación o el tratamiento inadecuado.',
        },
        { kind: 'paragraph', text: 'Entre las medidas utilizadas pueden estar:' },
        {
          kind: 'list',
          items: [
            'cifrado de la información durante la transmisión y, cuando corresponda, durante el almacenamiento',
            'control de acceso a los sistemas',
            'autenticación y autorización de usuarios',
            'segregación de datos entre las empresas atendidas por la plataforma',
            'enmascaramiento u ocultación de determinada información en las interfaces operativas',
            'registro y monitoreo de accesos',
            'procedimientos de seguridad destinados a prevenir el acceso indebido',
          ],
        },
        {
          kind: 'paragraph',
          text: 'El acceso a la información está limitado a los sistemas, las empresas y los profesionales que necesiten esos datos para cumplir las finalidades previstas en esta Política.',
        },
      ],
    },
    {
      id: 'retention',
      heading: '7. Retención de los datos',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Los datos personales se conservarán solo durante el período necesario para cumplir las finalidades para las que fueron recopilados.',
        },
        {
          kind: 'paragraph',
          text: 'Como política de retención de PulchatX, los datos asociados a usuarios que permanezcan sin ninguna interacción durante un período superior a 6 (seis) meses podrán ser eliminados o anonimizados automáticamente.',
        },
        {
          kind: 'paragraph',
          text: 'La eliminación automática podrá no producirse cuando la conservación de la información sea necesaria para:',
        },
        {
          kind: 'list',
          items: [
            'el cumplimiento de una obligación legal o regulatoria',
            'el ejercicio regular de derechos',
            'la prevención o investigación de fraude',
            'el cumplimiento de una determinación de autoridad competente',
            'otros supuestos de conservación permitidos por la legislación aplicable',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Los datos anonimizados, cuando ya no permitan identificar al usuario, podrán utilizarse para estadísticas, métricas y mejora de los servicios.',
        },
      ],
    },
    {
      id: 'rights',
      heading: '8. Derechos del titular',
      blocks: [
        {
          kind: 'paragraph',
          text: 'En los términos de la LGPD, el titular podrá ejercer los derechos previstos por la legislación aplicable, incluyendo, cuando corresponda:',
        },
        {
          kind: 'list',
          items: [
            'confirmación de la existencia de tratamiento',
            'acceso a sus datos personales',
            'corrección de información incompleta, inexacta o desactualizada',
            'solicitud de anonimización, bloqueo o eliminación',
            'información sobre las comparticiones realizadas',
            'revocación del consentimiento, cuando el tratamiento se base en el consentimiento',
            'oposición al tratamiento en los supuestos previstos por la ley',
            'solicitud de eliminación de sus datos personales',
          ],
        },
      ],
    },
    {
      id: 'deletion',
      heading: '9. Solicitud de eliminación de los datos',
      blocks: [
        {
          kind: 'link',
          text: 'El usuario puede solicitar formalmente la eliminación de sus datos a través de la página',
          link: { label: 'pulchatx.com/delete-data', href: '/delete-data' },
        },
        {
          kind: 'paragraph',
          text: 'La solicitud podrá exigir la confirmación de determinada información para que podamos verificar que el pedido lo realiza el propio titular o una persona legítimamente autorizada.',
        },
        {
          kind: 'paragraph',
          text: 'Una vez validada la solicitud, los datos comprendidos en el pedido serán eliminados o anonimizados, salvo aquellos que deban conservarse por obligación legal, regulatoria u otro supuesto autorizado por la LGPD.',
        },
      ],
    },
    {
      id: 'promotions',
      heading: '10. Datos relacionados con promociones',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Cuando el usuario decida participar en una promoción, podrá solicitarse la información necesaria para validar su participación.',
        },
        {
          kind: 'paragraph',
          text: 'Cada promoción podrá tener un reglamento propio definido por la emisora o empresa responsable de la acción.',
        },
        {
          kind: 'paragraph',
          text: 'El uso de PulchatX como herramienta tecnológica no significa, por sí solo, que PulchatX sea el organizador o responsable de los premios ofrecidos por la emisora.',
        },
      ],
    },
    {
      id: 'changes',
      heading: '11. Cambios en esta Política',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Esta Política de Privacidad podrá actualizarse para reflejar cambios en la legislación, en los servicios o en los procedimientos de seguridad y protección de datos.',
        },
        {
          kind: 'paragraph',
          text: 'La versión vigente estará siempre disponible en esta página.',
        },
      ],
    },
    {
      id: 'contact',
      heading: '12. Contacto',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Las dudas relacionadas con la privacidad, la protección de datos o el ejercicio de los derechos previstos por la LGPD podrán dirigirse a través de los canales de atención disponibles en el sitio web de PulchatX.',
        },
        {
          kind: 'link',
          text: 'Para solicitudes específicas de eliminación de datos, utilice',
          link: { label: 'pulchatx.com/delete-data', href: '/delete-data' },
        },
      ],
    },
  ],
};
