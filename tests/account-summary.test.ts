/**
 * The account summary behind an appointment card.
 *
 * Two things matter here beyond "it parses". First, the technician's claim on
 * an account is the appointment assignment, so an unassigned appointment must
 * not leak the customer. Second, Property_Detail__c is a custom object: an org
 * without it has to still show the contacts, because a panel that goes blank
 * tells the technician nothing about why.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/salesforce-auth', () => ({
  getAccessToken: async () => 'token-not-real',
  SalesforceAuthError: class extends Error {},
}));
vi.mock('@/lib/token-store', () => ({
  readTokens: async () => ({ accessToken: 'x', instanceUrl: 'https://example.my.salesforce.com' }),
}));

const APPOINTMENT = '08pg7000001YCW1AAO';
const ACCOUNT = '001g700001BxWZiAAN';
const CONTACT = '003g700000p5WGPAA2';

/** What each call answers with; a handler may be replaced per test. */
interface Org {
  assigned: boolean;
  appointmentFields: string[];
  appointment: Record<string, unknown> | null;
  account: Record<string, unknown> | null | 'error';
  properties: Record<string, unknown>[] | 'error';
}

function org(overrides: Partial<Org> = {}): Org {
  return {
    assigned: true,
    appointmentFields: ['Id', 'AccountId', 'ContactId', 'AppointmentNumber'],
    appointment: { Id: APPOINTMENT, AccountId: ACCOUNT, ContactId: CONTACT },
    account: {
      Id: ACCOUNT,
      Name: 'Alvarez Residence',
      ShippingStreet: '1625 Chandler Ridge Drive',
      ShippingCity: 'Round Rock',
      ShippingState: 'Texas',
      ShippingPostalCode: '78665',
      ShippingCountry: 'United States',
      Contacts: {
        records: [
          { Id: '003OTHER0000000AAA', Name: 'Aaron Early', Title: null, Email: null, Phone: '(512) 555-0100', MobilePhone: null },
          { Id: CONTACT, Name: 'John Smith', Title: 'Business Analyst', Email: 'jsmith@example.com', Phone: '(415) 555-6592', MobilePhone: null },
        ],
      },
    },
    properties: [
      {
        Id: 'a4pg7000000Ys2nAAC',
        Name: 'Alvarez Residence',
        Property_Size__c: 1610,
        Bedrooms__c: 3,
        Bathrooms__c: 2,
        Year_Built__c: 2012,
        Property_Type__c: 'Townhome',
        Security_System_Base__c: 'Command panel',
        Monitoring_Status__c: 'In Service',
      },
    ],
    ...overrides,
  };
}

/** Routes Salesforce REST calls by what the URL asks for. */
function stubOrg(state: Org) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const decoded = decodeURIComponent(String(url));
      calls.push(decoded);

      if (decoded.includes('/describe')) {
        return Response.json({ fields: state.appointmentFields.map((name) => ({ name })) });
      }
      if (decoded.includes('FROM AssignedResource')) {
        return Response.json({ records: state.assigned ? [{ Id: '0Hnx' }] : [] });
      }
      if (decoded.includes('FROM ServiceAppointment')) {
        return Response.json({ records: state.appointment ? [state.appointment] : [] });
      }
      if (decoded.includes('FROM Account')) {
        if (state.account === 'error') return Response.json([{ message: 'boom', errorCode: 'INVALID_QUERY' }], { status: 400 });
        return Response.json({ records: state.account ? [state.account] : [] });
      }
      if (decoded.includes('FROM Property_Detail__c')) {
        if (state.properties === 'error') {
          // What Salesforce returns when the custom object does not exist.
          return Response.json([{ message: "sObject type 'Property_Detail__c' is not supported.", errorCode: 'INVALID_TYPE' }], { status: 400 });
        }
        return Response.json({ records: state.properties });
      }
      throw new Error(`unexpected call: ${decoded}`);
    }),
  );
  return calls;
}

let getAccountSummary: typeof import('@/lib/dashboard').getAccountSummary;

