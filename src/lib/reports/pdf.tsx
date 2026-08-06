import React from 'react';
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer';
import { REPORT_TYPE_LABELS, type PanelType } from './types';

/**
 * Block 8b. A panel, on a page somebody prints.
 *
 * IT RENDERS THE CAPTURED PAYLOAD AND QUERIES NOTHING. Design D2: the three
 * aggregates are SECURITY INVOKER and granted to authenticated only, so the
 * worker cannot call them -- the numbers were computed at request time, by the
 * same call the screen makes, under the requester's own rights. This file turns
 * that JSON into a document and has no other job.
 *
 * IT RENDERS GENERICALLY over `cards`, `breakdowns` and `top` rather than
 * naming the three panels' fields. Those field sets are 8a's and will grow; a
 * renderer that enumerated them would silently drop whatever 8a's successor
 * adds, and a report missing a figure the screen shows is the failure this
 * block spends most of its design avoiding.
 *
 * A WITHHELD FIGURE IS ABSENT FROM THE PAGE AND NAMED IN THE FOOTER. It is
 * never printed as zero: 8a's D13 is that zero and "you may not see this" must
 * not look alike, and a printed document is the worst place to blur them,
 * because it outlives the session that produced it.
 */

interface PanelPdfInput {
  reportType: PanelType;
  payload: unknown;
  stationNames: readonly string[];
  filters: Record<string, unknown>;
  requestedByLabel: string;
  requestedAt: string;
}

interface Slice {
  label: string;
  count: number;
}

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: 'Helvetica', color: '#111827' },
  title: { fontSize: 18, marginBottom: 4, fontFamily: 'Helvetica-Bold' },
  subtitle: { fontSize: 9, color: '#4b5563', marginBottom: 2 },
  sectionTitle: { fontSize: 12, marginTop: 18, marginBottom: 6, fontFamily: 'Helvetica-Bold' },
  cardGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  card: {
    width: '31%',
    padding: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 4,
    marginBottom: 8,
  },
  cardLabel: { fontSize: 8, color: '#6b7280', marginBottom: 3 },
  cardValue: { fontSize: 16, fontFamily: 'Helvetica-Bold' },
  cardPrevious: { fontSize: 8, color: '#6b7280', marginTop: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  rowLabel: { flex: 1, paddingRight: 8 },
  footer: {
    marginTop: 22,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    fontSize: 8,
    color: '#4b5563',
  },
  withheldLine: { marginTop: 3 },
});

export async function renderPanelPdf(input: PanelPdfInput): Promise<Buffer> {
  const payload = (input.payload ?? {}) as Record<string, unknown>;
  const cards = asRecord(payload.cards);
  const breakdowns = asRecord(payload.breakdowns);
  const top = asRecord(payload.top);
  const period = asRecord(payload.period);
  const withheld = Array.isArray(payload.withheld) ? payload.withheld : [];

  const doc = (
    <Document title={REPORT_TYPE_LABELS[input.reportType]}>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>{REPORT_TYPE_LABELS[input.reportType]}</Text>
        <Text style={styles.subtitle}>Stations: {input.stationNames.join(', ')}</Text>
        {period.from ? (
          <Text style={styles.subtitle}>
            Period: {String(period.from)} to {String(period.to)} (end exclusive)
          </Text>
        ) : null}

        {Object.keys(cards).length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Figures</Text>
            <View style={styles.cardGrid}>
              {Object.entries(cards).map(([key, value]) => {
                const card = asRecord(value);
                return (
                  <View key={key} style={styles.card}>
                    <Text style={styles.cardLabel}>{humanise(key)}</Text>
                    <Text style={styles.cardValue}>{formatNumber(card.current)}</Text>
                    {typeof card.previous === 'number' ? (
                      <Text style={styles.cardPrevious}>
                        previous: {formatNumber(card.previous)}
                      </Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
          </>
        ) : null}

        {[...Object.entries(breakdowns), ...Object.entries(top)].map(([key, value]) => {
          const slices = asSlices(value);
          if (slices.length === 0) return null;
          return (
            <View key={key} wrap={false}>
              <Text style={styles.sectionTitle}>{humanise(key)}</Text>
              {slices.map((slice, index) => (
                <View key={`${key}-${index}`} style={styles.row}>
                  <Text style={styles.rowLabel}>{slice.label}</Text>
                  <Text>{formatNumber(slice.count)}</Text>
                </View>
              ))}
            </View>
          );
        })}

        <View style={styles.footer}>
          <Text>Requested by {input.requestedByLabel} at {input.requestedAt}</Text>
          <Text>Filters: {describe(input.filters)}</Text>
          {withheld.length === 0 ? (
            <Text style={styles.withheldLine}>
              Withheld figures: none — this document carries every figure of this panel.
            </Text>
          ) : (
            <>
              <Text style={styles.withheldLine}>
                Withheld figures:{' '}
                {withheld
                  .map((item) => {
                    const entry = asRecord(item);
                    return entry.needs
                      ? `${String(entry.figure)} (needs ${String(entry.needs)})`
                      : String(entry.figure ?? item);
                  })
                  .join(', ')}
              </Text>
              <Text style={styles.withheldLine}>
                These figures are ABSENT from this document rather than shown as zero. Zero and
                &quot;you may not see this&quot; are not the same claim.
              </Text>
            </>
          )}
        </View>
      </Page>
    </Document>
  );

  return renderToBuffer(doc);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asSlices(value: unknown): Slice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (typeof record.label !== 'string' || typeof record.count !== 'number') return [];
    return [{ label: record.label, count: record.count }];
  });
}

function formatNumber(value: unknown): string {
  return typeof value === 'number' ? value.toLocaleString('en-US') : '—';
}

function humanise(key: string): string {
  return key.replaceAll('_', ' ').replace(/^./, (character) => character.toUpperCase());
}

function describe(filters: Record<string, unknown>): string {
  const entries = Object.entries(filters).filter(
    ([, value]) => value !== null && value !== undefined && value !== '',
  );
  return entries.length === 0
    ? 'none'
    : entries.map(([key, value]) => `${key}=${String(value)}`).join('; ');
}
