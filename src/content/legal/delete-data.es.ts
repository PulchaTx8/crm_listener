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
 * and is rendered here as "el ejercicio regular de derechos", matching
 * privacy.es.ts. Where the source instead says plainly "exercer seus
 * direitos", with no "regular", the qualifier is dropped (the `stations`
 * section, below).
 */
export const deleteData: LegalDocument = {
  title: 'Solicitud de Eliminación de Datos',
  updated: '2026-08-01',
  intro: [
    {
      kind: 'paragraph',
      text: 'PulchatX respeta los derechos de los titulares de datos personales y permite que los usuarios soliciten la eliminación de la información asociada a sus interacciones realizadas a través de la plataforma.',
    },
    {
      kind: 'paragraph',
      text: 'El tratamiento de estas solicitudes se realiza de conformidad con la Ley n.º 13.709/2018 – Ley General de Protección de Datos Personales de Brasil (LGPD).',
    },
  ],
  sections: [
    {
      id: 'how',
      heading: 'Cómo solicitar la eliminación',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Para solicitar la eliminación de sus datos personales, utilice el formulario disponible en esta página.',
        },
        {
          kind: 'paragraph',
          text: 'Indique los datos necesarios para identificar la interacción, como el número de teléfono utilizado en la atención u otra información solicitada por el formulario.',
        },
        {
          kind: 'paragraph',
          text: 'Esta información se utilizará exclusivamente para localizar los registros relacionados con el usuario y confirmar la legitimidad de la solicitud.',
        },
      ],
    },
    {
      id: 'after',
      heading: 'Qué sucede después de la solicitud',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Tras la recepción del pedido:',
        },
        {
          kind: 'list',
          items: [
            'la solicitud será registrada',
            'podremos llevar a cabo procedimientos para confirmar la identidad o legitimidad del solicitante',
            'se localizarán los datos asociados al usuario',
            'los datos comprendidos en la solicitud serán eliminados o anonimizados de los sistemas de PulchatX, cuando corresponda',
            'los registros que deban conservarse por obligación legal, regulatoria, prevención de fraude o el ejercicio regular de derechos podrán preservarse durante el período necesario',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Cuando existan datos conservados en razón de una obligación legal u otro supuesto previsto en la legislación, su uso quedará limitado a la finalidad que justificó su conservación.',
        },
      ],
    },
    {
      id: 'what-data',
      heading: 'Qué datos pueden eliminarse',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Según las interacciones realizadas, el procedimiento podrá abarcar información como:',
        },
        {
          kind: 'list',
          items: [
            'datos de identificación',
            'número de teléfono',
            'identificadores relacionados con el canal de comunicación',
            'historial de mensajes almacenado por PulchatX',
            'pedidos de canciones',
            'registros de participación en promociones',
            'respuestas proporcionadas por el usuario',
            'demás información vinculada directamente al usuario',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Cuando sea técnicamente apropiado, determinados registros podrán anonimizarse en lugar de eliminarse, eliminando la posibilidad de asociarlos con una persona identificada o identificable.',
        },
      ],
    },
    {
      id: 'stations',
      heading: 'Datos en poder de empresas de comunicación',
      blocks: [
        {
          kind: 'paragraph',
          text: 'PulchatX es una plataforma utilizada por emisoras y otras empresas de comunicación.',
        },
        {
          kind: 'paragraph',
          text: 'Según la forma en que se haya realizado la atención, determinada información también podrá existir en los sistemas propios de la emisora o de otros proveedores involucrados en la comunicación.',
        },
        {
          kind: 'paragraph',
          text: 'Cuando corresponda, PulchatX podrá orientar al usuario sobre la necesidad de ejercer sus derechos también directamente ante la empresa responsable de la atención.',
        },
      ],
    },
    {
      id: 'meta',
      heading: 'Datos provenientes de WhatsApp o de Meta',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Si la interacción se produjo a través de WhatsApp u otro servicio de Meta, la solicitud realizada a PulchatX abarca los datos almacenados y controlados a través de los sistemas de PulchatX.',
        },
        {
          kind: 'paragraph',
          text: 'Los datos conservados directamente por Meta están sujetos a las políticas y los procedimientos de la propia Meta.',
        },
      ],
    },
    {
      id: 'inactivity',
      heading: 'Eliminación automática por inactividad',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Además de la posibilidad de solicitar la eliminación en cualquier momento, PulchatX adopta una política de retención para usuarios inactivos.',
        },
        {
          kind: 'paragraph',
          text: 'Los datos asociados a usuarios que permanezcan más de 6 (seis) meses sin ninguna interacción podrán eliminarse o anonimizarse automáticamente, salvo cuando su conservación sea necesaria por obligación legal, regulatoria, seguridad, prevención de fraude, el ejercicio regular de derechos u otro supuesto permitido por la legislación.',
        },
      ],
    },
    {
      id: 'protection',
      heading: 'Protección durante el proceso de eliminación',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Mientras permanezcan almacenados, los datos están protegidos por medidas técnicas y administrativas de seguridad, incluidos controles de acceso y mecanismos de protección y cifrado aplicables a los sistemas utilizados.',
        },
        {
          kind: 'paragraph',
          text: 'La solicitud de eliminación no exige el pago de ninguna tarifa a PulchatX.',
        },
      ],
    },
  ],
};