beforeEach(async () => {
  // Fresh module per test: describeFields caches for 30 minutes.
  vi.resetModules();
  ({ getAccountSummary } = await import('@/lib/dashboard'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */

describe('reading the account behind an appointment', () => {
  it('returns the property details and contacts', async () => {
    stubOrg(org());

    const result = await getAccountSummary('0Hng7000000TR1xGAG', APPOINTMENT);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.accountName).toBe('Alvarez Residence');
    expect(result.address.city).toBe('Round Rock');
    expect(result.properties.status).toBe('ok');
    if (result.properties.status !== 'ok') return;
    expect(result.properties.data[0]).toMatchObject({
      sizeSqFt: 1610,
      bedrooms: 3,
      bathrooms: 2,
      yearBuilt: 2012,
      propertyType: 'Townhome',
      securitySystemBase: 'Command panel',
      monitoringStatus: 'In Service',
    });
  });

  it("lists the appointment's own contact first, whatever the query order", async () => {
    stubOrg(org());

    const result = await getAccountSummary('0Hng7000000TR1xGAG', APPOINTMENT);
    if (result.status !== 'ok' || result.contacts.status !== 'ok') throw new Error('expected contacts');

    expect(result.contacts.data[0]).toMatchObject({ name: 'John Smith', primary: true });
    expect(result.contacts.data[1]).toMatchObject({ name: 'Aaron Early', primary: false });
  });

  it('keeps empty fields as null so the panel can leave their rows out', async () => {
    stubOrg(org());

    const result = await getAccountSummary('0Hng7000000TR1xGAG', APPOINTMENT);
    if (result.status !== 'ok' || result.contacts.status !== 'ok') throw new Error('expected contacts');

    const other = result.contacts.data.find((contact) => contact.name === 'Aaron Early');
    expect(other).toMatchObject({ title: null, email: null, mobilePhone: null });
  });
});

describe('ownership', () => {
  it('refuses an appointment that is not assigned to the technician', async () => {
    const calls = stubOrg(org({ assigned: false }));

    const result = await getAccountSummary('0Hng7000000TR1xGAG', APPOINTMENT);

    expect(result).toMatchObject({ status: 'unavailable', code: 'forbidden' });
    // The customer must not have been read at all.
    expect(calls.some((call) => call.includes('FROM Account'))).toBe(false);
  });

  it('rejects anything that is not a service appointment id', async () => {
    stubOrg(org());

    await expect(getAccountSummary('0Hng7000000TR1xGAG', '001g700001BxWZiAAN')).resolves.toMatchObject({
      status: 'unavailable',
      code: 'not_found',
    });
  });
});

describe('orgs that are shaped differently', () => {
  it('still shows the contacts when the custom property object is absent', async () => {
    stubOrg(org({ properties: 'error' }));

    const result = await getAccountSummary('0Hng7000000TR1xGAG', APPOINTMENT);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    // The property section degrades on its own.
    expect(result.properties.status).toBe('unavailable');
    expect(result.contacts.status).toBe('ok');
    if (result.contacts.status !== 'ok') return;
    expect(result.contacts.data).toHaveLength(2);
  });

  it('says so when appointments carry no account link at all', async () => {
    stubOrg(org({ appointmentFields: ['Id', 'AppointmentNumber'] }));

    const result = await getAccountSummary('0Hng7000000TR1xGAG', APPOINTMENT);

    expect(result).toMatchObject({ status: 'unavailable', code: 'not_found' });
    if (result.status !== 'unavailable') return;
    expect(result.message).toMatch(/not linked to a customer account/i);
  });

  it('says so when this particular appointment has no account', async () => {
    stubOrg(org({ appointment: { Id: APPOINTMENT, AccountId: null, ContactId: null } }));

    const result = await getAccountSummary('0Hng7000000TR1xGAG', APPOINTMENT);

    expect(result).toMatchObject({ status: 'unavailable', code: 'not_found' });
    if (result.status !== 'unavailable') return;
    expect(result.message).toMatch(/No customer account is linked/i);
  });

  it('reports a failed account read rather than returning a half-empty panel', async () => {
    stubOrg(org({ account: 'error' }));

    await expect(getAccountSummary('0Hng7000000TR1xGAG', APPOINTMENT)).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('handles an account with no contacts', async () => {
    const account = { ...(org().account as Record<string, unknown>) };
    delete account.Contacts;
    stubOrg(org({ account }));

    const result = await getAccountSummary('0Hng7000000TR1xGAG', APPOINTMENT);
    if (result.status !== 'ok' || result.contacts.status !== 'ok') throw new Error('expected contacts');

    expect(result.contacts.data).toEqual([]);
  });
});
