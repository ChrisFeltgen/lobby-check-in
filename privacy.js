'use strict';

// What the public may see of the queue. The lobby monitor is a public page, so the data behind it is too: it
// shows each customer as a first name and last initial, and that is all the public data carries. The full
// names, and who a visitor is seeing and when, are for signed-in staff (see /api/staff/queue).

// "Jane Smith" becomes "Jane S.". A single name stays as given.
function publicName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || '';
  return parts[0] + ' ' + parts[parts.length - 1].charAt(0).toUpperCase() + '.';
}

// Only the fields the monitor draws. The staff member's name stays, because the monitor says who will be with you.
function publicTicket(t) {
  return {
    id: t.id,
    serviceCode: t.serviceCode,
    ticketNumber: t.ticketNumber,
    status: t.status,
    counter: t.counter,
    createdAt: t.createdAt,
    calledAt: t.calledAt,
    calledBy: t.calledBy || null,
    customerName: publicName(t.customerName),
  };
}

function publicQueue(snapshot) {
  return snapshot.map((svc) => ({ ...svc, waiting: svc.waiting.map(publicTicket), serving: svc.serving.map(publicTicket) }));
}

module.exports = { publicName, publicTicket, publicQueue };
