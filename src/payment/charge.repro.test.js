// Regression test for INC-015: commit 7faad825 "refactor(payment): stricter amount validation"
// validateAmount() at charge.js:34 rejected any amount whose nanos field was non-zero
// (`nanos % 1e9 !== 0` is true for every integer in (0, 1e9)), throwing
// "Invalid amount: fractional value <nanos> nanos" for legitimate charges and driving
// the payment error rate to ~48.6% (production traces a7b7ef048e544b670af0fe36aae80b83,
// 9fe11537e8b93a1fa65a368791718736).
// The fix accepts nanos in the valid protobuf range [0, 1e9) and still rejects
// negative, >= 1e9, or non-finite values.
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
        getNumberValue: async () => 0,      // paymentFailure flag = 0
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

// Exact non-zero nanos values observed in production error logs (INC-015):
// 699999995 (trace a7b7ef048e544b670af0fe36aae80b83) and 376304289
// (trace 9fe11537e8b93a1fa65a368791718736), plus ordinary fractional amounts.
for (const nanos of [699999995, 376304289, 500000000, 1, 999999999]) {
  test(`legitimate charge with units=10 nanos=${nanos} must succeed`, async () => {
    const request = {
      creditCard: validCard,
      amount: { units: 10, nanos, currencyCode: 'USD' },
    };
    const result = await charge(request); // must NOT throw for a valid amount
    assert.ok(result.transactionId, 'expected a transaction id');
  });
}

// The gRPC handler receives amount.units as a protobuf int64 ({low, high, unsigned}).
test('legitimate charge with protobuf int64 units and fractional nanos succeeds', async () => {
  const request = {
    creditCard: validCard,
    amount: {
      units: { low: 10, high: 0, unsigned: true },
      nanos: 699999995,
      currencyCode: 'USD',
    },
  };
  const result = await charge(request);
  assert.ok(result.transactionId, 'expected a transaction id');
});

// Control: a charge with nanos=0 succeeds, proving the setup is healthy.
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

test('malformed amount with negative units is rejected', async () => {
  const request = {
    creditCard: validCard,
    amount: { units: -1, nanos: 0, currencyCode: 'USD' },
  };
  await assert.rejects(charge(request), /Invalid amount: -1/);
});
