// Reproduction test for INC-004: commit 2bf06ff "refactor(payment): stricter amount validation"
// validateAmount() at charge.js:34 rejects any amount whose nanos field is non-zero,
// throwing "Invalid amount: fractional value <nanos> nanos" for legitimate charges.
const test = require('node:test');
const assert = require('node:assert');

// --- Mock external calls (no network to the live system, no flagd) ---
const serverSdkPath = require.resolve('@openfeature/server-sdk');
require.cache[serverSdkPath] = {
  id: serverSdkPath, filename: serverSdkPath, loaded: true,
  exports: {
    OpenFeature: {
      setProviderAndWait: async () => {},
      getClient: () => ({
        getNumberValue: async () => 0,     // paymentFailure flag = 0
        getBooleanValue: async () => false, // emitRawPii = false
      }),
    },
  },
};
const flagdPath = require.resolve('@openfeature/flagd-provider');
require.cache[flagdPath] = {
  id: flagdPath, filename: flagdPath, loaded: true,
  exports: { FlagdProvider: class FlagdProvider {} },
};
// @opentelemetry/api without a registered SDK is a no-op; tracer/meter are safe.

const { charge } = require('./charge');

const validCard = {
  creditCardNumber: '4111111111111111', // test Visa number
  creditCardCvv: 123,
  creditCardExpirationYear: 2099,
  creditCardExpirationMonth: 12,
};

// Exact non-zero nanos values observed in production warn logs (INC-004):
// 950000000, 549999995, 749999997, 359999989, 499999990
for (const nanos of [950000000, 549999995, 749999997, 359999989, 499999990]) {
  test(`legitimate charge with units=10 nanos=${nanos} must succeed`, async () => {
    const request = {
      creditCard: validCard,
      amount: { units: 10, nanos, currencyCode: 'USD' },
    };
    const result = await charge(request); // must NOT throw for a valid amount
    assert.ok(result.transactionId, 'expected a transaction id');
  });
}

// Control: a charge with nanos=0 (only value passing `nanos % 1e9 === 0`) succeeds,
// proving the failure is specific to the new validation, not the test setup.
test('control: charge with nanos=0 succeeds', async () => {
  const request = {
    creditCard: validCard,
    amount: { units: 10, nanos: 0, currencyCode: 'USD' },
  };
  const result = await charge(request);
  assert.ok(result.transactionId, 'expected a transaction id');
});

// Regression guard: truly malformed amounts must still be rejected.
test('malformed amount with nanos out of range (>= 1e9) is rejected', async () => {
  const request = {
    creditCard: validCard,
    amount: { units: 10, nanos: 1e9, currencyCode: 'USD' },
  };
  await assert.rejects(charge(request), /Invalid amount: fractional value/);
});

test('malformed amount with negative nanos is rejected', async () => {
  const request = {
    creditCard: validCard,
    amount: { units: 10, nanos: -5, currencyCode: 'USD' },
  };
  await assert.rejects(charge(request), /Invalid amount: fractional value/);
});

test('malformed amount with NaN nanos is rejected', async () => {
  const request = {
    creditCard: validCard,
    amount: { units: 10, nanos: NaN, currencyCode: 'USD' },
  };
  await assert.rejects(charge(request), /Invalid amount: fractional value/);
});
