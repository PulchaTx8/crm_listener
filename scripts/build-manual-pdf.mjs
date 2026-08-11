import { readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

/**
 * Prints every HTML file in Manual/ to a PDF beside it.
 *
 * The HTML is the source and it is versioned; the PDF is a build artefact.
 * A PDF nobody can regenerate is a document that stops being true the first
 * time the thing it describes changes -- which for a deployment runbook is
 * the week after it is written.
 *
 * CHROMIUM RATHER THAN @react-pdf/renderer, which this repository already
 * depends on for report exports. That library takes React components, and
 * fourteen pages of operator prose written as components is a cost with no
 * matching gain: the print stylesheet in the HTML gives page breaks, widow
 * control and A4 margins for free, and anybody can open the source in a
 * browser to see what they are about to ship.
 *
 * `Manual/` is in .dockerignore, so nothing here reaches the image.
 */
const MANUAL = resolve(import.meta.dirname, '..', 'Manual');

const files = (await readdir(MANUAL)).filter((name) => name.endsWith('.html'));

if (files.length === 0) {
  console.error(`no .html files in ${MANUAL}`);
  process.exit(1);
}

const browser = await chromium.launch();

try {
  for (const file of files) {
    const source = join(MANUAL, file);
    const target = join(MANUAL, `${basename(file, '.html')}.pdf`);

    const page = await browser.newPage();
    // `networkidle` rather than `load`: the page is self-contained today, but a
    // future edit that adds a data: image or a webfont should not silently
    // print before it resolves.
    await page.goto(pathToFileURL(source).href, { waitUntil: 'networkidle' });

    await page.pdf({
      path: target,
      format: 'A4',
      // The @page rule in the document owns the margins. Setting them here too
      // would apply both, and the symptom is a page that looks fine in a
      // browser and cramped on paper.
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="width:100%;font:8pt sans-serif;color:#888;padding:0 16mm;text-align:right">' +
        '<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });

    await page.close();
    console.log(`${file} -> ${basename(target)}`);
  }
} finally {
  await browser.close();
}
