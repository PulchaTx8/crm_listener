import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';

/**
 * Block 8b, Task 1. The Block 0 spec named both of these libraries and neither
 * was ever installed, so this block installs them -- and this file is why the
 * install is a task of its own rather than a line in another task's setup.
 *
 * @react-pdf/renderer renders through a React reconciler of its own. Its peer
 * range admits React 19, but a peer range is a promise about RESOLUTION, not
 * about behaviour, and the fallback if it is wrong (rendering the panel PDF
 * through the browser's print pipeline) is a different design that has to be
 * chosen BEFORE the block is spent, not after.
 *
 * Both assertions check a magic number rather than "did it return something".
 * A renderer that silently produced an HTML body, or a workbook writer that
 * emitted its error page, would still hand back a non-empty buffer.
 */
describe('Block 8b dependencies', () => {
  it('renders a PDF to a Buffer under React 19', async () => {
    const { Document, Page, Text, View, renderToBuffer } = await import('@react-pdf/renderer');
    const React = await import('react');

    const doc = React.createElement(
      Document,
      null,
      React.createElement(
        Page,
        { size: 'A4' },
        React.createElement(View, null, React.createElement(Text, null, 'PulchaTX')),
      ),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = await renderToBuffer(doc as any);

    expect(buffer.byteLength).toBeGreaterThan(0);
    // Every PDF begins with this.
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('streams an XLSX workbook without building it in memory', async () => {
    const ExcelJS = (await import('exceljs')).default;

    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve) => sink.on('end', () => resolve()));

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink });
    const sheet = workbook.addWorksheet('Rows');
    sheet.addRow(['a', 'b']).commit();
    sheet.commit();
    await workbook.commit();
    await done;

    const out = Buffer.concat(chunks);

    expect(out.byteLength).toBeGreaterThan(0);
    // XLSX is a ZIP container; 'PK' is the local file header signature. This is
    // what distinguishes a real workbook from a writer that emitted nothing but
    // its own XML preamble.
    expect(out.subarray(0, 2).toString('latin1')).toBe('PK');
  });
});
