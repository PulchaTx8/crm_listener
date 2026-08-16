import { afterAll, describe, expect, it } from 'vitest';
import {
  addCompany,
  cleanupUsers,
  createPrizeAs,
  grantRoleWith,
  provisionCustomer,
  signInAs,
} from './harness';

afterAll(cleanupUsers);

/**
 * Block 24, items 7 and 8. What pgTAP cannot reach.
 *
 * `54_vendors.test.sql` proves the table, the constraints and both doors against
 * a session it sets by hand. This suite drives the same doors through a REAL
 * JWT, a real role and a real membership, which is the only way the cross-Station
 * claims are actually tested: `has_permission` reads `auth.uid()`, and the
 * separation between two Stations of one Organization only exists once there are
 * two Stations and a caller who belongs to one of them.
 *
 * Per this directory's standing rule, the actor is a non-owner DELEGATE in every
 * case: Block 1c shipped two defects that thirteen reviews missed because every
 * scenario had the owner driving, and the owner's bypass hid the delegate's
 * failure.
 */
describe('vendors', () => {
  it('a vendor of one Station is invisible from another, inside the same Organization', async () => {
    const label = `vendor-isolation-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Station B ${label}`);

    // The delegate holds the permissions in BOTH Stations, so what separates
    // them below is the row's own company_id rather than a missing grant.
    const delegate = await grantRoleWith(
      customer,
      label,
      ['inventory.view', 'inventory.catalogue'],
      [customer.companyId, otherCompanyId],
    );
    const client = await signInAs(delegate.email, delegate.password);

    const created = await client.rpc('save_vendor', {
      p_company_id: customer.companyId,
      p_name: `Camisetas ${label}`,
      p_document: '12.345.678/0001-90',
    });
    expect(created.error).toBeNull();

    const here = await client
      .from('vendors')
      .select('id,name')
      .eq('company_id', customer.companyId);
    expect(here.error).toBeNull();
    expect(here.data).toHaveLength(1);

    const there = await client.from('vendors').select('id').eq('company_id', otherCompanyId);
    expect(there.error).toBeNull();
    expect(there.data).toHaveLength(0);
  });

  it('is refused for a delegate holding inventory.view alone', async () => {
    const label = `vendor-denied-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(customer, label, ['inventory.view']);
    const client = await signInAs(delegate.email, delegate.password);

    const attempt = await client.rpc('save_vendor', {
      p_company_id: customer.companyId,
      p_name: 'Fornecedor proibido',
    });

    expect(attempt.error).not.toBeNull();
    expect(attempt.error!.message).toMatch(/inventory\.catalogue required/);

    // And nothing was written: a refusal that half-lands is worse than one that
    // does not land at all.
    const rows = await client.from('vendors').select('id').eq('company_id', customer.companyId);
    expect(rows.data).toHaveLength(0);
  });

  it('refuses a stock entry naming another Station’s vendor', async () => {
    const label = `vendor-cross-entry-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const otherCompanyId = await addCompany(customer, `Station B ${label}`);

    const delegate = await grantRoleWith(
      customer,
      label,
      ['inventory.view', 'inventory.catalogue', 'inventory.entry'],
      [customer.companyId, otherCompanyId],
    );
    const client = await signInAs(delegate.email, delegate.password);

    // The vendor belongs to Station B; the prize and the entry to Station A.
    const foreign = await client.rpc('save_vendor', {
      p_company_id: otherCompanyId,
      p_name: `Fornecedor B ${label}`,
    });
    expect(foreign.error).toBeNull();

    const prizeId = await createPrizeAs(customer, `Camiseta ${label}`);

    const entry = await client.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_type: 'PURCHASE_ENTRY',
      p_quantity: 3,
      p_vendor_id: foreign.data as string,
    });

    expect(entry.error).not.toBeNull();
    // The door's own sentence, not the foreign key's constraint name: 23503
    // would reach the operator as "Could not save".
    expect(entry.error!.message).toMatch(/vendor not found in this station/);
  });

  /**
   * THE ONE THE FOREIGN KEY CANNOT CATCH, driven end to end.
   * `vendors_id_company_unique` is non-partial — a foreign key cannot reference a
   * partial index — so it cannot see `deleted_at`, and an archived supplier would
   * be accepted silently by the database.
   */
  it('refuses a stock entry naming an archived vendor, and keeps the entries it already supplied', async () => {
    const label = `vendor-archived-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(customer, label, [
      'inventory.view',
      'inventory.catalogue',
      'inventory.entry',
    ]);
    const client = await signInAs(delegate.email, delegate.password);

    const created = await client.rpc('save_vendor', {
      p_company_id: customer.companyId,
      p_name: `Brindes ${label}`,
    });
    expect(created.error).toBeNull();
    const vendorId = created.data as string;

    const prizeId = await createPrizeAs(customer, `Caneca ${label}`);

    const first = await client.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_type: 'PURCHASE_ENTRY',
      p_quantity: 10,
      p_invoice_number: 'NF-24',
      p_vendor_id: vendorId,
    });
    expect(first.error).toBeNull();

    const archived = await client.rpc('archive_vendor', { p_vendor_id: vendorId });
    expect(archived.error).toBeNull();

    const second = await client.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_type: 'PURCHASE_ENTRY',
      p_quantity: 1,
      p_vendor_id: vendorId,
    });
    expect(second.error).not.toBeNull();
    expect(second.error!.message).toMatch(/vendor not found in this station/);

    // Archiving never rewrites history: list_movements' vendor join is
    // deliberately unfiltered by deleted_at, so the purchase still names them.
    const ledger = await client.rpc('list_movements', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
    });
    expect(ledger.error).toBeNull();
    const row = (ledger.data ?? []).find((m) => m.movement_id === (first.data as string));
    expect(row?.vendor_name).toBe(`Brindes ${label}`);
  });

  it('records the vendor on the entry and reports it on the ledger', async () => {
    const label = `vendor-entry-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(customer, label, [
      'inventory.view',
      'inventory.catalogue',
      'inventory.entry',
    ]);
    const client = await signInAs(delegate.email, delegate.password);

    const created = await client.rpc('save_vendor', {
      p_company_id: customer.companyId,
      p_name: `Norte ${label}`,
      p_city: 'São Paulo',
    });
    expect(created.error).toBeNull();

    const prizeId = await createPrizeAs(customer, `Boné ${label}`);

    const entry = await client.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_type: 'BARTER_ENTRY',
      p_quantity: 4,
      p_vendor_id: created.data as string,
    });
    expect(entry.error).toBeNull();

    const ledger = await client.rpc('list_movements', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
    });
    expect(ledger.error).toBeNull();
    const row = (ledger.data ?? [])[0];
    expect(row?.vendor_id).toBe(created.data as string);
    expect(row?.vendor_name).toBe(`Norte ${label}`);
  });

  it('leaves an entry with no vendor listable rather than dropping it', async () => {
    const label = `vendor-absent-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const delegate = await grantRoleWith(customer, label, ['inventory.view', 'inventory.entry']);
    const client = await signInAs(delegate.email, delegate.password);

    const prizeId = await createPrizeAs(customer, `Sem fornecedor ${label}`);

    const entry = await client.rpc('record_stock_entry', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
      p_type: 'MANUAL_ENTRY',
      p_quantity: 2,
    });
    expect(entry.error).toBeNull();

    // The join is LEFT, so an entry from nobody in particular — a barter from a
    // listener, or any entry recorded before Block 24 — still lists.
    const ledger = await client.rpc('list_movements', {
      p_company_id: customer.companyId,
      p_prize_id: prizeId,
    });
    expect(ledger.error).toBeNull();
    expect(ledger.data).toHaveLength(1);
    expect((ledger.data ?? [])[0]?.vendor_id).toBeNull();
    expect((ledger.data ?? [])[0]?.vendor_name).toBeNull();
  });
});
