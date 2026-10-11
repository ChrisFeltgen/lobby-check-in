const test = require('node:test');
const assert = require('node:assert/strict');
const { publicName, publicTicket, publicQueue } = require('../privacy');

test('a customer is shown as first name and last initial', () => {
  assert.equal(publicName('Jane Smith'), 'Jane S.');
  assert.equal(publicName('  jane   van der berg '), 'jane B.');
  assert.equal(publicName('Cher'), 'Cher');
  assert.equal(publicName(''), '');
  assert.equal(publicName(null), '');
});

test('a name that is already shortened stays the same', () => {
  assert.equal(publicName(publicName('Jane Smith')), 'Jane S.');
});

test('a public ticket carries only what the monitor draws', () => {
  const t = publicTicket({
    id: 1, serviceCode: 'AC', customerName: 'Jane Smith', ticketNumber: 'AC-001', status: 'waiting', counter: null,
    createdAt: 'a', calledAt: null, completedAt: 'z', appointmentWith: 'Lee Chen', appointmentTime: '9:30 AM', calledBy: 'Sam',
  });
  assert.deepEqual(Object.keys(t).sort(), ['calledAt', 'calledBy', 'counter', 'createdAt', 'customerName', 'id', 'serviceCode', 'status', 'ticketNumber']);
  assert.equal(t.customerName, 'Jane S.');
});

test('the public queue keeps the services as they are and shortens every name in them', () => {
  const q = publicQueue([{ code: 'BPI', name: 'Permits', waiting: [{ customerName: 'A Bee' }], serving: [{ customerName: 'C Dee', calledBy: 'Sam' }] }]);
  assert.equal(q[0].code, 'BPI');
  assert.equal(q[0].waiting[0].customerName, 'A B.');
  assert.equal(q[0].serving[0].customerName, 'C D.');
});
