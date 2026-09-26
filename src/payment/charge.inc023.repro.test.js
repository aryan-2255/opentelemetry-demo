// INC-023 reproduction: charge() must accept a valid protobuf amount whose
// nanos field is a nonzero value in [0, 1e9) (e.g. 699999995), per the
// INC-015 fix. Diagnosis: commit c1226054 re-introduced `nanos % 1e9 !== 0`
// in validateAmount, rejecting every fractional charge.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fakeSpan = {
  setAttribute() {}, setAttributes() {}, recordException() {},
  setStatus() {}, end() {},
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  switch (request) {
    case '@opentelemetry/api':
      return {
        context: { active: () => ({}) },
        propagation: { getBaggage: () => undefined },
        trace: { getTracer: () => ({ startSpan: () => fakeSpan }) },
        metrics: { getMeter: () => ({ createCounter: () => ({ add: () => {} }) }) },
        SpanStatusCode: { ERROR: 2 },
      };
    case '@opentelemetry/semantic-conventions':
      return { ATTR_ERROR_TYPE: 'error.type' };
    case 'simple-card-validator':
      return () => ({ getCardDetails: () => ({ card_type: 'visa', valid: true }) });
    case 'uuid':
      return { v4: () => 'repro-transaction-id' };
    case '@openfeature/server-sdk':
      return {
        OpenFeature: {
          setProviderAndWait: async () => {},
          getClient: () => ({
            getNumberValue: async () => 0,   // paymentFailure flag OFF
            getBooleanValue: async () => false, // emitRawPii OFF
          }),
        },
      };
    case '@openfeature/flagd-provider':
      return { FlagdProvider: class {} };
    case './logger':
      return { info: () => {}, warn: () => {} };
    default:
      return originalLoad.call(this, request, parent, isMain);
  }
};

const { charge } = require('./charge');

const card = {
  creditCardNumber: '4111111111111111',
  creditCardCvv: 123,
  creditCardExpirationYear: 2999,
  creditCardExpirationMonth: 12,
};

test('INC-023: valid fractional amount (nanos=699999995, from real trace 8c729752) must be charged', async () => {
  const result = await charge({
    creditCard: card,
    amount: { currencyCode: 'USD', units: 85, nanos: 699999995 },
  });
  assert.strictEqual(result.transactionId, 'repro-transaction-id');
});

test('control: whole-dollar amount (nanos=0) charges fine', async () => {
  const result = await charge({
    creditCard: card,
    amount: { currencyCode: 'USD', units: 10, nanos: 0 },
  });
  assert.strictEqual(result.transactionId, 'repro-transaction-id');
});
